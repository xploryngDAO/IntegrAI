import { AMAZON_PROACTIVE_ACTIONS, CHANNEL_ROUTE_LABEL } from '@sac/shared';
import type {
  AmazonProactiveAction,
  ChannelActionKind,
  OutboundValidationInput,
  RouteDecision,
} from '@sac/shared';
import { isRecord, readString } from '../guards';

/**
 * Pure Amazon outbound routing decisions.
 *
 * Amazon forbids proactive contact with buyers who never messaged us, so the
 * only lawful routes are:
 *  1. SMTP Buyer-Seller relay reply (there is a prior INBOUND_BUYER message);
 *  2. SP-API proactive messaging using an action the order explicitly allows;
 *  3. silent close (`AMAZON_NO_RESPONSE_NEEDED`) — not a send.
 */

/** Preference order mandated by the contract. */
export const AMAZON_PROACTIVE_ACTION_PREFERENCE: readonly AmazonProactiveAction[] = [
  'confirmDeliveryDetails',
  'unexpectedProblem',
  'warranty',
  'confirmCustomizationDetails',
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
 * Reads action names from any of the shapes the platform hands us:
 * `['warranty']`, `{ actions: ['warranty'] }`, `{ actions: [{ actionName }] }`,
 * `{ allowedActions: [...] }`, `{ actionNames: [...] }`.
 */
export function readAllowedActionNames(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value)
      ? (value.actions ?? value.allowedActions ?? value.actionNames ?? value.allowed_actions)
      : undefined;
  if (!Array.isArray(source)) return [];
  const names: string[] = [];
  for (const entry of source) {
    const name =
      typeof entry === 'string'
        ? entry
        : isRecord(entry)
          ? readString(entry.actionName)
          : null;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** First allowed proactive action following the mandated preference order. */
export function chooseProactiveAction(allowedActions: unknown): AmazonProactiveAction | null {
  const allowed = new Set(readAllowedActionNames(allowedActions));
  for (const candidate of AMAZON_PROACTIVE_ACTION_PREFERENCE) {
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
  const allowedNames = readAllowedActionNames(input.allowedActions);
  const actionName = chooseProactiveAction(input.allowedActions);
  if (!actionName) {
    const blockedReason =
      allowedNames.length === 0
        ? 'O Amazon não retornou ações proativas de mensagem para este pedido e não há mensagem prévia do comprador; o contato proativo por e-mail é proibido pelo Buyer-Seller Messaging Policy.'
        : `O pedido permite apenas: ${allowedNames.join(', ')}. Nenhuma delas é uma ação proativa de mensagem do SP-API.`;
    return {
      route: 'AMAZON_SP_API_MESSAGING',
      label: LABEL.spapi,
      reason: 'need-prior-inbound',
      recipient,
      requiresAttachmentUpload: input.attachments.length > 0,
      blocked: true,
      blockedReason,
      actionName: null,
    };
  }

  return {
    route: 'AMAZON_SP_API_MESSAGING',
    label: LABEL.spapi,
    reason: 'proactive-messaging',
    recipient,
    requiresAttachmentUpload: input.attachments.length > 0,
    blocked: false,
    actionName,
  };
}
