-- Fase 4 - provider-agnostic billing gateway audit/idempotency.
--
-- Billing reuses `webhook_events` instead of a new table: `(marketplace,
-- event_id)` already provides cross-process idempotency (`billing:<externalId>`)
-- and the LGPD purge already deletes rows by `tenant_id`. Billing rows are
-- stored with `marketplace = 'BILLING'` (no marketplace account, so
-- `account_id` stays NULL), `topic` = the normalized event type and `payload` =
-- the normalized payload (tenant, plan, amount, cycle end, external id).
--
-- PostgreSQL 12+ allows adding an enum value inside a transaction as long as
-- the new value is not used in the same transaction; Prisma migrate runs each
-- migration in its own transaction, so this is safe on the supported versions.
--
-- Rollback note: enum values cannot be dropped in place; reverting would
-- require recreating the enum type (not expected outside a development reset).

ALTER TYPE "Marketplace" ADD VALUE IF NOT EXISTS 'BILLING';

-- Console query: newest billing events first (tenant query is served by the
-- existing `(tenant_id, received_at)` index).
CREATE INDEX IF NOT EXISTS "webhook_events_marketplace_topic_idx"
  ON "webhook_events"("marketplace", "topic");
