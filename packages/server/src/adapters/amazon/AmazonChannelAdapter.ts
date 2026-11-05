import {
  MarketplaceApiError,
  NotFoundError,
  PolicyViolationError,
  ValidationError,
  redactPiiForLogs,
  type AdapterDependencies,
  type BuyerPiiSnapshot,
  type ChannelActionRequest,
  type ChannelActionResult,
  type DiagnosisCheck,
  type HydratedInboundMessage,
  type IMarketplaceChannelAdapter,
  type InboundEnvelope,
  type ILogger,
  type Marketplace,
  type MarketplaceAccountRecord,
  type NormalizedOrderSnapshot,
  type OutboundDraft,
  type OutboundResult,
  type OutboundValidationInput,
  type PolicyEvaluation,
  type RawWebhookRequest,
  type RouteDecision,
  type SupportTicketRecord,
  type WebhookVerification,
} from '@sac/shared';
import { asRecord, readString } from './guards';
import { parseChannelSettings } from './mappers';
import type { AmazonAccountSettings } from './types';
import { LwaAuth } from './client/LwaAuth';
import { RdtService } from './client/RdtService';
import { SpApiClient } from './client/SpApiClient';
import { OrderEnrichmentService } from './client/OrderEnrichment';
import { SesRelayParser } from './inbound/SesRelayParser';
import { EmailRelaySender } from './outbound/EmailRelaySender';
import { AMAZON_MESSAGING_ACTION_SPECS, SpApiMessaging } from './outbound/SpApiMessaging';
import { runAmazonDiagnosis } from './diagnose';
import {
  ACTION_KIND_TO_PROACTIVE_ACTION,
  decideAmazonRoute,
  isAmazonProactiveAction,
  readAllowedActionNames,
} from './outbound/routeDecision';
import {
  blockingViolations,
  buildAmazonPolicyEvaluation,
  evaluateAmazonPolicy,
} from './outbound/sanitizer';

const AMAZON_ACCOUNT_SCOPE = 'AMAZON' as const;

/**
 * Amazon channel adapter: SES inbound relay + LWA/RDT + SP-API messaging.
 *
 * Compliance posture:
 * - every SP-API call authorised by LWA (or RDT for restricted data) and
 *   rate-limited through `deps.rateLimiter`;
 * - buyer restricted data is fetched with an RDT, mirrored to
 *   `buyer_pii_vault` (expiring) and short-lived Redis — never to tickets/logs;
 * - outbound is routed by policy: SMTP relay only for receptive replies,
 *   proactive messages only through an Amazon-allowed SP-API action;
 * - silent close is an action (`AMAZON_NO_RESPONSE_NEEDED`), never a send.
 */
export class AmazonChannelAdapter implements IMarketplaceChannelAdapter {
  readonly marketplace: Marketplace = AMAZON_ACCOUNT_SCOPE;

  private readonly deps: AdapterDependencies;
  private readonly logger: ILogger;
  private readonly lwa: LwaAuth;
  private readonly rdt: RdtService;
  private readonly spApi: SpApiClient;
  private readonly enrichment: OrderEnrichmentService;
  private readonly parser: SesRelayParser;
  private readonly relaySender: EmailRelaySender;
  private readonly messaging: SpApiMessaging;

  /** Approved sender domains cached per account (fallback for the sync validator). */
  private readonly approvedDomainsByAccount = new Map<string, string[]>();
  private readonly approvedDomainsFallback = new Set<string>();

  constructor(deps: AdapterDependencies) {
    this.deps = deps;
    this.logger = deps.logger.child({ component: 'adapter.amazon' });
    this.lwa = new LwaAuth(deps);
    this.rdt = new RdtService(deps, this.lwa);
    this.spApi = new SpApiClient(deps, this.lwa, this.rdt);
    this.enrichment = new OrderEnrichmentService(deps, this.spApi);
    this.parser = new SesRelayParser(deps, this.enrichment, (account) => {
      this.rememberAccount(account);
    });
    this.relaySender = new EmailRelaySender(deps);
    this.messaging = new SpApiMessaging(deps, this.spApi);
  }

  /* ======================================================================
   * Inbound
   * ==================================================================== */

  async verifyInbound(request: RawWebhookRequest): Promise<WebhookVerification> {
    return this.parser.verify(request);
  }

