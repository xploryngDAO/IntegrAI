# SAC Hub — HTTP API contract (v1)

Base URL: `${APP_BASE_URL}/api/v1`.
All responses are `{ "data": ... }` on success and
`{ "error": { "code", "message", "details? } }` on failure.
All timestamps are ISO-8601 UTC strings. `Authorization: Bearer <JWT>` is
required for every route except `/health`, `/api/v1/auth/login`, the OAuth
callback and `/webhooks/*`.

Errors use the codes from `@sac/shared/errors.ts`
(`VALIDATION_ERROR`, `NOT_FOUND`, `AUTHENTICATION_ERROR`, `POLICY_VIOLATION`,
`RATE_LIMITED`, `MARKETPLACE_API_ERROR`, `INVALID_SIGNATURE`, `CONFLICT`,
`UNSUPPORTED_MEDIA_TYPE`).

Mutations under `/api/v1` (`POST`/`PUT`/`PATCH`) that carry a body must send
`Content-Type: application/json` (parameters such as `; charset=utf-8` are fine)
or a structured suffix `application/*+json`. Anything else is rejected with
**415** and `{ "error": { "code": "UNSUPPORTED_MEDIA_TYPE", "message":
"Content-Type must be application/json" } }`. `POST /files/upload`
(`multipart/form-data`), bodyless callbacks and `/webhooks/*` are exempt.

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
Limits: 10 MB (Amazon MIME cap). Allowlist: raster images (`jpeg`, `png`, `gif`,
`webp`, `bmp`, `tiff`), documents (`application/pdf`, `text/plain`, `text/csv`,
`text/xml`, `application/xml`, `doc/docx`, `xls/xlsx`) and `application/zip`.
Active content (`image/svg+xml`, `text/html`, `application/xhtml+xml`,
`application/javascript`) is rejected with **422** (`VALIDATION_ERROR`,
`Unsupported attachment mime type`).
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
---

## 9. Diagnóstico real das integrações

Estes endpoints fazem **chamadas reais** aos marketplaces (sem simulação) usando as
credenciais já cadastradas. Nada é enviado ao comprador: apenas token exchange e
leituras baratas (participações do seller, perfil do usuário, dados da loja).

### GET /diagnostics  (ADMIN)
→ `data: SystemDiagnosis`
`json
{
  "overall": "ok | warn | fail",
  "version": "1.0.0",
  "testedAt": "2026-11-05T18:00:00.000Z",
  "infrastructure": [
    { "id": "infra.postgres", "label": "PostgreSQL", "status": "ok", "detail": "ok", "latencyMs": 4 }
  ],
  "channels": [
    {
      "accountId": "uuid",
      "marketplace": "AMAZON",
      "displayName": "Amazon BR",
      "overall": "ok",
      "testedAt": "2026-11-05T18:00:00.000Z",
      "checks": [
        { "id": "amazon.lwa", "label": "LWA access token", "status": "ok", "detail": "token válido", "latencyMs": 210 },
        { "id": "amazon.participations", "label": "Seller participations", "status": "ok", "detail": "1 marketplace" }
      ]
    }
  ]
}
`

### POST /accounts/:id/diagnose  (ADMIN)
→ `data: AccountDiagnosis` (mesmo shape do item de `channels`).
Status de cada check: `ok | warn | fail | skipped`; `remediation` explica o que
corrigir. HTTP 200 mesmo com checks em `fail` (o corpo é o resultado), 404 para
conta inexistente.

### CLI equivalente
``bash
npm run doctor            # infra + todas as contas; exit 1 se algum check falhar
npm run doctor -- --account=<uuid>
``
---

## 12. Superfícies corporativas (2026-11)

### Cabeçalhos e correlação

- `x-request-id` (opcional no request; `[A-Za-z0-9._-]{8,128}`): o servidor devolve o
  mesmo valor em toda resposta; valores inválidos são substituídos por UUID.
- Erros incluem `error.requestId` (campo aditivo) com o mesmo id do header.
- Autenticação: `Authorization: Bearer <JWT>` exceto rotas públicas listadas abaixo.

### Observabilidade

- `GET /health` → liveness (`{status, services}`).
- `GET /health/ready` (e `/api/v1/health/ready`) → `{status:'ready'|'degraded', checks:{database,redis,storage}, errors?, requestId}`; 503 quando degradado.
- `GET /api/v1/metrics` → Prometheus `text/plain; version=0.0.4`; exige `METRICS_TOKEN`
  (`Authorization: Bearer` ou `x-metrics-token`); 404 quando o token não está configurado, 401 caso contrário.
- `GET /status` (público) → status agregado para a página pública.

### Autenticação em duas etapas

