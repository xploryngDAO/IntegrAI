import { AMAZON_PROACTIVE_ACTIONS, CHANNEL_ROUTE_LABEL } from '@sac/shared';
import type {
  AmazonProactiveAction,
  ChannelActionKind,
  OutboundValidationInput,
  RouteDecision,
} from '@sac/shared';
import { asRecord, isRecord, readString } from '../guards';

/**
 * Pure Amazon outbound routing decisions.
 *
 * Amazon forbids proactive contact with buyers who never messaged us, so the
 * only lawful routes are:
 *  1. SMTP Buyer-Seller relay reply (there is a prior INBOUND_BUYER message);
 *  2. SP-API proactive messaging using an action the order explicitly allows;
 *  3. silent close (`AMAZON_NO_RESPONSE_NEEDED`) — not a send.
 *
 * Action capability follows the official Messaging API v1 model:
 * text-only `confirmDeliveryDetails`/`unexpectedProblem`; text+attachments
 * `confirmCustomizationDetails`; attachments+coverage dates `warranty` (no text).
 */

/** Contract preference order (kept for documentation/telemetry). */
export const AMAZON_PROACTIVE_ACTION_PREFERENCE: readonly AmazonProactiveAction[] = [
  'confirmDeliveryDetails',
  'unexpectedProblem',
  'warranty',
  'confirmCustomizationDetails',
];

/** Preference among text-capable proactive actions (no attachments). */
export const AMAZON_TEXT_ACTION_PREFERENCE: readonly AmazonProactiveAction[] = [
  'confirmDeliveryDetails',
  'unexpectedProblem',
  'confirmCustomizationDetails',
];

/** Preference among attachment-capable proactive actions. */
export const AMAZON_ATTACHMENT_ACTION_PREFERENCE: readonly AmazonProactiveAction[] = [
  'confirmCustomizationDetails',
  'warranty',
];

/** Cockpit action -> SP-API `actionName`. */
export const ACTION_KIND_TO_PROACTIVE_ACTION: Partial<Record<ChannelActionKind, AmazonProactiveAction>> =
  {
    AMAZON_CONFIRM_DELIVERY_DETAILS: 'confirmDeliveryDetails',
    AMAZON_UNEXPECTED_PROBLEM: 'unexpectedProblem',
    AMAZON_WARRANTY: 'warranty',
    AMAZON_CONFIRM_CUSTOMIZATION: 'confirmCustomizationDetails',
  };

export function isAmazonProactiveAction(value: string): value is AmazonProactiveAction {
  return (AMAZON_PROACTIVE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Reads action names from every shape the platform hands us:
 * `['warranty']`, `{ actions: ['warranty'] }`, `{ actions: [{ actionName }] }`,
 * HAL `{ actions: [{ name, href }] }`, `{ payload: { name } }`,
 * `{ allowedActions: [...] }`, `{ actionNames: [...] }`.
 */
export function readAllowedActionNames(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  const source = Array.isArray(value)
    ? value
    : isRecord(value)
      ? (value.actions ?? value.allowedActions ?? value.actionNames ?? value.allowed_actions)
      : undefined;
  if (!Array.isArray(source)) return [];
  const names: string[] = [];
  for (const entry of source) {
    const name = readActionName(entry);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function readActionName(entry: unknown): string | null {
  if (typeof entry === 'string') return readString(entry);
  if (!isRecord(entry)) return null;
  const payload = asRecord(entry.payload);
  return (
    readString(payload.name) ??
    readString(entry.actionName) ??
    readString(entry.name)
  );
}

/**
 * First allowed proactive action compatible with the draft:
 * - with attachments, only attachment-capable actions are considered;
 * - without attachments, only text-capable actions are considered.
 */
export function chooseProactiveAction(
  allowedActions: unknown,
  options?: { hasAttachments?: boolean },
): AmazonProactiveAction | null {
  const allowed = new Set(readAllowedActionNames(allowedActions));
  const candidates = options?.hasAttachments
    ? AMAZON_ATTACHMENT_ACTION_PREFERENCE
    : AMAZON_TEXT_ACTION_PREFERENCE;
  for (const candidate of candidates) {
    if (allowed.has(candidate)) return candidate;
  }
  return null;
}

const LABEL: Record<'relay' | 'spapi', string> = {
  relay: CHANNEL_ROUTE_LABEL.AMAZON_EMAIL_RELAY,
  spapi: CHANNEL_ROUTE_LABEL.AMAZON_SP_API_MESSAGING,
};

export function decideAmazonRoute(input: OutboundValidationInput): RouteDecision {
  const recipient = input.recipient;

  // 1. Silent close: not a send, executed through executeAction().
  if (input.closeWithoutResponse) {
    return {
      route: 'AMAZON_EMAIL_RELAY',
      label: LABEL.relay,
      reason: 'silent-close',
      recipient,
      requiresAttachmentUpload: false,
      blocked: false,
      actionName: 'AMAZON_NO_RESPONSE_NEEDED',
    };
  }

  // 2. Receptive reply: the buyer wrote to us first -> SMTP relay is allowed.
  if (input.hasPriorInbound) {
    return {
      route: 'AMAZON_EMAIL_RELAY',
      label: LABEL.relay,
      reason: 'receptive-reply',
      recipient,
      requiresAttachmentUpload: false,
      blocked: false,
      actionName: null,
    };
  }

  // 3. Proactive: only through an action the order explicitly allows.
  const hasAttachments = input.attachments.length > 0;
  const hasText = (input.bodyText ?? '').trim().length > 0;
  const allowedNames = readAllowedActionNames(input.allowedActions);
  const actionName = chooseProactiveAction(input.allowedActions, { hasAttachments });

  if (!actionName) {
    const allowedList = allowedNames.length > 0 ? allowedNames.join(', ') : 'nenhuma';
    const blockedReason =
      allowedNames.length === 0
        ? 'O Amazon não retornou ações proativas de mensagem para este pedido e não há mensagem prévia do comprador; o contato proativo por e-mail é proibido pelo Buyer-Seller Messaging Policy.'
        : hasAttachments
          ? `O pedido permite apenas: ${allowedList}. Nenhuma delas aceita anexos no SP-API; remova os anexos ou aguarde uma mensagem do comprador para responder pelo relay.`
          : `O pedido permite apenas: ${allowedList}. Nenhuma delas aceita texto livre no SP-API; use a ação estruturada correspondente no cockpit.`;
    return {
      route: 'AMAZON_SP_API_MESSAGING',
      label: LABEL.spapi,
      reason:
        allowedNames.length === 0
          ? 'need-prior-inbound'
          : hasAttachments
            ? 'proactive-action-attachments-unsupported'
            : 'proactive-action-text-unsupported',
      recipient,
      requiresAttachmentUpload: hasAttachments,
      blocked: true,
      blockedReason,
      actionName: null,
    };
  }

  // `warranty` has no text field in the official Messaging API model.
  if (actionName === 'warranty' && hasText) {
    return {
      route: 'AMAZON_SP_API_MESSAGING',
      label: LABEL.spapi,
      reason: 'proactive-action-text-unsupported',
      recipient,
      requiresAttachmentUpload: hasAttachments,
      blocked: true,
      blockedReason:
        'A ação "warranty" do SP-API não aceita texto livre (somente anexos e datas de cobertura). Remova o texto ou use "confirmCustomizationDetails".',
      actionName: null,
    };
  }

  return {
    route: 'AMAZON_SP_API_MESSAGING',
    label: LABEL.spapi,
    reason: 'proactive-messaging',
    recipient,
    requiresAttachmentUpload: hasAttachments,
    blocked: false,
    actionName,
  };
}