  async hydrate(envelope: InboundEnvelope): Promise<HydratedInboundMessage[]> {
    return this.parser.hydrate(envelope);
  }

  /* ======================================================================
   * Enrichment
   * ==================================================================== */

  async enrichOrder(input: {
    accountId: string;
    externalOrderId: string;
    ticketId: string;
  }): Promise<{ order: NormalizedOrderSnapshot; buyerPii?: BuyerPiiSnapshot | null } | null> {
    const account = await this.requireAccount(input.accountId);
    this.rememberAccount(account);

    const ticket = await this.deps.repos.tickets.findById(input.ticketId);
    const buyerAnonymizedEmail = ticket?.buyerAnonymizedEmail ?? null;

    try {
      const bundle = await this.enrichment.fetchOrderBundle(
        account,
        input.externalOrderId,
        buyerAnonymizedEmail,
      );
      await this.enrichment.upsertOrder(account.id, bundle.order);
      if (bundle.buyerPii) {
        await this.enrichment.persistPii(input.ticketId, bundle.buyerPii);
      }
      if (bundle.warnings.length > 0) {
        this.logger.warn('amazon.enrich.degraded', {
          ticketId: input.ticketId,
          orderId: input.externalOrderId,
          warnings: bundle.warnings,
        });
      }
      return { order: bundle.order, buyerPii: bundle.buyerPii };
    } catch (error) {
      if (error instanceof MarketplaceApiError && error.status === 404) {
        this.logger.info('amazon.enrich.not_found', {
          ticketId: input.ticketId,
          orderId: input.externalOrderId,
        });
        return null;
      }
      throw error;
    }
  }

  /* ======================================================================
   * Live diagnostics
   * ==================================================================== */

  /**
   * Real credential/connectivity probe used by the cockpit diagnostics and by
   * `npm run doctor`. Performs live LWA + Sellers (and optionally RDT) calls and
   * never simulates success and never performs marketplace writes.
   */
  async diagnose(input: { accountId: string }): Promise<DiagnosisCheck[]> {
    return runAmazonDiagnosis(this.deps, input.accountId);
  }

  /* ======================================================================
   * Outbound
   * ==================================================================== */

  resolveRoute(input: OutboundValidationInput): RouteDecision {
    return decideAmazonRoute(input);
  }

  validateOutbound(input: OutboundValidationInput): PolicyEvaluation {
    return buildAmazonPolicyEvaluation(input, this.collectExtraAllowedDomains(input));
  }

  async send(draft: OutboundDraft): Promise<OutboundResult> {
    if (draft.marketplace !== 'AMAZON') {
      throw new ValidationError('AmazonChannelAdapter.send recebeu draft de outro marketplace.', {
        marketplace: draft.marketplace,
      });
    }
    if (draft.closeWithoutResponse) {
      throw new ValidationError(
        'Encerramento silencioso deve ser executado via executeAction(AMAZON_NO_RESPONSE_NEEDED), não via send().',
        { ticketId: draft.ticketId },
      );
    }
    if (draft.recipient === 'MEDIATOR') {
      throw new ValidationError('Amazon não possui mediação por mediador; destinatário deve ser BUYER.', {
        ticketId: draft.ticketId,
      });
    }

    const account = await this.requireAccount(draft.accountId);
    const settings = this.rememberAccount(account);
    const effectiveDraft = await this.withBuyerEmailFromTicket(draft);

    const priorInbound = await this.deps.repos.messages.lastByDirection(
      effectiveDraft.ticketId,
      'INBOUND_BUYER',
    );
    const allowedActions = await this.resolveAllowedActionsForDraft(effectiveDraft, account);

    const validationInput: OutboundValidationInput = {
      marketplace: 'AMAZON',
      ticketType: effectiveDraft.ticketType,
      hasActiveClaim: effectiveDraft.hasActiveClaim,
      bodyText: effectiveDraft.bodyText,
      bodyHtml: effectiveDraft.bodyHtml ?? null,
      subject: effectiveDraft.subject ?? null,
      recipient: effectiveDraft.recipient,
      attachments: effectiveDraft.attachments,
      forceImportant: effectiveDraft.forceImportant,
      hasPriorInbound: priorInbound !== null,
      allowedActions,
      closeWithoutResponse: false,
      accountId: account.id,
      smtpSenderEmail: effectiveDraft.smtpSenderEmail ?? settings.smtpSenderEmail,
    };

    const evaluation = this.validateOutbound(validationInput);
    if (evaluation.blocked) {
      throw new PolicyViolationError(blockingViolations(evaluation), 'AMAZON');
    }

    const route = evaluation.routePreview;
    if (route.route === 'AMAZON_EMAIL_RELAY') {
      return this.relaySender.send(effectiveDraft, settings, {
        text: evaluation.sanitizedText,
        html: evaluation.sanitizedHtml,
      });
    }
    if (route.route === 'AMAZON_SP_API_MESSAGING') {
      if (!route.actionName) {
        throw new ValidationError(
          route.blockedReason ?? 'Nenhuma ação proativa de mensagem disponível para este pedido.',
          { ticketId: effectiveDraft.ticketId, orderId: effectiveDraft.externalOrderId ?? null },
        );
      }
      if (!isAmazonProactiveAction(route.actionName)) {
        throw new ValidationError(
          `Ação de mensageria "${route.actionName}" não é uma ação proativa Amazon permitida.`,
          { actionName: route.actionName },
        );
      }
      return this.messaging.send(effectiveDraft, account, route.actionName, {
        text: evaluation.sanitizedText,
      });
    }

    throw new ValidationError(`Rota Amazon não suportada: ${route.route}`);
  }

