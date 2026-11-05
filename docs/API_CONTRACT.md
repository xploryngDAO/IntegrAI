# SAC Hub — HTTP API contract (v1)

Base URL: `${APP_BASE_URL}/api/v1`.
All responses are `{ "data": ... }` on success and
`{ "error": { "code", "message", "details? } }` on failure.
All timestamps are ISO-8601 UTC strings. `Authorization: Bearer <JWT>` is
required for every route except `/health`, `/api/v1/auth/login`, the OAuth
callback and `/webhooks/*`.

Errors use the codes from `@sac/shared/errors.ts`
(`VALIDATION_ERROR`, `NOT_FOUND`, `AUTHENTICATION_ERROR`, `POLICY_VIOLATION`,
`RATE_LIMITED`, `MARKETPLACE_API_ERROR`, `INVALID_SIGNATURE`, `CONFLICT`).

---

## 1. Auth & agents

### POST /auth/login
Body: `{ "email": string, "password": string }`
→ `data: { token, agent: { id, name, email, role, presence } }` (see `AuthResponse`)

### GET /auth/me
→ `data: { id, name, email, role, presence, activeTickets }`

### PUT /auth/presence
Body: `{ "presence": "ONLINE" | "PAUSED" | "OFFLINE" }`
→ `data: IAgentSummary`

### GET /agents
→ `data: IAgentSummary[]` — used by the assignment dropdown and load board.

---

## 2. Queue & tickets

### GET /tickets
Query:
| param | values | notes |
|---|---|---|
| `filter` | `ALL`, `SLA_CRITICAL`, `CLAIMS`, `PRE_SALE`, `WAITING_ME`, `UNASSIGNED` | maps to `TicketListFilter.queueKey` |
| `marketplace` | comma list of `AMAZON,MERCADO_LIVRE,SHOPEE` | |
| `accountId` | uuid | store filter in the topbar |
| `search` | free text | Order ID, CPF, buyer name/nick, protocol |
| `status` | comma list of `TicketStatus` | |
| `page`, `pageSize` | ints (pageSize ≤ 100, default 40) | |

→ `data: Paginated<TicketListItem>` where
`{ items, total, page, pageSize, totalPages }`.
Ordering: `CRITICAL_SLA`/soonest `slaDeadlineAt` first, then `lastMessageAt` desc.

### GET /tickets/:id
→ `data: TicketDetail` — includes `order`, `customer` (PII-gated for Amazon),
`messages` (ordered by `marketplace_created_at`), `events`, `routing`,
`allowedActions`, `crr` (Shopee only).

### POST /tickets/:id/assign
Body: `{ "agentId": uuid }` → `data: SupportTicketRecord`

### POST /tickets/:id/status
Body: `{ "status": TicketStatus }` → `data: SupportTicketRecord`

### POST /tickets/:id/close-without-response
Marks `NO_RESPONSE_NEEDED` without sending anything (Amazon Route 3 / silent
close). → `data: SupportTicketRecord`

### POST /tickets/:id/read
Marks the ticket read locally and, for Shopee, ALSO calls
`v2.sellerchat.read_conversation` (protects the 12h CRR index).
→ `data: SupportTicketRecord`

### POST /tickets/:id/notes
Body: `{ "text": string }` → `data: MessageView` (internal note, never sent)

---

## 3. Outbound messaging

### POST /tickets/:id/messages
Headers: `Idempotency-Key: <uuid>` (recommended).
Body:
```json
{
  "bodyText": "string",
  "bodyHtml": "string?",
  "subject": "string?",
  "recipient": "BUYER | MEDIATOR",
  "forceImportant": false,
  "closeWithoutResponse": false,
  "attachmentS3Keys": ["string"],
  "meliActionGuideReasonId": "string?",
  "shopeeMessageType": "text | image | order | item",
  "shopeeOrderCardOrderSn": "string?",
  "shopeeItemCardItemId": 123
}
```
→ `data: { messageId, routeUsed, deliveryStatus, warnings: string[], ticket }`

Server re-evaluates the route/policy. A policy violation returns **422**
`POLICY_VIOLATION` with `details.violations`.

### POST /tickets/:id/policy-check
Body: `{ bodyText, bodyHtml?, subject?, recipient?, attachmentCount? }`
→ `data: PolicyEvaluation` (`violations[]`, `blocked`, `sanitizedText`,
`sanitizedHtml`, `notes[]`, `routePreview`). Used on every keystroke — must be
cheap and never call the marketplace.

### GET /tickets/:id/route?recipient=BUYER|MEDIATOR
→ `data: RouteDecision` (`route`, `label`, `reason`, `blocked`, `blockedReason`,
`requiresAttachmentUpload`, `recipient`, `actionName`).

### GET /tickets/:id/actions
→ `data: AvailableActionView[]` — dynamic cockpit buttons
(`kind`, `label`, `description`, `route`, `enabled`, `destructive`,
`requiresConfirmation`, `source`).

