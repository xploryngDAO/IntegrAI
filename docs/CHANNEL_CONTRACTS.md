# Channel adapter contracts (authoritative)

Every adapter implements `IMarketplaceChannelAdapter` from `@sac/shared`
(`packages/shared/src/adapter.ts`) and is created by a factory exported from its
folder entry point:

```ts
export function createAmazonChannelAdapter(deps: AdapterDependencies): IMarketplaceChannelAdapter;
export function createMercadoLivreChannelAdapter(deps: AdapterDependencies): IMarketplaceChannelAdapter;
export function createShopeeChannelAdapter(deps: AdapterDependencies): IMarketplaceChannelAdapter;
```

Dependencies available (`AdapterDependencies`): `logger`, `clock`, `config`,
`repos` (accounts, tickets, messages, orders, attachments, webhookEvents,
piiVault, ticketEvents), `cache`, `lock`, `rateLimiter`, `storage`, `cipher`,
`realtime`, `http`, `queue`.

Never instantiate Prisma/Redis/S3 directly inside an adapter — use `deps`.

Policy helpers live in `@sac/shared/compliance`: `evaluateOutboundPolicy`,
`MARKETPLACE_POLICY`, `detectOptOut`, `applyImportantPrefix`,
`ensureReplySubject`, `stripAmazonEmailFooter`, `stripQuotedReply`,
`extractEmailAddresses`, `AMAZON_ORDER_ID_REGEX`.

Cache keys, TTLs and rate-limit bucket conventions are in
`@sac/shared/constants` (`CACHE_KEYS`, `AMAZON_LWA_TTL_SECONDS`,
`AMAZON_RDT_TTL_SECONDS`, `MELI_TOKEN_TTL_SECONDS`, `SHOPEE_TOKEN_TTL_SECONDS`,
`AMAZON_RDT_DATA_ELEMENTS`, `AMAZON_PROACTIVE_ACTIONS`, `SLA_DEFAULTS`).
Use `CACHE_KEYS.rateBucket('amazon:messaging:<accountId>')` style names.

---

## AMAZON (`adapters/amazon/`)

### Auth
- **LWA** (`POST {lwaTokenUrl}`): `grant_type=refresh_token`,
  `refresh_token=<decrypted account.refreshTokenEnc>`,
  `client_id`, `client_secret`. Cache the access token in Redis under
  `CACHE_KEYS.amazonLwaToken(accountId)` with **TTL 3300s** (55 min).
- **RDT** for buyer PII: `POST {rdtEndpoint}` body
  `{ "restrictedResources": [{ "method": "GET", "path": "/orders/v0/orders/<orderId>", "dataElements": ["buyerInfo","shippingAddress"] }] }`
  → send the returned token in `x-amz-access-token` for the order read.
  Cache per `CACHE_KEYS.amazonRdt(accountId, sha256(path))` for
  `AMAZON_RDT_TTL_SECONDS`. An RDT is scoped to a single resource/action.
- Rate limit all SP-API calls through `deps.rateLimiter.acquire(...)` with the
  buckets declared in `config.rateLimits`.

### Inbound — SES email relay (`verifyInbound` + `hydrate`)
The relay posts JSON: `{ messageId, envelopeFrom, envelopeTo, headers, rawMimeBase64, receivedAt }`
or raw MIME with `Content-Type: message/rfc822`. `verifyInbound` validates
`x-sac-signature` = hex HMAC-SHA256 of the **raw body** with
`config.amazon.sesInboundSharedSecret` using `timingSafeEqual`, and resolves the
account from the recipient address (`channel_config.inbound_email_route`) or the
`x-sac-account-id` header.

`hydrate` must:
1. Parse MIME with `mailparser` (`simpleParser`), fall back to
   `mailparser`'s streaming API for >5 MB. Persist the raw `.eml` to S3
   (`storage.putObject({ key: 'amazon/inbound/<yyyy>/<mm>/<dd>/<messageId>.eml' })`)
   and set `bodyRawS3Uri`.
2. Ignore system senders (`do-not-reply@amazon.com`, `no-reply@amazon.com.br`,
   `shipment-tracking@amazon.com`, `marketplace-messages@amazon.com` bounce
   senders) — except bounce notices, which become a `BOUNCED_BLOCKED` system
   message on the existing ticket.
3. Extract the Amazon order id with `AMAZON_ORDER_ID_REGEX`
   (`\b\d{3}-\d{7}-\d{7}\b`) from the `X-Amazon-Order-Id` header, then Subject,
   then body.