- `GET /auth/2fa/status` → `{enabled, recoveryCodesRemaining}`.
- `POST /auth/2fa/setup` → `{secret, otpauthUri}`; `POST /auth/2fa/verify` `{code}` → `{recoveryCodes}`.
- `POST /auth/2fa/disable` `{password, code}`; `POST /auth/2fa/recovery-codes/regenerate` `{password}` → novos códigos.
- Política do workspace: `GET/PATCH /tenants/me` (`require2fa: boolean`, ADMIN). Com a política ativa,
  login por senha sem TOTP responde **403 `TWO_FACTOR_SETUP_REQUIRED`** + `details.setupToken` (JWT 15 min).
- `POST /auth/2fa/enroll/setup` e `POST /auth/2fa/enroll/verify` (Bearer setupToken) habilitam o TOTP
  e devolvem `AuthResponse + recoveryCodes` (setup token single-use).
- Login com TOTP ativo responde **401 `TWO_FACTOR_REQUIRED`** + `challengeToken`; concluir em
  `POST /auth/2fa/challenge` `{challengeToken, code}` → `AuthResponse`.

### Sessões do operador

- `GET /auth/sessions` → `{items:[{id,createdAt,lastUsedAt,userAgent,ip,current}]}`.
- `DELETE /auth/sessions/:id` → 204 (sessão atual = logout).
- `POST /auth/sessions/revoke-others` → `{revoked}`.
- `POST /auth/logout` `{refreshToken?}` → 204; sem refreshToken = encerra todas as sessões (watermark).
- `PATCH /auth/me` `{name}` → agente atualizado.

### Administração (ADMIN do workspace)

- `GET /admin/overview` → métricas agregadas (usuários, sessões, convites, contas por canal, tickets, auditoria 24h).
- `GET /admin/users?search=&role=&status=&page=&perPage=` → `{items,total,page,perPage}`;
  `status` = `ACTIVE|INACTIVE`; `perPage` ≤ 100.
- `GET /admin/users/export.csv` → CSV com os mesmos filtros (auditado).
- `PATCH /admin/users/:id` `{role?, isActive?}` → 409 `CANNOT_MODIFY_SELF`, 409 `LAST_ADMIN_PROTECTED`.
- `POST /admin/users/:id/revoke-sessions` → `{revoked}`; 409 `CANNOT_REVOKE_OWN_SESSIONS`.
- `POST /admin/users/:id/reset-2fa` → `{id,twoFactorEnabled:false}`; 409 `CANNOT_RESET_OWN_2FA`/`TWO_FACTOR_NOT_ENABLED`.
- `GET /admin/invitations` → `{items:[{id,email,role,createdAt,expiresAt,acceptedAt,status}],total}`.
- `DELETE /admin/invitations/:id` → 204; 409 `INVITATION_ALREADY_ACCEPTED`.
- `POST /admin/invitations/:id/resend` → `{id,email,role,expiresAt,status}`; 502 `EMAIL_SEND_FAILED`.
- `GET /admin/sessions?page=&perPage=` → sessões ativas com `current`; `DELETE /admin/sessions/:id` → 204
  (409 `CANNOT_REVOKE_CURRENT_SESSION`).
- `GET /admin/audit-logs?action=&actorId=&from=&to=&page=&perPage=` → `{items,page,perPage,total}`.
- `GET /admin/audit-logs/export.csv` → CSV auditado (`admin.audit.exported`).

### SSO corporativo (OIDC)

- `GET/PUT/DELETE /tenants/me/sso` (ADMIN): conexão por tenant sem retornar segredo
  (`clientSecretConfigured`).
- `GET /auth/sso/discover?email=`; `GET /auth/sso/start` (302 ao IdP);
  `GET /auth/sso/callback` (302 ao SPA com `code` one-time); `POST /auth/sso/exchange` → `AuthResponse`.
- Erros: `SSO_NOT_CONFIGURED`, `SSO_STATE_INVALID`, `SSO_TOKEN_INVALID`, `SSO_EMAIL_UNVERIFIED`,
  `SSO_DOMAIN_NOT_ALLOWED`, `SSO_REQUIRED`, `INVALID_SSO_CODE`, etc.

### Integrações e billing

- `GET /platform/integration-setup?marketplace=` (platform admin) → guia de apps por canal
  (valores copiáveis, `missing`, `webhookSecretEnv`, sem segredos).
- `POST /api/v1/billing/webhook` (público, HMAC `x-billing-signature`) → processa eventos do gateway.
- Rotas de plataforma (`/platform/*`), LGPD (`/tenants/me/export`, `DELETE /tenants/me`, purge/restore/backup)
  exigem ADMIN/platform admin conforme o caso.

### Rate limits e segurança

- Login/2FA/SSO/enrollment têm buckets por IP/e-mail; `/health*`, `/status`, `/metrics` são isentos do limite global.
- `401` = não autenticado/expirado (renove via `POST /auth/refresh`); `403` = autenticado sem permissão;
  `429` = rate limit com `details.retryAfterMs` e header `Retry-After`.
