/**
 * Mercado Livre official API payload shapes consumed by this adapter.
 *
 * Only the fields the adapter reads are modelled; the marketplace responses are
 * JSON documents and are treated as untrusted input by the mappers (every read
 * goes through the narrowing helpers in `mappers.ts`).
 */

export interface MeliTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  user_id?: number | string;
}

/**
 * Push notification payload delivered by Mercado Livre.
 *
 * General topics use `_id`; the newer sub-topic model (messages, post_purchase,
 * user_products, ...) uses `id` plus an `actions` array (e.g. `["created"]`,
 * `["claims"]`). `Notificações` docs:
 * `{ id, resource, user_id, topic, actions, application_id, attempts, sent,
 * received }`.
 */
export interface MeliWebhookPayload {
  _id?: number | string | null;
  id?: number | string | null;
  resource?: string | null;
  user_id?: number | string | null;
  topic?: string | null;
  actions?: string[] | null;
  sent?: string | null;
  received?: string | null;
  attempts?: number | null;
  application_id?: number | string | null;
}

/** Entry returned by `GET /missed_feeds?app_id=...` (Meli keeps 2 days). */
export type MeliMissedFeed = MeliWebhookPayload;


/* ------------------------------- Questions -------------------------------- */

export interface MeliQuestionFrom {
  id?: number | string | null;
}

export interface MeliFileAttachment {
  id?: string | null;
  filename?: string | null;
  original_filename?: string | null;
  type?: string | null;
  size?: number | null;
  url?: string | null;
}

export interface MeliQuestion {
  id?: number | string | null;
  item_id?: string | null;
  text?: string | null;
  status?: string | null;
  date_created?: string | null;
  from?: MeliQuestionFrom | null;
  attachments?: MeliFileAttachment[] | null;
}

export interface MeliItem {
  id?: string | null;
  title?: string | null;
  thumbnail?: string | null;
  price?: number | null;
  permalink?: string | null;
  seller_id?: number | string | null;
  site_id?: string | null;
}