  async executeAction(request: ChannelActionRequest): Promise<ChannelActionResult> {
    if (request.marketplace !== 'AMAZON') {
      throw new ValidationError('AmazonChannelAdapter.executeAction recebeu request de outro marketplace.', {
        marketplace: request.marketplace,
      });
    }
    const ticket = await this.deps.repos.tickets.findById(request.ticketId);
    if (!ticket) throw new NotFoundError('SupportTicket', request.ticketId);
    const account = await this.requireAccount(request.accountId);
    this.rememberAccount(account);

    switch (request.kind) {
      case 'AMAZON_NO_RESPONSE_NEEDED':
        return this.executeSilentClose(ticket);
      case 'AMAZON_CONFIRM_DELIVERY_DETAILS':
      case 'AMAZON_UNEXPECTED_PROBLEM':
      case 'AMAZON_WARRANTY':
      case 'AMAZON_CONFIRM_CUSTOMIZATION':
        return this.executeProactiveAction(ticket, account, request);
      default:
        return {
          action: request.kind,
          ok: false,
          message: `Ação ${request.kind} não é suportada pelo adaptador Amazon.`,
        };
    }
  }

  async runMaintenance(): Promise<Array<{ task: string; ok: boolean; detail: string }>> {
    const tasks: Array<{ task: string; ok: boolean; detail: string }> = [];
    let accounts: MarketplaceAccountRecord[] = [];
    try {
      accounts = await this.deps.repos.accounts.list({ marketplace: 'AMAZON' });
    } catch (error) {
      const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro desconhecido';
      return [{ task: 'amazon:lwa:warm', ok: false, detail: `Falha ao listar contas Amazon: ${message}` }];
    }
    if (accounts.length === 0) {
      return [
        { task: 'amazon:lwa:warm', ok: true, detail: 'Nenhuma conta Amazon conectada.' },
      ];
    }
    for (const account of accounts) {
      const task = `amazon:lwa:${account.id}`;
      if (account.status === 'DISCONNECTED') {
        tasks.push({ task, ok: false, detail: 'Conta desconectada — ignorada.' });
        continue;
      }
      try {
        this.rememberAccount(account);
        await this.lwa.warm(account);
        tasks.push({
          task,
          ok: true,
          detail: 'Token LWA aquecido/renovado com sucesso.',
        });
      } catch (error) {
        const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro desconhecido';
        tasks.push({ task, ok: false, detail: message });
      }
    }
    return tasks;
  }

  /* ======================================================================
   * Internals
   * ==================================================================== */

