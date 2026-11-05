-- Fase 0 (multi-tenant): cria a tabela de tenants e adiciona tenant_id aos
-- dados de cliente. Colunas ficam NULLABLE nesta etapa (backfill do tenant
-- default); a troca para NOT NULL acontece quando todo o código gravar o tenant.

CREATE TABLE IF NOT EXISTS "tenants" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" VARCHAR(80) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_key" ON "tenants"("slug");

-- Tenant default que herda todos os dados existentes (operacao atual).
INSERT INTO "tenants" ("id", "slug", "name", "status")
VALUES ('00000000-0000-4000-8000-000000000001', 'integrai', 'IntegrAI', 'ACTIVE')
ON CONFLICT ("slug") DO NOTHING;

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "marketplace_accounts" ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "tenant_id" UUID;
ALTER TABLE "webhook_events" ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

UPDATE "agents" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "marketplace_accounts" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "support_tickets" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;
UPDATE "webhook_events" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;

CREATE INDEX IF NOT EXISTS "agents_tenant_id_idx" ON "agents"("tenant_id");
CREATE INDEX IF NOT EXISTS "marketplace_accounts_tenant_id_status_idx" ON "marketplace_accounts"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "support_tickets_tenant_id_status_idx" ON "support_tickets"("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "webhook_events_tenant_id_received_at_idx" ON "webhook_events"("tenant_id", "received_at");