export interface MeliAnswerResponse {
  id?: number | string | null;
  question_id?: number | string | null;
  text?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

/* --------------------------- Post-sale messages --------------------------- */

export interface MeliMessageParty {
  user_id?: number | string | null;
}

export interface MeliMessageDate {
  created?: string | null;
  received?: string | null;
  available?: string | null;
  notified?: string | null;
  read?: string | null;
}

export interface MeliMessageResourceRef {
  id?: number | string | null;
  name?: string | null;
}

export interface MeliPackMessage {
  id?: string | null;
  message_id?: string | null;
  text?: string | null;
  from?: MeliMessageParty | null;
  to?: MeliMessageParty | MeliMessageParty[] | null;
  date?: string | null;
  message_date?: MeliMessageDate | null;
  message_attachments?: MeliFileAttachment[] | null;
  attachments?: MeliFileAttachment[] | null;
  message_resources?: MeliMessageResourceRef[] | null;
  status?: string | null;
  conversation_id?: string | null;
  site_id?: string | null;
}

export interface MeliConversationStatus {
  path?: string | null;
  status?: string | null;
  substatus?: string | null;
  status_date?: string | null;
  status_update_allowed?: boolean | null;
  /** `blocked-messages` docs return `claim_ids` (array); older docs `claim_id`. */
  claim_id?: number | string | null;
  claim_ids?: Array<number | string> | null;
  shipping_id?: number | string | null;
}

export interface MeliPackMessagesResponse {
  paging?: { limit?: number; offset?: number; total?: number } | null;
  conversation_status?: MeliConversationStatus | null;
  messages?: MeliPackMessage[] | null;
  seller_max_message_length?: number | null;
  buyer_max_message_length?: number | null;
}

/**
 * `GET /messages/{message_id}`: used to resolve the opaque `resource` hash of a
 * `messages` push to its pack/order ids.
 */
export interface MeliMessageDetail {
  message_id?: string | null;
  id?: string | null;
  from?: MeliMessageParty | null;
  to?: MeliMessageParty | MeliMessageParty[] | null;
  text?: string | { plain?: string | null } | null;
  date?: string | null;
  message_date?: MeliMessageDate | null;
  attachments?: MeliFileAttachment[] | null;
  message_attachments?: MeliFileAttachment[] | null;
  message_resources?: MeliMessageResourceRef[] | null;
  resource?: string | null;
  resource_id?: number | string | null;
  order_id?: number | string | null;
  pack_id?: number | string | null;
  site_id?: string | null;
}

/**
 * `GET /messages/action_guide/packs/{packId}?tag=post_sale` option.
 * Official options use `id` (e.g. `OTHER`, `REQUEST_BILLING_INFO`) and carry the
 * template/cap metadata in the object itself.
 */
export interface MeliActionGuideOption {
  id?: number | string | null;
  option_id?: number | string | null;
  internal_description?: string | null;
  description?: string | null;
  title?: string | null;
  text?: string | null;
  action?: string | null;
  type?: string | null;
  enabled?: boolean | null;
  actionable?: boolean | null;
  char_limit?: number | null;
  cap_available?: number | null;
  templates?: Array<{ id?: string | null; vars?: unknown }> | null;
  child_options?: unknown;
}

export interface MeliActionGuide {
  options?: MeliActionGuideOption[] | null;
  pack_id?: number | string | null;
  conversation_status?: MeliConversationStatus | null;
  blocked?: boolean | null;
}

export interface MeliAttachmentUploadResponse {
  id?: string | null;
  filename?: string | null;
  /** Claims attachments return `{ user_id, file_name }` (not `id`). */
  file_name?: string | null;
  user_id?: number | string | null;
  [key: string]: unknown;
}


export interface MeliSendMessageResponse {
  message_id?: string | null;
  id?: string | null;
  messages?: MeliPackMessage[] | null;
  [key: string]: unknown;
}

/* --------------------------------- Orders --------------------------------- */

export interface MeliOrderItemDetail {
  item?: {
    id?: string | null;
    title?: string | null;
    seller_sku?: string | null;
    category_id?: string | null;
    thumbnail?: string | null;
  } | null;
  quantity?: number | null;
  unit_price?: number | null;
  full_unit_price?: number | null;
  sale_fee?: number | null;
}

export interface MeliOrderBuyer {
  id?: number | string | null;
  nickname?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

export interface MeliOrder {
  id?: number | string | null;
  pack_id?: number | string | null;
  status?: string | null;
  status_detail?: string | null;
  total_amount?: number | null;
  paid_amount?: number | null;
  currency_id?: string | null;
  buyer?: MeliOrderBuyer | null;
  seller?: MeliMessageParty | null;
  order_items?: MeliOrderItemDetail[] | null;
  shipping?: { id?: number | string | null } | null;
  shipping_id?: number | string | null;
  tags?: string[] | null;
  date_created?: string | null;
  date_closed?: string | null;
  last_updated?: string | null;
  payments?: unknown[] | null;
  feedback?: unknown;
}

export interface MeliShipmentStatusHistoryEntry {
  status?: string | null;
  substatus?: string | null;
  date?: string | null;
}

export interface MeliShipment {
  id?: number | string | null;
  order_id?: number | string | null;
  status?: string | null;
  substatus?: string | null;
  tracking_number?: string | null;
  tracking_method?: string | null;
  logistic_type?: string | null;
  carrier?: { id?: number | string | null; name?: string | null } | null;
  shipping_option?: {
    name?: string | null;
    estimated_delivery_time?: { date?: string | null; type?: string | null } | null;
    shipping_method?: { name?: string | null } | null;
  } | null;
  status_history?: MeliShipmentStatusHistoryEntry[] | null;
  tags?: string[] | null;
  date_created?: string | null;
  last_updated?: string | null;
}

/* --------------------------- Claims / post-purchase ------------------------ */

export interface MeliClaimAvailableAction {
  action?: string | null;
  due_date?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export interface MeliClaimPlayer {
  role?: string | null;
  user_id?: number | string | null;
  available_actions?: MeliClaimAvailableAction[] | null;
  [key: string]: unknown;
}

export interface MeliClaim {
  id?: number | string | null;
  /** Resource type (usually `order`) plus its id; some responses inline `order_id`. */
  resource?: string | null;
  resource_id?: number | string | null;
  order_id?: number | string | null;
  status?: string | null;
  stage?: string | null;
  type?: string | null;
  date_created?: string | null;
  last_updated?: string | null;
  due_date?: string | null;
  players?: MeliClaimPlayer[] | null;
  resolution?: unknown;
  claim_window?: unknown;
  [key: string]: unknown;
}

export interface MeliClaimMessage {
  id?: number | string | null;
  message_id?: number | string | null;
  /** Official claim messages return `message` (not `text`). */
  message?: string | null;
  text?: string | null;
  /** Official claim messages identify the author by role, not by user id. */
  sender_role?: string | null;
  receiver_role?: string | null;
  from?: MeliMessageParty | null;
  date?: string | null;
  date_created?: string | null;
  message_date?: string | null;
  stage?: string | null;
  status?: string | null;
  attachments?: MeliFileAttachment[] | null;
  [key: string]: unknown;
}

export interface MeliClaimMessagesResponse {
  paging?: unknown;
  messages?: MeliClaimMessage[] | null;
  [key: string]: unknown;
}

/* --------------------------------- Users ---------------------------------- */

/** `GET /users/me` and `GET /users/{id}` (identity diagnostics). */
export interface MeliUser {
  id?: number | string | null;
  nickname?: string | null;
  site_id?: string | null;
  country_id?: string | null;
  user_type?: string | null;
  status?: { site_status?: string | null; [key: string]: unknown } | null;
  tags?: string[] | null;
  [key: string]: unknown;
}
