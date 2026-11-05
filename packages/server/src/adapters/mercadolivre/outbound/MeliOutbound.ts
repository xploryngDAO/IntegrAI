import { randomUUID } from 'node:crypto';
import {
  MarketplaceApiError,
  PolicyViolationError,
  ValidationError,
  type AdapterDependencies,
  type ChannelActionRequest,
  type ChannelActionResult,
  type HttpRequestOptions,
  type ILogger,
  type OutboundAttachmentInput,
  type OutboundDraft,
  type OutboundResult,
  type OutboundValidationInput,
  type PolicyEvaluation,
  type RouteDecision,
  type TicketType,
} from '@sac/shared';
import { loadMeliAccount } from '../account';
import type { MeliClient } from '../client/MeliClient';
import {
  asString,
  errorMessage,
  extractAvailableActionNames,
  extractRespondentActions,
  extractResponseId,
  isRecord,
} from '../mappers';
import type {
  MeliAnswerResponse,
  MeliAttachmentUploadResponse,
  MeliClaim,
  MeliSendMessageResponse,
} from '../types';
import { evaluateMeliOutbound, resolveMeliRoute } from './policy';

interface DelegatedSendSpec {
  ticketType: TicketType;
  hasActiveClaim: boolean;
  externalReferenceId: string;
  claimId?: string | null;
  questionId?: string | null;
}

/** Official `actions/send-message` body (attachments are file-name strings). */
interface ClaimMessageBody {
  receiver_role: string;
  message: string;
  attachments: string[];
}

function buildFileFormData(fileName: string, mimeType: string, bytes: Buffer): FormData {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  form.append('file', blob, fileName);
  return form;
}

function payloadValue(
  payload: Record<string, unknown> | undefined,
  ...keys: string[]
): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return null;
}

function payloadBoolean(
  payload: Record<string, unknown> | undefined,
  ...keys: string[]
): boolean {
  if (!payload) return false;
  for (const key of keys) {
    if (payload[key] === true) return true;
  }
  return false;
}

/**
 * Outbound side of the Mercado Livre adapter: route A (Questions), route B
 * (Claims) and route C (post-sale pack messages), plus the structured claim
 * actions exposed by the cockpit.
 *
 * Policy is evaluated before any network call and is re-checked from the draft,
 * so a stale UI cannot bypass the guardrails. Buyer PII is never logged: only
 * marketplace ids and routing metadata are emitted.
 */
export class MeliOutbound {
  private readonly logger: ILogger;

