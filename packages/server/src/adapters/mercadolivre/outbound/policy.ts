/**
 * Pure outbound routing + policy for the Mercado Livre channel.
 *
 * `resolveRoute`/`validateOutbound` are contractually synchronous and
 * network-free (they run on every composer keystroke), so every decision here is
 * derived from the `OutboundValidationInput` alone.
 */

import {
  CHANNEL_ROUTE_LABEL,
  evaluateOutboundPolicy,
  type OutboundValidationInput,
  type PolicyEvaluation,
  type PolicyViolation,
  type RouteDecision,
} from '@sac/shared';
import { asString, isRecord, isSendMessageAction } from '../mappers';

/** Keys under which `available_actions` may be handed to the composer. */
const ACTION_KEYS = ['available_actions', 'claim_available_actions'] as const;

function readActionList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      names.push(entry);
      continue;
    }
    if (isRecord(entry)) {
      const action = asString(entry.action);
      if (action) names.push(action);
    }
  }
  return names;
}

function collectActionsFromRecord(
  record: Record<string, unknown> | undefined,
  collected: Set<string>,
): void {
  if (!record) return;
  for (const key of ACTION_KEYS) {
    const list = readActionList(record[key]);
    if (list) for (const action of list) collected.add(action);
  }
  const respondent = record.respondent;
  if (isRecord(respondent)) {
    const list = readActionList(respondent.available_actions);
    if (list) for (const action of list) collected.add(action);
  }
  const claim = record.claim;
  if (isRecord(claim)) {
    const list = readActionList(claim.available_actions);
    if (list) for (const action of list) collected.add(action);
  }
  const players = record.players;
  if (Array.isArray(players)) {
    for (const player of players) {
      if (!isRecord(player)) continue;
      if ((asString(player.role) ?? '').toLowerCase() !== 'respondent') continue;
      const list = readActionList(player.available_actions);
      if (list) for (const action of list) collected.add(action);
    }
  }
}

/**
 * Names of the seller's available actions, or `null` when the caller did not
 * provide action information (in which case we must not block the send).
 * An explicitly empty list is meaningful: the seller has no action available.
 */
export function resolveAvailableActionNames(input: OutboundValidationInput): string[] | null {
  const collected = new Set<string>();
  let sawList = false;
  const sources: Array<Record<string, unknown> | undefined> = [
    input.allowedActions,
    input.channelMetadata,
  ];
  for (const source of sources) {
    if (!source) continue;
    for (const key of ACTION_KEYS) {
      if (readActionList(source[key]) !== null) sawList = true;
    }
    if (isRecord(source.respondent) && readActionList(source.respondent.available_actions) !== null) {
      sawList = true;
    }
    if (isRecord(source.claim) && readActionList(source.claim.available_actions) !== null) {
      sawList = true;
    }
    collectActionsFromRecord(source, collected);
  }
  return sawList ? [...collected] : null;
}

function readClaimId(record: Record<string, unknown> | undefined): string | null {
  if (!record) return null;
  const direct =
    asString(record.claim_id) ??
    asString(record.claimId) ??
    asString(record.claimID);
  if (direct) return direct;
  if (isRecord(record.claim)) {
    const nested = asString(record.claim.id) ?? asString(record.claim.claim_id);
    if (nested) return nested;
  }
  const channelMetadata = record.channelMetadata ?? record.channel_metadata;
  if (isRecord(channelMetadata)) return readClaimId(channelMetadata);
  return null;
}

/** Claim id the composer may carry through `allowedActions`/`channelMetadata`. */
export function resolveClaimId(input: OutboundValidationInput): string | null {
  return readClaimId(input.allowedActions) ?? readClaimId(input.channelMetadata);
}

export function hasActionGuide(channelMetadata: Record<string, unknown> | undefined): boolean {
  return !!channelMetadata && isRecord(channelMetadata.action_guide);
}

function routeLabel(route: RouteDecision['route']): string {
  return CHANNEL_ROUTE_LABEL[route];
}

/**
 * MELI routing matrix:
 *  - PRE_SALE                     -> Questions API (`POST /answers`)
 *  - active claim / CLAIM_DISPUTE -> Claims API (the pack chat is blocked)
 *  - otherwise                    -> Messages API (post-sale pack)
 */