4. Strip Amazon footers (`------------- Mensagem original -------------` etc.)
   with `stripAmazonEmailFooter` + `stripQuotedReply`, collapse whitespace.
5. Build threading headers: `inReplyTo`, `references`, `messageId`, `subject`.
6. Detect:
   - **external seller-central reply**: `From` matches the account's approved
     sender / `channel_config.smtp_sender_email` and it is not the buyer →
     `direction = EXTERNAL_SELLER_PANEL`, status hint `WAITING_BUYER`.
   - **bounce/block notice**: `statusHint`/delivery `BOUNCED_BLOCKED`,
     `messageType = 'action_system'`.
   - **no-response-needed**: `noResponseNeededUrl` link present in the body
     (`https://sellercentral.amazon.com/...`) → `channelMetadata.no_response_link`.
   - **opt-out**: `detectOptOut(body)` → `channelMetadata.buyer_opt_out = true`.
7. Enrich the order lazily: call `GET {spApiEndpoint}/orders/v0/orders/{orderId}`
   (LWA token only; **no RDT** for order business data) and the RDT-protected
   read for PII, then fill `order` + `buyerPii`. PII goes to
   `repos.piiVault.upsert` with `expiresAt = now + config.piiRetentionDays days`,
   and to `cache` under `CACHE_KEYS.piiTicket(ticketId)` with short TTL. If the
   order read 403s for PII, still emit the message with
   `warnings: ['AMAZON_PII_NOT_AVAILABLE']`.
8. If the e-mail is a reply to nothing (new thread), keep
   `externalReferenceId = orderId` (or the buyer anonymized e-mail for pre-sale).

### Outbound routing (`resolveRoute` + `send`)
Order of decisions:
1. `closeWithoutResponse` → route `AMAZON_EMAIL_RELAY`, no send
   (`executeAction` handles `AMAZON_NO_RESPONSE_NEEDED`).
2. **Route 1 — receptive reply** when the ticket has a prior `INBOUND_BUYER`:
   send through the SMTP relay (`deps.config.smtp`, nodemailer) using
   `draft.smtpSenderEmail` (or `channel_config.smtp_sender_email`) as `From`,
   preserving `Subject: Re: ...` and `In-Reply-To` / `References` headers.
   Attachments as MIME parts, max 10 MB total. Apply `applyImportantPrefix`
   when `forceImportant`. This route is required — Amazon forbids proactive
   contact with buyers who never messaged us.
3. **Route 2 — proactive** (no prior inbound): never SMTP. Validate the action
   against `GET /messaging/v1/orders/{orderId}/messagingActions` (fall back to
   `allowed_actions_cache`) restricted to `AMAZON_PROACTIVE_ACTIONS`. With an
   attachment: compute `Content-MD5` (base64 of MD5), call
   `POST /uploads/2020-11-01/uploadDestinations/messaging` with
   `{ marketplaceIds, contentMD5 }`, PUT the bytes to the returned
   `uploadDestinationId` pre-signed URL, then
   `POST /messaging/v1/orders/{orderId}/messages/{actionName}` with
   `uploadDestinationId`. Respect **1 req/s** (token bucket).
4. Route 3 is not a send: `AMAZON_NO_RESPONSE_NEEDED` action (silent close),
   optionally hitting `no_response_link`.

`validateOutbound` runs `evaluateOutboundPolicy` with
`allowedLinkDomains` merged from `MARKETPLACE_POLICY.AMAZON` + account
`approved_sender_domains`, then flags the missing prior inbound
(`code: NEED_PRIOR_INBOUND`, severity BLOCK) when it would force SP-API.
Exposes `routePreview`.

---

## MERCADO LIVRE (`adapters/mercadolivre/`)

### Auth
`POST {apiBase}/oauth/token` with `grant_type=refresh_token`,
`client_id`, `client_secret`, `refresh_token` (decrypted). Tokens rotate: store
the new pair with `deps.repos.accounts.updateTokens`, TTL from
`expires_in` (default `MELI_TOKEN_TTL_SECONDS`). Serialize refreshes with
`deps.lock.withLock([CACHE_KEYS.meliRefreshLock(accountId)], 30_000, fn)`.
Access token cached at `CACHE_KEYS.meliToken(accountId)`.