### POST /tickets/:id/actions
Body:
```json
{
  "kind": "MELI_ALLOW_RETURN | MELI_REFUND | MELI_OPEN_DISPUTE | SHOPEE_CONFIRM_RETURN
        | SHOPEE_DISPUTE_RETURN | SHOPEE_ACCEPT_CANCELLATION | AMAZON_WARRANTY
        | AMAZON_CONFIRM_DELIVERY_DETAILS | ... | SHOPEE_MARK_READ",
  "bodyText": "string?",
  "attachmentS3Keys": ["string"],
  "lastReadMessageId": "string?",
  "payload": {}
}
```
→ `data: ChannelActionResult` (`action`, `ok`, `message`, `routeUsed`,
`externalId`, `data`).

### GET /tickets/:id/messages
→ `data: MessageView[]`

---

## 4. Queue telemetry

### GET /queue/snapshot
→ `data: QueueSnapshot` — `{ stats: TicketStats, generatedAt }`

### GET /stats?marketplace=&accountId=
→ `data: TicketStats` —
`{ total, unread, openWaitingAgent, atRisk, breached, avgFirstResponseMinutes, avgResolutionMinutes, byMarketplace }`

### GET /channels/health
→ `data: ChannelHealthView[]` —
`{ marketplace, accountId, accountDisplayName, status, inboundHealthy, outboundHealthy, tokenExpiresAt, detail, crrPercent }`

### GET /health (public)
→ `data: HealthReport` (`status`, `uptimeSeconds`, `checks[]`, `channels[]`)

---

## 5. Account connection (onboarding UI)

### GET /accounts
→ `data: Array<{ id, marketplace, displayName, externalSellerId, marketplaceSiteId, status, channelConfig, tokenExpiresAt, authExpiresAt }>`

### GET /accounts/connectors
→ `data: ConnectorDescriptor[]` — drives the "Conectar loja" wizard:
`{ marketplace, authMode: OAUTH2|TOKEN_EXCHANGE|SMTP_SES|HYBRID, fields[],
authorizeUrlTemplate, webhookPath, docsUrl, notes[] }`.

Every `fields[]` entry: `{ key, label, type: text|password|url|email|select,
required, placeholder?, helpText?, options?, secret? }`.

### POST /accounts/oauth/:marketplace/start
Body: `{ "displayName": string }` (marketplace ∈ `mercadolivre`, `shopee`)
→ `data: { authorizeUrl, state, marketplace }`
The UI must redirect the browser to `authorizeUrl`.

### GET /accounts/oauth/:marketplace/callback
Query: provider params (`code`, `state`, Meli/Shopee extras).
On success redirects `302` to `${WEB_ORIGIN}/accounts?connected=<marketplace>`;
on failure `302 ... /accounts?error=<code>`.

### POST /accounts/connect
For Amazon (self-authorized LWA refresh token) and any manual token flow:
```json
{
  "marketplace": "AMAZON",
  "displayName": "Amazon BR - Loja Principal",
  "externalSellerId": "A2Q3Y263D00KWC",
  "marketplaceSiteId": "A2Q3Y263D00KWC",
  "refreshToken": "Atzr|...",
  "channelConfig": {
    "smtp_sender_email": "loja@minhamarca.com.br",
    "inbound_email_route": "amazon-relay@inbound.sachub.app",
    "approved_sender_domains": ["minhamarca.com.br"]
  }
}
```
→ `data: { accountId, displayName }`

### DELETE /accounts/:id
### POST /accounts/:id/refresh
→ `data: { ok: boolean, detail: string }`

---

## 6. Files (attachments)

### POST /files/upload (multipart/form-data, field `file`)
Limits: 10 MB (Amazon MIME cap), accepted `image/*`, `application/pdf`,
`text/plain`, `text/xml`, `application/xml`.
→ `data: { key, uri, fileName, mimeType, sizeBytes, sha256 }`
The returned `key` is what the UI sends as `attachmentS3Keys`.

### GET /files/signed?key=<key>
→ `data: { url }` (presigned GET, 5 min)

---

## 7. Webhooks (no auth, raw body preserved)

| Route | Verification | Success response |
|---|---|---|
| `POST /webhooks/mercadolivre` | optional shared secret header; idempotent on `_id` | `200 {"status":"OK"}` — must return in < 500 ms |
| `POST /webhooks/shopee` | `Authorization: HMAC-SHA256(webhookUrl + "|" + rawBody, partnerKey)`, `crypto.timingSafeEqual` | `200 {"status":"ACK"}` — < 100 ms |
| `POST /webhooks/amazon/ses` | `x-sac-signature: HMAC-SHA256(rawBody, AMAZON_SES_INBOUND_SHARED_SECRET)` | `200 {"status":"OK"}` |

Invalid signature → `401` and a `webhook_events` row with `signature_valid=false`.

---

## 8. Realtime (Socket.IO, path `/socket.io`)

Handshake auth: `{ auth: { token: "<JWT>" } }`.

Server → client events:
| event | payload |
|---|---|
| `ticket:updated` | `TicketRealtimeEvent` |
| `message:created` | `MessageRealtimeEvent` |
| `queue:changed` | `{ reason, ticketId?, at }` |
| `channel:health` | `ChannelHealthSnapshot` |
| `agent:presence` | `AgentPresenceEvent` |

Client → server:
- `subscribe` → `{ marketplaces?: Marketplace[], accountId?: string }`
- `presence:set` → `{ presence }`

The web app must degrade gracefully to polling (`GET /queue/snapshot` every 20 s)
when the socket cannot connect.