  private async executeSilentClose(ticket: SupportTicketRecord): Promise<ChannelActionResult> {
    const metadata = asRecord(ticket.channelMetadata);
    const link = readString(metadata.no_response_link);
    let linkCalled = false;
    let detail = 'Ticket sem link de no-response; encerramento silencioso registrado.';

    if (link) {
      try {
        await this.deps.http.request({
          method: 'GET',
          url: link,
          timeoutMs: 10_000,
          retries: 0,
        });
        linkCalled = true;
        detail = 'Link de no-response do Seller Central acionado com sucesso.';
      } catch (error) {
        const message = error instanceof Error ? redactPiiForLogs(error.message) : 'erro desconhecido';
        this.logger.warn('amazon.action.no_response_link_failed', {
          ticketId: ticket.id,
          error: message,
        });
        detail = 'Falha ao acionar o link de no-response (best effort); encerramento silencioso registrado.';
      }
    }

    return {
      action: 'AMAZON_NO_RESPONSE_NEEDED',
      ok: true,
      message: detail,
      routeUsed: 'AMAZON_EMAIL_RELAY',
      externalId: null,
      data: { linkCalled, noResponseNeededUrl: link, status: 'NO_RESPONSE_NEEDED' },
    };
  }

  private async executeProactiveAction(
    ticket: SupportTicketRecord,
    account: MarketplaceAccountRecord,
    request: ChannelActionRequest,
  ): Promise<ChannelActionResult> {
    const orderId = request.externalOrderId ?? ticket.externalOrderId;
    if (!orderId) {
      return {
        action: request.kind,
        ok: false,
        message: 'Ação proativa Amazon exige o order id do pedido.',
        data: { ticketId: ticket.id },
      };
    }

    const explicitAction =
      request.actionName && isAmazonProactiveAction(request.actionName) ? request.actionName : null;
    const actionName = explicitAction ?? ACTION_KIND_TO_PROACTIVE_ACTION[request.kind] ?? null;
    if (!actionName) {
      return {
        action: request.kind,
        ok: false,
        message: `Não existe ação proativa SP-API mapeada para ${request.kind}.`,
      };
    }

    const spec = AMAZON_MESSAGING_ACTION_SPECS[actionName];
    const bodyText = (request.bodyText ?? '').trim();
    const metadata = asRecord(request.payload);
    const attachments = request.attachments ?? [];
    const coverageStart =
      readString(metadata.coverageStartDate) ?? readString(metadata.coverage_start_date);
    const coverageEnd =
      readString(metadata.coverageEndDate) ?? readString(metadata.coverage_end_date);

    if (spec.supportsText && bodyText.length === 0) {
      return {
        action: request.kind,
        ok: false,
        message: `O texto da mensagem é obrigatório para a ação "${actionName}".`,
        data: { actionName },
      };
    }
    if (!spec.supportsText && bodyText.length > 0) {
      return {
        action: request.kind,
        ok: false,
        message: `A ação "${actionName}" do SP-API não aceita texto livre (apenas anexos e datas de cobertura). Remova o texto ou use outra ação proativa.`,
        data: { actionName },
      };
    }
    if (actionName === 'warranty' && attachments.length === 0 && !coverageStart && !coverageEnd) {
      return {
        action: request.kind,
        ok: false,
        message:
          'A ação "warranty" exige ao menos um anexo ou datas de cobertura (coverageStartDate/coverageEndDate) no payload.',
        data: { actionName },
      };
    }

    const allowedActions = await this.enrichment.loadAllowedActions(account, orderId, {
      strict: false,
    });
    if (allowedActions.length > 0 && !allowedActions.includes(actionName)) {
      return {
        action: request.kind,
        ok: false,
        message: `O Amazon não permite a ação "${actionName}" para este pedido.`,
        data: { requestedAction: actionName, availableActions: allowedActions },
      };
    }

    let sanitizedText = bodyText;
    if (bodyText.length > 0) {
      const policy = evaluateAmazonPolicy({
        text: bodyText,
        extraAllowedDomains: this.allowedDomainsForAccount(account.id),
      });
      if (policy.blocked) {
        throw new PolicyViolationError(
          policy.violations
            .filter((violation) => violation.severity === 'BLOCK')
            .map((violation) => ({
              code: violation.code,
              message: violation.message,
              ...(violation.match ? { match: violation.match } : {}),
            })),
          'AMAZON',
        );
      }
      sanitizedText = policy.sanitizedText;
    }

    const draft: OutboundDraft = {
      ticketId: ticket.id,
      accountId: account.id,
      marketplace: 'AMAZON',
      ticketType: ticket.ticketType,
      hasActiveClaim: ticket.hasActiveClaim,
      externalReferenceId: ticket.externalReferenceId,
      externalOrderId: orderId,
      recipient: 'BUYER',
      bodyText: sanitizedText,
      bodyHtml: null,
      subject: null,
      attachments,
      agent: request.agent ?? { id: 'system', name: 'SAC Hub', email: 'no-reply@sac.local' },
      metadata,
    };

    let result: OutboundResult;
    try {
      result = await this.messaging.send(draft, account, actionName, {
        text: sanitizedText,
        metadata,
      });
    } catch (error) {
      // Request-shape violations (text/attachment limits from the official
      // Messaging API model) are surfaced to the cockpit instead of a 500.
      if (error instanceof ValidationError) {
        return {
          action: request.kind,
          ok: false,
          message: error.message,
          data: error.details ?? { actionName },
        };
      }
      throw error;
    }

    return {
      action: request.kind,
      ok: true,
      message:
        actionName === 'warranty'
          ? 'Informações de garantia enviadas via SP-API (anexos/datas de cobertura; a ação não aceita texto livre).'
          : `Mensagem proativa "${actionName}" enviada via SP-API.`,
      routeUsed: result.routeUsed,
      externalId: result.externalMessageId,
      data: {
        actionName,
        uploadDestinationIds: result.contentPayload.uploadDestinationIds ?? [],
      },
    };
  }