export function resolveMeliRoute(input: OutboundValidationInput): RouteDecision {
  const recipient = input.recipient;
  const requiresAttachmentUpload = input.attachments.length > 0;

  if (input.ticketType === 'PRE_SALE') {
    return {
      route: 'MELI_QUESTIONS_API',
      label: routeLabel('MELI_QUESTIONS_API'),
      reason: 'Pré-venda respondida pela Questions API (/answers)',
      recipient,
      requiresAttachmentUpload: false,
      blocked: false,
      actionName: 'answer_question',
    };
  }

  const claimContext = input.hasActiveClaim === true || input.ticketType === 'CLAIM_DISPUTE';
  if (claimContext) {
    const availableActions = resolveAvailableActionNames(input);
    const messageActionAvailable =
      availableActions === null
        ? true
        : availableActions.some((action) => isSendMessageAction(action));
    const blocked = recipient === 'BUYER' && !messageActionAvailable;
    return {
      route: 'MELI_CLAIMS_API',
      label: routeLabel('MELI_CLAIMS_API'),
      reason: 'Chat do pack bloqueado por reclamação ativa; usando Claims API',
      recipient,
      requiresAttachmentUpload,
      blocked,
      blockedReason: blocked
        ? 'Nenhuma ação de mensagem disponível para o comprador nesta reclamação'
        : undefined,
      actionName: 'send_message',
    };
  }

  return {
    route: 'MELI_MESSAGES_API',
    label: routeLabel('MELI_MESSAGES_API'),
    reason: 'Mensagem pós-venda no chat do pack',
    recipient,
    requiresAttachmentUpload,
    blocked: false,
    actionName: 'send_message',
  };
}

/**
 * Synchronous policy evaluation used by the composer and re-checked before send.
 * Merges the per-store allowed link domains the core may pass in.
 */
export function evaluateMeliOutbound(input: OutboundValidationInput): PolicyEvaluation {
  const routePreview = resolveMeliRoute(input);

  const policy = evaluateOutboundPolicy({
    text: input.bodyText,
    html: input.bodyHtml ?? null,
    subject: input.subject ?? null,
    marketplace: 'MERCADO_LIVRE',
    allowedLinkDomains: input.allowedLinkDomains,
  });

  const violations: PolicyViolation[] = [...policy.violations];
  const notes: string[] = [...policy.notes];

  if (input.hasActiveClaim) {
    violations.push({
      code: 'CLAIM_CHAT_BLOCKED',
      severity: 'WARN',
      field: 'body',
      message:
        'Reclamação ativa: o chat do pack está bloqueado pelo Mercado Livre; a mensagem será enviada pela Claims API.',
    });
  }

  if (!input.hasActiveClaim && hasActionGuide(input.channelMetadata)) {
    violations.push({
      code: 'CHAT_BLOCKED_ACTION_GUIDE',
      severity: 'WARN',
      field: 'body',
      message:
        'O chat do pack exige um motivo estruturado (action guide). Selecione o motivo antes de enviar.',
    });
    notes.push('Motivos estruturados disponíveis em channelMetadata.action_guide.');
  }

  if (routePreview.route === 'MELI_CLAIMS_API' && !resolveClaimId(input)) {
    violations.push({
      code: 'MISSING_CLAIM_ID',
      severity: 'BLOCK',
      field: 'body',
      message: 'Reclamação sem claim_id: não é possível responder pela Claims API.',
    });
  }

  if (routePreview.blocked && routePreview.blockedReason) {
    violations.push({
      code: 'CLAIM_ACTION_UNAVAILABLE',
      severity: 'BLOCK',
      field: 'body',
      message: routePreview.blockedReason,
    });
  }

  if (input.buyerOptOut) {
    notes.push('Pedido de opt-out do comprador detectado: evite mensagens promocionais.');
  }

  if (routePreview.requiresAttachmentUpload) {
    notes.push('Os anexos serão enviados antes da mensagem via upload multipart.');
  }

  return {
    violations,
    blocked: violations.some((violation) => violation.severity === 'BLOCK'),
    sanitizedText: policy.sanitizedText,
    sanitizedHtml: policy.sanitizedHtml,
    notes,
    routePreview,
  };
}