### Inbound (`verifyInbound` + `hydrate`)
Meli posts `{ _id, resource, user_id, topic, sent, attempts }`.
`verifyInbound` resolves the account by `user_id` (externalSellerId) and returns
`eventId = _id`; no cryptographic signature exists — accept but mark
`signatureValid=true` with `reason='MELI_NO_SIGNATURE'`, and reject when the
account is unknown.

`hydrate` by topic:
- `questions`: `GET /questions/{id}` then `GET /items/{item_id}` →
  `ticketType = PRE_SALE`, `externalReferenceId = question_id`,
  `marketplaceCreatedAt = question.date_created`, buyer from `item.seller_id`
  counterpart (question.from.id), `channelMetadata.item_snapshot`.
- `messages`: `GET /messages/packs/{pack_id}/sellers/{seller_id}?tag=post_sale`
  and `GET /orders/{order_id}`. If
  `conversation_status.status === 'blocked'`, fetch
  `GET /messages/action_guide/packs/{pack_id}` and store the structured reasons
  in `channelMetadata.action_guide`. Map each message (`m.message_id`,
  `m.text`, `m.date`, `m.from.user_id`, `m.attachments[]`) to a hydrated message.
- `claims` / `post_purchase`: `GET /post-purchase/v1/claims/{claim_id}` +
  `GET /post-purchase/v1/claims/{claim_id}/messages`.
  **Critical:** if a post-sale ticket already exists for the order, return a
  message whose `channelMetadata` carries `claim_id`, `has_active_claim=true`,
  `due_date`, and `available_actions` extracted from
  `players.find(p => p.role === 'respondent').available_actions`.
  Ticket type becomes `CLAIM_DISPUTE`, status `MEDIATION` when a mediator is
  present.
- `orders`/`shipments`: refresh `orders_cache` only (no new ticket).

`claim.due_date` overrides the SLA deadline.

### Outbound routing (`resolveRoute` + `send`)
- **Route A — pre-sale question**: `POST /answers` `{ question_id, text }`.
  Route `MELI_QUESTIONS_API`.
- **Route B — active claim** (`hasActiveClaim === true` or
  `ticketType === CLAIM_DISPUTE`): the pack chat is blocked. `POST
  /post-purchase/v1/claims/{claimId}/actions/send-message` with
  `{ receiver_role: recipient === 'MEDIATOR' ? 'mediator' : 'complainant',
     message: bodyText, attachments: [{ filename, content_base64? , url? }] }`.
  Upload evidence first via `POST /post-purchase/v1/claims/{claimId}/attachments`.
  Route `MELI_CLAIMS_API`.
- **Route C — normal post-sale**: upload each attachment with
  `POST /messages/attachments?tag=post_sale&site_id=MLB` (multipart), collect
  `attachment_id`, then `POST /messages/packs/{packId}/sellers/{sellerId}?tag=post_sale`
  with `{ text, attachments: [attachment_id] }`. If the pack requires a
  structured reason (`action_guide`), send
  `POST /messages/action_guide/packs/{packId}` with `option_id` =
  `draft.meliActionGuideReasonId`.
- `executeAction`: `MELI_ALLOW_RETURN` → `POST
  /post-purchase/v1/claims/{claimId}/actions/allow-return`; `MELI_REFUND` →
  `.../actions/refund`; `MELI_OPEN_DISPUTE` → `.../actions/open-dispute`.
  Only call actions present in the claim's `available_actions` for the
  respondent; otherwise return `ok:false` with the available list.
- `validateOutbound` uses `MARKETPLACE_POLICY.MERCADO_LIVRE` plus:
  claim-blocked chat warning when a claim exists, and a BLOCK when the buyer
  opted for mediation but `recipient` is `BUYER`.

---

## SHOPEE (`adapters/shopee/`)

### Signing (100% of calls)
`sign = HMAC_SHA256(partner_id + api_path + timestamp + access_token + shop_id, partner_key)`
hex lowercase. `api_path` is the path only (`/api/v2/...`), `timestamp` is
unix seconds. Public endpoints (auth/token, webhook) omit access_token/shop_id.
Clock skew must stay < 5 min; fail fast with `MARKETPLACE_API_ERROR` otherwise.