  private async requireAccount(accountId: string): Promise<MarketplaceAccountRecord> {
    const account = await this.deps.repos.accounts.findById(accountId);
    if (!account || account.marketplace !== 'AMAZON') {
      throw new NotFoundError('AmazonAccount', accountId);
    }
    return account;
  }

  private rememberAccount(account: MarketplaceAccountRecord): AmazonAccountSettings {
    const settings = parseChannelSettings(account.channelConfig);
    this.approvedDomainsByAccount.set(account.id, [...settings.approvedSenderDomains]);
    for (const domain of settings.approvedSenderDomains) this.approvedDomainsFallback.add(domain);
    return settings;
  }

  private allowedDomainsForAccount(accountId: string): string[] {
    const domains = new Set<string>();
    for (const domain of this.approvedDomainsByAccount.get(accountId) ?? []) {
      domains.add(domain);
    }
    for (const domain of this.deps.config.amazon.emailDomainAllowlist ?? []) {
      domains.add(domain.trim().toLowerCase());
    }
    return [...domains].filter((domain) => domain.length > 0);
  }

  private collectExtraAllowedDomains(input: OutboundValidationInput): string[] {
    const domains = new Set<string>();
    const accountId = input.accountId;
    const cached = accountId ? this.approvedDomainsByAccount.get(accountId) : undefined;
    if (input.allowedLinkDomains && input.allowedLinkDomains.length > 0) {
      for (const domain of input.allowedLinkDomains) {
        domains.add(domain.trim().toLowerCase());
      }
    } else if (cached) {
      for (const domain of cached) domains.add(domain);
    } else {
      // Sync validator without account context: fall back to every domain seen
      // by this adapter instance (additive allowlist, never a blocker).
      for (const domain of this.approvedDomainsFallback) domains.add(domain);
    }
    for (const domain of this.deps.config.amazon.emailDomainAllowlist ?? []) {
      domains.add(domain.trim().toLowerCase());
    }
    return [...domains].filter((domain) => domain.length > 0);
  }

  /**
   * `send()` recomputes the routing server-side: the draft may not carry the
   * buyer anonymized e-mail (relay destination) that the ticket already has.
   */
  private async withBuyerEmailFromTicket(draft: OutboundDraft): Promise<OutboundDraft> {
    if (draft.buyerAnonymizedEmail) return draft;
    const ticket = await this.deps.repos.tickets.findById(draft.ticketId);
    const buyerAnonymizedEmail = ticket?.buyerAnonymizedEmail ?? null;
    if (!buyerAnonymizedEmail) return draft;
    return { ...draft, buyerAnonymizedEmail };
  }

  private async resolveAllowedActionsForDraft(
    draft: OutboundDraft,
    account: MarketplaceAccountRecord,
  ): Promise<Record<string, unknown>> {
    const metadata = asRecord(draft.metadata);
    const fromMetadata = readAllowedActionNames(metadata.allowedActions);
    if (fromMetadata.length > 0) return { actions: fromMetadata };
    if (!draft.externalOrderId) return { actions: [] };
    const actions = await this.enrichment.loadAllowedActions(account, draft.externalOrderId, {
      strict: true,
    });
    return { actions };
  }
}
