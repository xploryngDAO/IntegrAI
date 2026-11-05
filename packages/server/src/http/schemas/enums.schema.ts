import { z } from 'zod';
import { MARKETPLACES } from '@sac/shared';
import type {
  AgentPresenceStatus,
  ChannelActionKind,
  QueueFilterKey,
  TicketStatus,
  TicketType,
} from '@sac/shared';
import { csvToStrings } from './common';

/**
 * Zod mirrors of the `@sac/shared` string unions.
 *
 * The runtime value lists live here because zod needs concrete tuples; the
 * `Coverage` assertions below make TypeScript fail if `@sac/shared` ever adds an
 * enum member that is missing from a list (the shared package is frozen, but the
 * check keeps this file honest).
 */
type Coverage<TUnion extends string, TList extends TUnion> = Exclude<TUnion, TList> extends never
  ? true
  : ['MISSING_ENUM_VALUES', Exclude<TUnion, TList>];

const TICKET_STATUS_VALUES = [
  'UNREAD',
  'OPEN_WAITING_AGENT',
  'WAITING_BUYER',
  'NO_RESPONSE_NEEDED',
  'MEDIATION',
  'RESOLVED',
] as const satisfies readonly TicketStatus[];

const TICKET_TYPE_VALUES = [
  'PRE_SALE',
  'POST_SALE_ORDER',
  'CLAIM_DISPUTE',
  'RETURN_REFUND',
  'CANCELLATION',
  'PROACTIVE',
] as const satisfies readonly TicketType[];

const QUEUE_FILTER_VALUES = [
  'ALL',
  'SLA_CRITICAL',
  'CLAIMS',
  'PRE_SALE',
  'WAITING_ME',
  'UNASSIGNED',
] as const satisfies readonly QueueFilterKey[];

const AGENT_PRESENCE_VALUES = ['ONLINE', 'PAUSED', 'OFFLINE'] as const satisfies readonly AgentPresenceStatus[];

const CHANNEL_ACTION_KIND_VALUES = [
  // Amazon
  'AMAZON_CONFIRM_DELIVERY_DETAILS',
  'AMAZON_UNEXPECTED_PROBLEM',
  'AMAZON_WARRANTY',
  'AMAZON_CONFIRM_CUSTOMIZATION',
  'AMAZON_NO_RESPONSE_NEEDED',
  // Mercado Livre
  'MELI_ANSWER_QUESTION',
  'MELI_SEND_POST_SALE_MESSAGE',
  'MELI_SEND_CLAIM_MESSAGE',
  'MELI_ALLOW_RETURN',
  'MELI_REFUND',
  'MELI_OPEN_DISPUTE',
  // Shopee
  'SHOPEE_SEND_CHAT_MESSAGE',
  'SHOPEE_CONFIRM_RETURN',
  'SHOPEE_DISPUTE_RETURN',
  'SHOPEE_ACCEPT_CANCELLATION',
  'SHOPEE_MARK_READ',
] as const satisfies readonly ChannelActionKind[];

const ticketStatusCoverage: Coverage<TicketStatus, (typeof TICKET_STATUS_VALUES)[number]> = true;
const ticketTypeCoverage: Coverage<TicketType, (typeof TICKET_TYPE_VALUES)[number]> = true;
const queueFilterCoverage: Coverage<QueueFilterKey, (typeof QUEUE_FILTER_VALUES)[number]> = true;
const presenceCoverage: Coverage<AgentPresenceStatus, (typeof AGENT_PRESENCE_VALUES)[number]> = true;
const channelActionCoverage: Coverage<ChannelActionKind, (typeof CHANNEL_ACTION_KIND_VALUES)[number]> = true;

/** Compile-time exhaustiveness evidence (referenced so noUnusedLocals stays quiet). */
export const ENUM_COVERAGE_CHECKS: readonly boolean[] = [
  ticketStatusCoverage,
  ticketTypeCoverage,
  queueFilterCoverage,
  presenceCoverage,
  channelActionCoverage,
];

export const marketplaceSchema = z.enum(MARKETPLACES);
export const ticketStatusSchema = z.enum(TICKET_STATUS_VALUES);
export const ticketTypeSchema = z.enum(TICKET_TYPE_VALUES);
export const queueFilterSchema = z.enum(QUEUE_FILTER_VALUES);
export const agentPresenceSchema = z.enum(AGENT_PRESENCE_VALUES);
export const channelActionKindSchema = z.enum(CHANNEL_ACTION_KIND_VALUES);

/** `?marketplace=AMAZON,SHOPEE` -> `Marketplace[]`. */
export const marketplaceCsvSchema = z.string().transform(csvToStrings).pipe(z.array(marketplaceSchema).min(1));
export const ticketStatusCsvSchema = z.string().transform(csvToStrings).pipe(z.array(ticketStatusSchema).min(1));

export const uuidSchema = z.string().uuid();