### Auth + single-use refresh
`POST /api/v2/auth/token/get` (`grant_type=refresh_token`) — the refresh token
is **single-use**. Always wrap refresh in
`deps.lock.withLock([CACHE_KEYS.shopeeRefreshLock(accountId)], 60_000, ...)`,
re-read the account inside the lock, and persist the rotated pair immediately.
A centralized `queue.token.refresh` job calls `runMaintenance()` every 3h30m
(12 600 s). Use `CACHE_KEYS.shopeeRefreshGate(accountId)` to make the refresh
idempotent within the interval.

### Inbound webhook
Payload `{ code, shop_id, timestamp, data: {...} }` where `code` is the push
code (`1` shop_authorization, `2` order status, `3` order tracking,
`4` sellerchat, `5` item, `6` return, `7` cancellation, `10` shipping document).
`verifyInbound` recomputes the signature over the **full webhook URL + "|" +
rawBody** using the partner key and compares with `crypto.timingSafeEqual`.
Extract `eventId` from `data.message_id` | `data.ordersn` + `code` + `timestamp`.

`hydrate` triage:
| condition | result |
|---|---|
| sellerchat message without `order_sn` | `ticketType = PRE_SALE`, priority MEDIUM, queue `COMERCIAL::Pre-Venda`, enrich via `v2.product.get_item_base_info` |
| sellerchat message with active `order_sn` | `POST_SALE_ORDER`, priority HIGH, queue `SAC::Shopee-N1`, enrich `v2.order.get_order_detail` + `v2.logistics.get_tracking_info` in parallel |
| `code == 7` (`IN_CANCEL`) or `v2.returns` event | `CANCELLATION`/`RETURN_REFUND`, priority `CRITICAL_SLA`, queue `SAC::Shopee-N2-Retencao`, SLA fatal |
| `code == 3` tracking update | system message (`OUTBOUND_SYSTEM`), updates `orders_cache` only |
| `code == 4` chat | also update `channelMetadata.unread_count` and `crr_safe` |

Ordering: every hydrated message carries the official `created_timestamp`
(seconds → multiply by 1000). Sticky routing hint: if the buyer replied within
48h and `CACHE_KEYS.stickyAgent(conversationId)` holds an online agent, put it in
`channelMetadata.preferred_agent_id`.

### Outbound
- Text: `POST /api/v2/sellerchat/send_message` with
  `{ to_id, message_type: 'text', content: { text } }`.
- Image: upload first with `POST /api/v2/sellerchat/upload_image`
  (multipart `file`), then send `message_type='image'`,
  `content: { image_url }`.
- Order card: `message_type='order'`, `content: { order_sn }`.
- Item card: `message_type='item'`, `content: { item_id }`.
- **CRR protection**: immediately after any successful send, and on
  `SHOPEE_MARK_READ`, call `POST /api/v2/sellerchat/read_conversation` with
  `{ conversation_id, last_read_message_id }`. Guarantee the last message in the
  thread is OUTBOUND (`channelMetadata.crr_safe = true`).
- Post-sale actions: `SHOPEE_CONFIRM_RETURN` → `POST /api/v2/returns/confirm`
  `{ return_sn }`; `SHOPEE_DISPUTE_RETURN` → `POST /api/v2/returns/dispute`
  `{ return_sn, dispute_reason, dispute_text_reason, image: [urls] }`;
  `SHOPEE_ACCEPT_CANCELLATION` → `POST /api/v2/order/handle_buyer_cancellation`
  `{ order_sn, operation: 'ACCEPT' }`.
- `runMaintenance()`: refresh tokens under the lock **and** recover lost pushes
  (`POST /api/v2/push/get_lost_push_message`) since
  `CACHE_KEYS.lastLostPushCursor(accountId)`, enqueueing recovered payloads into
  `queue.inbound.shopee` with `source='lost_push'`.

`validateOutbound` uses `MARKETPLACE_POLICY.SHOPEE`, blocks links to other
marketplaces/WhatsApp, and returns a `CRR` note when the thread's last message is
inbound and older than 12h.

---

## Error handling rules (all adapters)

- Map HTTP 429/5xx to `MarketplaceApiError(..., retryable = true)` and let the
  worker retry with backoff; 4xx (except 429) are non-retryable and must include
  the marketplace payload in `details`.
- Never let a marketplace failure escape `hydrate` for one bad item: return the
  validated messages you have and log the rest; throw only when nothing could be
  parsed.
- Token failures set `accounts.status = TOKEN_EXPIRED` (via `repos.accounts`)
  and emit `realtime.channelHealth`.
- Truncate all persisted text to 200k chars and redact PII from log lines with
  `redactPiiForLogs`.
