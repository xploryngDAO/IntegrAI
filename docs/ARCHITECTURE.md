# SAC Hub — Architecture

Event-driven, hexagonal (Ports & Adapters) omnichannel support hub integrating
**Amazon (SP-API + SES inbound relay + SMTP buyer-seller relay)**,
**Mercado Livre (official API)** and **Shopee (Open Platform v2)** into one
3-column operator workspace.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ apps/web  (React 18 + Vite + Tailwind) — Single Pane of Glass            │
│  Topbar telemetry │ Queue column │ Chat + adaptive composer │ Cockpit    │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ REST /api/v1 + Socket.IO (realtime queue/chat)
┌───────────────▼──────────────────────────────────────────────────────────┐
│ packages/server — Fastify 5                                               │
│  http/  controllers · routes · auth · ws hub · policy preview             │
│  application/  UnifiedTicketService · OutboundRouterService · SLA engine  │
│  adapters/  Amazon · MercadoLivre · Shopee (IMarketplaceChannelAdapter)   │
│  queues/  BullMQ producers + workers (inbound, enrichment, outbound, sla) │
│  infrastructure/ prisma · redis · redlock · token buckets · s3 · smtp     │
│  domain/  ports (from @sac/shared)                                        │
└───────┬────────────────────────────┬─────────────────────────────┬────────┘
        │                            │                             │
   PostgreSQL 16                 Redis 7                     S3 / MinIO
   (unified model, JSONB)   cache·locks·idempotency·       (.eml, NF-e,
                            rate limits·presence            evidences)
        │
   BullMQ queues: queue.inbound.amazon | queue.inbound.meli | queue.inbound.shopee
                  queue.spapi.enrichment | queue.outbound.dispatch
                  queue.sla.scan | queue.pii.purge | queue.shopee.lost-push
                  queue.token.refresh | queue.dlq
```

## Golden rules enforced by this codebase

1. **Webhooks never block.** The controller routes through
   `IWebhookIngressService.accept()` which verifies the signature in-process,
   claims an idempotency key in Redis (`SET NX EX 86400`) and publishes to the
   inbound queue. Budgets: Meli `< 500ms`, Shopee `< 100ms`, Amazon relay `< 1s`.
2. **No polling of IMAP.** Amazon inbound is an HTTP relay that receives the raw
   MIME message, stores the immutable `.eml` in S3 (`body_raw_s3_uri`) and
   enqueues it.
3. **All outbound messages are routed by policy, not by UI choice.** The
   composer only *previews* the decision (`resolveRoute`); `OutboundRouterService`
   recomputes it server-side before sending.
4. **PII is volatile.** Amazon restricted data (buyer name/document/address/phone)
   is fetched with an RDT, cached in Redis with short TTL, mirrored to
   `buyer_pii_vault` with `expires_at = shipment + 30 days`, hard-purged by
   `queue.pii.purge`. It is never stored on `support_tickets`.
5. **Threads are ordered by the marketplace clock** (`marketplace_created_at`),
   never by our ingestion time.
6. **Every outbound call is auditable** (`outbound_attempts`: route, HTTP status,
   duration, error code) and every inbound webhook is persisted
   (`webhook_events`) for replay.

## Repository layout

```
prisma/                       schema.prisma + seed.ts (demo data for all 3 channels)
packages/shared/src/          @sac/shared — the contract package (Lead-owned)
  enums.ts                    every enum/union + UI labels
  dto.ts                      persistence records + JSON API projections
  adapter.ts                  IMarketplaceChannelAdapter, AdapterDependencies, drafts
  ports/infra.ts              cache, lock, rate limiter, storage, crypto, http, queue, realtime, logger
  ports/repositories.ts       repository ports (implemented by core-engine)
  ports/services.ts           application service ports + IAppServices container type
  compliance.ts               cross-channel outbound policy engine + PII redaction
  constants.ts                queue names, cache keys, SLA defaults, retry policies
packages/server/src/
  config/                     env parsing (zod) -> ChannelRuntimeConfig
  infrastructure/             prisma client, redis cache, redlock, token bucket, s3, smtp, crypto, http
  application/repositories/   Prisma implementations of the shared repository ports
  application/mappers/        record -> view mappers (TicketListItem, TicketDetail, OrderView…)
  application/sla/            SlaEngine (deadlines, priority, queue, breach state)
  application/                UnifiedTicketService, OutboundRouterService, WebhookIngressService,
                              AccountService, AgentService, TicketQueryService, HealthService,
                              FileService
  adapters/amazon/            LWA + RDT + SP-API messaging + SES relay parsing
  adapters/mercadolivre/      OAuth refresh + questions/messages/claims
  adapters/shopee/            HMAC sign + Redlock refresh + sellerchat/returns/logistics
  queues/                     BullMQ connection, producers, workers, schedulers, dlq
  http/                       Fastify app, routes, controllers, middleware, socket hub
  container.ts                dependency graph
  index.ts                    bootstrap: http + workers + crons
apps/web/                     React SPOG (see docs/UI_SPEC.md)
```

## Module ownership map

| Module | Responsibility |
|---|---|
| `packages/shared` | frozen cross-layer contract: enums, DTOs, ports, policy engine, constants |
| `packages/server/src/config` + `infrastructure` + `application/repositories` | env config, Redis/Prisma/S3/crypto/HTTP/BullMQ plumbing, Prisma persistence |
| `packages/server/src/application` (services, SLA) + `queues` | ticket/outbound/webhook/account/query services, SLA engine, workers and schedulers |
| `packages/server/src/http` | Fastify app, REST routes, webhook controllers, JWT middleware, Socket.IO hub |
| `packages/server/src/adapters/*` | one strategy per marketplace (hydration, routing, sanitisation, uploads) |
| `apps/web/src/lib` + `components/ui` | API client, store, tema, design system |
| `apps/web/src/components/queue` | SLA-ordered unified queue |
| `apps/web/src/components/chat` + `cockpit` + `accounts` | conversation, adaptive composer, 360º cockpit, onboarding |
| `prisma/` | unified schema, migration, demo seed |
| `docs/` | architecture, API contract, channel contracts, UI spec |

## Failure & back-pressure behaviour

- BullMQ workers use exponential backoff **with full jitter**
  (`computeBackoffDelay` in `@sac/shared`) and a bounded attempt count, then move
  the payload to `queue.dlq` with the original error context.
- Outbound sends are guarded by per-bucket **token buckets** in Redis
  (`sac:ratelimit:*`): Amazon proactive messaging 1 req/s, SP-API orders
  0.5 req/s (burst 10), Meli 10 req/s, Shopee 5 req/s.
- Token refreshes are serialized with a **Redlock quorum** over
  `lock:shopee:refresh:<accountId>` / `lock:meli:refresh:<accountId>` because
  Shopee refresh tokens are single-use.
- Inbound idempotency: Redis `SET NX EX 86400` per `message_id`/`event_id` plus
  a unique index on `ticket_messages.external_message_id`. Replays are recorded
  as `webhook_events.status = DUPLICATE` and acknowledged with 200.
- A circuit-breaker style health snapshot per account is published on
  `/api/v1/channels/health` and over the `channel:health` socket event.