  constructor(
    private readonly deps: AdapterDependencies,
    private readonly client: MeliClient,
  ) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre', component: 'outbound' });
  }

  /** 404/405 on a documented endpoint variant: try the other API base. */
  private isMissingEndpoint(error: unknown): boolean {
    return error instanceof MarketplaceApiError && (error.status === 404 || error.status === 405);
  }

  resolveRoute(input: OutboundValidationInput): RouteDecision {
    return resolveMeliRoute(input);
  }

  validateOutbound(input: OutboundValidationInput): PolicyEvaluation {
    return evaluateMeliOutbound(input);
  }

  async send(draft: OutboundDraft): Promise<OutboundResult> {
    const account = await loadMeliAccount(this.deps, draft.accountId);
    const evaluation = evaluateMeliOutbound(this.validationInputFromDraft(draft));
    if (evaluation.blocked) {
      const blocking = evaluation.violations
        .filter((violation) => violation.severity === 'BLOCK')
        .map((violation) => ({
          code: violation.code,
          message: violation.message,
          ...(violation.match !== undefined ? { match: violation.match } : {}),
        }));
      throw new PolicyViolationError(blocking, 'MERCADO_LIVRE');
    }

    switch (evaluation.routePreview.route) {
      case 'MELI_QUESTIONS_API':
        return this.sendAnswer(account.id, draft);
      case 'MELI_CLAIMS_API':
        return this.sendClaimMessage(account.id, draft);
      case 'MELI_MESSAGES_API':
        return this.sendPackMessage(account.id, account.externalSellerId, account.marketplaceSiteId, draft);
      default:
        throw new ValidationError(
          `Rota Mercado Livre não suportada: ${evaluation.routePreview.route}`,
        );
    }
  }

  async executeAction(request: ChannelActionRequest): Promise<ChannelActionResult> {
    const account = await loadMeliAccount(this.deps, request.accountId);
    const payload = isRecord(request.payload) ? request.payload : undefined;

    switch (request.kind) {
      case 'MELI_ALLOW_RETURN':
        return this.executeClaimAction(request, 'allow_return', account.id);
      case 'MELI_REFUND':
        return this.executeClaimAction(request, 'refund', account.id);
      case 'MELI_OPEN_DISPUTE':
        return this.executeClaimAction(request, 'open_dispute', account.id);
      case 'MELI_ANSWER_QUESTION': {
        const questionId =
          request.questionId ?? payloadValue(payload, 'question_id', 'questionId');
        if (!questionId) {
          return {
            action: request.kind,
            ok: false,
            message: 'question_id obrigatório para responder uma pergunta',
          };
        }
        return this.delegateSend(request, {
          ticketType: 'PRE_SALE',
          hasActiveClaim: false,
          externalReferenceId: questionId,
          questionId,
        });
      }
      case 'MELI_SEND_CLAIM_MESSAGE': {
        const claimId =
          request.claimId ?? payloadValue(payload, 'claim_id', 'claimId');
        if (!claimId) {
          return {
            action: request.kind,
            ok: false,
            message: 'claim_id obrigatório para responder uma reclamação',
          };
        }
        return this.delegateSend(request, {
          ticketType: 'CLAIM_DISPUTE',
          hasActiveClaim: true,
          externalReferenceId: claimId,
          claimId,
        });
      }
      case 'MELI_SEND_POST_SALE_MESSAGE': {
        const packId =
          request.packId ??
          payloadValue(payload, 'pack_id', 'packId') ??
          request.externalOrderId ??
          null;
        if (!packId) {
          return {
            action: request.kind,
            ok: false,
            message: 'pack_id obrigatório para enviar mensagem pós-venda',
          };
        }
        return this.delegateSend(request, {
          ticketType: 'POST_SALE_ORDER',
          hasActiveClaim: payloadBoolean(payload, 'has_active_claim', 'hasActiveClaim'),
          externalReferenceId: packId,
        });
      }
      default:
        return {
          action: request.kind,
          ok: false,
          message: `Ação ${request.kind} não suportada pelo adaptador Mercado Livre`,
        };
    }
  }

  /* ------------------------------ Route A --------------------------------- */

  private async sendAnswer(accountId: string, draft: OutboundDraft): Promise<OutboundResult> {
    const questionId = draft.questionId ?? draft.externalReferenceId;
    if (!questionId) {
      throw new ValidationError('question_id ausente para responder a pergunta Meli');
    }
    if (draft.attachments.length > 0) {
      this.logger.warn('meli.outbound.attachments_ignored_questions_route', {
        accountId,
        ticketId: draft.ticketId,
        questionId,
      });
    }

    const numericId = Number(questionId);
    const questionIdPayload =
      Number.isFinite(numericId) && String(numericId) === questionId ? numericId : questionId;
    const requestBody = { question_id: questionIdPayload, text: draft.bodyText };

    const response = await this.client.post<MeliAnswerResponse>(accountId, '/answers', requestBody);
    const answerId = asString(response.id) ?? `answer:${questionId}`;

    this.logger.info('meli.outbound.answer_sent', {
      accountId,
      ticketId: draft.ticketId,
      questionId,
    });

    return {
      routeUsed: 'MELI_QUESTIONS_API',
      externalMessageId: `a:${answerId}`,
      deliveryStatus: 'SENT',
      contentPayload: {
        route: 'MELI_QUESTIONS_API',
        question_id: questionId,
        request: requestBody,
        answer_id: answerId,
        answer_status: asString(response.status),
      },
      marketplaceCreatedAt: this.deps.clock.now(),
      attachments: [],
      rawResponse: response,
    };
  }

  /* ------------------------------ Route B --------------------------------- */

  private async sendClaimMessage(
    accountId: string,
    draft: OutboundDraft,
  ): Promise<OutboundResult> {
    const claimId = draft.claimId;
    if (!claimId) {
      throw new ValidationError('claim_id obrigatório para responder pela Claims API');
    }

    const attachmentIds: string[] = [];
    const uploaded: OutboundResult['attachments'] = [];
    for (const attachment of draft.attachments) {
      const uploadedAttachment = await this.uploadClaimAttachment(accountId, claimId, attachment);
      attachmentIds.push(uploadedAttachment.uploadId);
      uploaded.push(uploadedAttachment.result);
    }

    const receiverRole = draft.recipient === 'MEDIATOR' ? 'mediator' : 'complainant';
    // Official contract: `attachments` is an array of file names returned by the
    // claim attachments upload (`{ user_id, file_name }`), not objects.
    const requestBody: ClaimMessageBody = {
      receiver_role: receiverRole,
      message: draft.bodyText,
      attachments: attachmentIds,
    };

    const response = await this.postClaimMessage(accountId, claimId, requestBody);
    const externalMessageId = extractResponseId(response) ?? randomUUID();

    this.logger.info('meli.outbound.claim_message_sent', {
      accountId,
      ticketId: draft.ticketId,
      claimId,
      receiverRole,
      attachmentCount: attachmentIds.length,
    });

    return {
      routeUsed: 'MELI_CLAIMS_API',
      externalMessageId,
      deliveryStatus: 'SENT',
      contentPayload: {
        route: 'MELI_CLAIMS_API',
        claim_id: claimId,
        receiver_role: receiverRole,
        attachment_ids: attachmentIds,
        request: requestBody,
        response_id: externalMessageId,
      },
      marketplaceCreatedAt: this.deps.clock.now(),
      attachments: uploaded,
      rawResponse: response,
    };
  }

  /* ------------------------------ Route C --------------------------------- */

  private async sendPackMessage(
    accountId: string,
    sellerId: string,
    siteId: string,
    draft: OutboundDraft,
  ): Promise<OutboundResult> {
    const packId = draft.packId ?? draft.externalReferenceId;
    if (!packId) {
      throw new ValidationError('pack_id ausente para enviar mensagem pós-venda Meli');
    }

    const attachmentIds: string[] = [];
    const uploaded: OutboundResult['attachments'] = [];
    for (const attachment of draft.attachments) {
      const uploadedAttachment = await this.uploadAttachment(
        accountId,
        '/messages/attachments',
        { tag: 'post_sale', site_id: siteId },
        attachment,
      );
      attachmentIds.push(uploadedAttachment.uploadId);
      uploaded.push(uploadedAttachment.result);
    }

    const actionGuideReasonId = draft.meliActionGuideReasonId;
    const metadata = isRecord(draft.metadata) ? draft.metadata : {};
    const buyerId = asString(draft.buyerExternalId);
    let response: MeliSendMessageResponse;
    let requestBody: Record<string, unknown>;
    let path: string;

    if (actionGuideReasonId) {
      // Official reason-guide flow (Fulfillment/Cross-docking/Drop-off/Flex):
      // POST /messages/action_guide/packs/{packId}/option?tag=post_sale with
      // `option_id` + `template_id` (template options) or `text` (free text).
      path = `/messages/action_guide/packs/${packId}/option`;
      const templateId =
        asString(metadata.template_id) ??
        asString(metadata.templateId) ??
        asString(metadata.meliTemplateId);
      const vars = Array.isArray(metadata.vars) ? metadata.vars : undefined;
      requestBody = {
        option_id: actionGuideReasonId,
        ...(templateId ? { template_id: templateId } : {}),
        ...(vars ? { vars } : {}),
        // Free-text options (`OTHER`, `SEND_INVOICE_LINK`) carry the message;
        // template options must not receive free text.
        ...(!templateId && draft.bodyText.trim().length > 0 ? { text: draft.bodyText } : {}),
      };
      response = await this.client.post<MeliSendMessageResponse>(
        accountId,
        path,
        requestBody,
        { tag: 'post_sale' },
      );
    } else {
      // Official message body requires `from`/`to` user ids and file-name
      // strings for `attachments`.
      path = `/messages/packs/${packId}/sellers/${sellerId}`;
      requestBody = {
        from: { user_id: sellerId },
        ...(buyerId ? { to: { user_id: buyerId } } : {}),
        text: draft.bodyText,
        attachments: attachmentIds,
      };
      response = await this.client.post<MeliSendMessageResponse>(accountId, path, requestBody, {
        tag: 'post_sale',
      });
    }

    const externalMessageId = extractResponseId(response) ?? randomUUID();

    this.logger.info('meli.outbound.pack_message_sent', {
      accountId,
      ticketId: draft.ticketId,
      packId,
      actionGuide: Boolean(actionGuideReasonId),
      attachmentCount: attachmentIds.length,
    });

    return {
      routeUsed: 'MELI_MESSAGES_API',
      externalMessageId,
      deliveryStatus: 'SENT',
      contentPayload: {
        route: 'MELI_MESSAGES_API',
        pack_id: packId,
        seller_id: sellerId,
        endpoint: path,
        attachment_ids: attachmentIds,
        request: requestBody,
        response_id: externalMessageId,
      },
      marketplaceCreatedAt: this.deps.clock.now(),
      attachments: uploaded,
      rawResponse: response,
    };
  }

  /* --------------------------- Structured actions -------------------------- */

  private async executeClaimAction(
    request: ChannelActionRequest,
    actionName: 'allow_return' | 'refund' | 'open_dispute',
    accountId: string,
  ): Promise<ChannelActionResult> {
    const payload = isRecord(request.payload) ? request.payload : {};
    const claimId =
      request.claimId ??
      payloadValue(payload, 'claim_id', 'claimId');

    if (!claimId) {
      return {
        action: request.kind,
        ok: false,
        message: 'claim_id obrigatório para ações de reclamação',
        data: { claim_id: null },
      };
    }

    let claim: MeliClaim;
    try {
      claim = await this.client.get<MeliClaim>(
        accountId,
        `/post-purchase/v1/claims/${claimId}`,
      );
    } catch (error) {
      return {
        action: request.kind,
        ok: false,
        message: `Não foi possível carregar a reclamação ${claimId}`,
        data: { error: errorMessage(error) },
      };
    }

    const availableActions = extractRespondentActions(claim);
    const actionNames = extractAvailableActionNames(availableActions);
    if (!actionNames.includes(actionName)) {
      return {
        action: request.kind,
        ok: false,
        message: 'Ação indisponível para esta claim',
        data: { available_actions: availableActions },
      };
    }

    const body: Record<string, unknown> = { ...payload, claim_id: claimId };
    const slug = actionName.replace(/_/g, '-');
    // Official docs expose resolutions either as `actions/{action}`
    // (open-dispute) or `expected-resolutions/{resolution}` (refund/allow-return,
    // Global Selling `marketplace/v2`). Try the contract path first, then the
    // documented variants on a missing endpoint only.
    const variants: Array<{ path: string; includeClaimId: boolean }> =
      actionName === 'open_dispute'
        ? [
            { path: `/post-purchase/v1/claims/${claimId}/actions/open-dispute`, includeClaimId: true },
            { path: `/marketplace/v2/claims/${claimId}/actions/open-dispute`, includeClaimId: true },
          ]
        : [
            { path: `/post-purchase/v1/claims/${claimId}/actions/${slug}`, includeClaimId: true },
            {
              path: `/post-purchase/v1/claims/${claimId}/expected-resolutions/${slug}`,
              includeClaimId: false,
            },
            {
              path: `/marketplace/v2/claims/${claimId}/expected-resolutions/${slug}`,
              includeClaimId: false,
            },
          ];

    let response: unknown = null;
    let lastError: unknown = null;
    for (const variant of variants) {
      try {
        response = await this.client.post<unknown>(
          accountId,
          variant.path,
          variant.includeClaimId ? body : { ...payload },
        );
        break;
      } catch (error) {
        lastError = error;
        if (!this.isMissingEndpoint(error)) {
          return {
            action: request.kind,
            ok: false,
            message: `Falha ao executar ${actionName}: ${errorMessage(error)}`,
            routeUsed: 'MELI_CLAIMS_API',
            externalId: claimId,
            data: { error: errorMessage(error) },
          };
        }
      }
    }

    if (response === null) {
      return {
        action: request.kind,
        ok: false,
        message: `Falha ao executar ${actionName}: ${errorMessage(lastError)}`,
        routeUsed: 'MELI_CLAIMS_API',
        externalId: claimId,
        data: { error: errorMessage(lastError) },
      };
    }

    this.logger.info('meli.action.executed', {
      accountId,
      ticketId: request.ticketId,
      claimId,
      actionName,
    });
    return {
      action: request.kind,
      ok: true,
      message: `Ação ${actionName} executada na reclamação ${claimId}`,
      routeUsed: 'MELI_CLAIMS_API',
      externalId: claimId,
      data: { response },
    };
  }

  /* -------------------------------- Helpers -------------------------------- */

  private async delegateSend(
    request: ChannelActionRequest,
    spec: DelegatedSendSpec,
  ): Promise<ChannelActionResult> {
    const bodyText = request.bodyText?.trim() ?? '';
    if (!bodyText) {
      return { action: request.kind, ok: false, message: 'Mensagem vazia' };
    }
    const payload = isRecord(request.payload) ? request.payload : undefined;
    const recipient =
      (payloadValue(payload, 'recipient') ?? '').toUpperCase() === 'MEDIATOR'
        ? 'MEDIATOR'
        : 'BUYER';

    const draft: OutboundDraft = {
      ticketId: request.ticketId,
      outboxMessageId: null,
      accountId: request.accountId,
      marketplace: 'MERCADO_LIVRE',
      ticketType: spec.ticketType,
      hasActiveClaim: spec.hasActiveClaim,
      externalReferenceId: spec.externalReferenceId,
      externalOrderId: request.externalOrderId ?? null,
      packId: request.packId ?? null,
      claimId: spec.claimId ?? request.claimId ?? null,
      conversationId: request.conversationId ?? null,
      returnSn: request.returnSn ?? null,
      questionId: spec.questionId ?? request.questionId ?? null,
      buyerExternalId: null,
      buyerDisplayName: null,
      buyerAnonymizedEmail: null,
      recipient,
      subject: null,
      bodyText,
      bodyHtml: null,
      attachments: request.attachments ?? [],
      agent: request.agent ?? { id: 'system', name: 'SAC Hub', email: 'system@sac-hub.local' },
      metadata: request.payload,
    };

    const result = await this.send(draft);
    return {
      action: request.kind,
      ok: true,
      message: `Mensagem enviada via ${result.routeUsed}`,
      routeUsed: result.routeUsed,
      externalId: result.externalMessageId,
      data: result.contentPayload,
    };
  }

  /**
   * Uploads claim evidence. Claims return `{ user_id, file_name }` (not `id`),
   * so the file name is what the send-message body must reference. The Global
   * Selling CBT base (`marketplace/v2`) is tried when the endpoint is missing.
   */
  private async uploadClaimAttachment(
    accountId: string,
    claimId: string,
    attachment: OutboundAttachmentInput,
  ): Promise<{ uploadId: string; result: OutboundResult['attachments'][number] }> {
    const idKeys = ['file_name', 'filename', 'id'];
    try {
      return await this.uploadAttachment(
        accountId,
        `/post-purchase/v1/claims/${claimId}/attachments`,
        undefined,
        attachment,
        idKeys,
      );
    } catch (error) {
      if (!this.isMissingEndpoint(error)) throw error;
      return this.uploadAttachment(
        accountId,
        `/marketplace/v2/claims/${claimId}/attachments`,
        undefined,
        attachment,
        idKeys,
      );
    }
  }

  /**
   * Sends a claim message through the documented variants, tolerating the
   * `post-purchase/v1` vs `marketplace/v2` (CBT) coexistence:
   * 1. `post-purchase/v1 .../actions/send-message` (contract path)
   * 2. `marketplace/v2 .../actions/send-message` (Global Selling docs)
   * 3. `post-purchase/v1 .../messages` (legacy docs, no attachments only)
   */
  private async postClaimMessage(
    accountId: string,
    claimId: string,
    body: ClaimMessageBody,
  ): Promise<MeliSendMessageResponse> {
    const variants = [
      `/post-purchase/v1/claims/${claimId}/actions/send-message`,
      `/marketplace/v2/claims/${claimId}/actions/send-message`,
    ];
    let lastError: unknown = null;
    for (const path of variants) {
      try {
        return await this.client.post<MeliSendMessageResponse>(accountId, path, body);
      } catch (error) {
        lastError = error;
        if (!this.isMissingEndpoint(error)) throw error;
      }
    }
    if (body.attachments.length === 0) {
      try {
        return await this.client.post<MeliSendMessageResponse>(
          accountId,
          `/post-purchase/v1/claims/${claimId}/messages`,
          { receiver_role: body.receiver_role, message: body.message },
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new MarketplaceApiError('MERCADO_LIVRE', 502, 'Falha ao enviar mensagem da claim', body, true);
  }

  private async uploadAttachment(
    accountId: string,
    path: string,
    query: HttpRequestOptions['query'],
    attachment: OutboundAttachmentInput,
    idKeys: string[] = ['id', 'filename'],
  ): Promise<{ uploadId: string; result: OutboundResult['attachments'][number] }> {
    const bytes = await this.readAttachment(attachment);
    const form = buildFileFormData(attachment.fileName, attachment.mimeType, bytes);
    const response = await this.client.postMultipart<MeliAttachmentUploadResponse>(
      accountId,
      path,
      form,
      query,
    );
    const uploadId = idKeys
      .map((key) => asString(response[key]))
      .find((value): value is string => value !== null) ?? null;
    if (!uploadId) {
      throw new MarketplaceApiError(
        'MERCADO_LIVRE',
        502,
        'Upload de anexo não retornou id',
        response,
        true,
      );
    }
    this.logger.info('meli.outbound.attachment_uploaded', {
      accountId,
      path,
      uploadId,
      sizeBytes: attachment.sizeBytes,
    });
    return {
      uploadId,
      result: {
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        s3Uri: this.deps.storage.buildUri(attachment.s3Key),
        externalUploadId: uploadId,
      },
    };
  }

  private async readAttachment(attachment: OutboundAttachmentInput): Promise<Buffer> {
    if (attachment.contentBase64) {
      const buffer = Buffer.from(attachment.contentBase64, 'base64');
      if (buffer.length > 0) return buffer;
    }
    return this.deps.storage.getObject(attachment.s3Key);
  }

  private validationInputFromDraft(draft: OutboundDraft): OutboundValidationInput {
    const allowedActions: Record<string, unknown> = {};
    if (draft.claimId) allowedActions.claim_id = draft.claimId;
    const metadata = isRecord(draft.metadata) ? draft.metadata : undefined;
    if (metadata && metadata.available_actions !== undefined) {
      allowedActions.available_actions = metadata.available_actions;
    }
    return {
      marketplace: 'MERCADO_LIVRE',
      ticketType: draft.ticketType,
      hasActiveClaim: draft.hasActiveClaim,
      bodyText: draft.bodyText,
      bodyHtml: draft.bodyHtml ?? null,
      subject: draft.subject ?? null,
      recipient: draft.recipient,
      attachments: draft.attachments,
      forceImportant: draft.forceImportant ?? false,
      hasPriorInbound: true,
      allowedActions,
      accountId: draft.accountId,
      channelMetadata: metadata,
    };
  }
}