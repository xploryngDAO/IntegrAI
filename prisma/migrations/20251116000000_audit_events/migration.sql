-- Administrative/security audit trail + refresh-session last-use marker.
--
-- Decisões
-- - `tenant_id` é NULLABLE com `ON DELETE SET NULL`: a linha de auditoria
--   sobrevive à remoção (soft delete ou purga LGPD) do workspace que descreve.
-- - `actor_id` é UUID sem FK: o operador pode ser removido por restore/purge e
--   o trail precisa manter o id original como valor de exibição.
-- - `metadata` JSONB é higienizado na aplicação (`AuditService`) antes do
--   insert: chaves de senha/token/segredo são descartadas e padrões de e-mail/
--   telefone são redigidos, para a tabela não virar um segundo depósito de PII.
-- - `last_used_at` em `sessions` é o marcador de rotação do refresh token
--   exibido por `GET /auth/sessions` (NULL = nunca rotacionada).
--
-- A migration é idempotente (`IF NOT EXISTS` + constraint guardada) para bancos
-- criados com `prisma db push`.

CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" UUID NOT NULL,
  "tenant_id" UUID,
  "actor_id" UUID,
  "actor_email" VARCHAR(180),
  "action" VARCHAR(96) NOT NULL,
  "resource_type" VARCHAR(80),
  "resource_id" VARCHAR(180),
  "ip" VARCHAR(64),
  "user_agent" VARCHAR(255),
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- Console query: one workspace, newest first.
CREATE INDEX IF NOT EXISTS "audit_events_tenant_id_created_at_idx"
  ON "audit_events"("tenant_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "audit_events_action_idx"
  ON "audit_events"("action");

CREATE INDEX IF NOT EXISTS "audit_events_actor_id_idx"
  ON "audit_events"("actor_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'audit_events_tenant_id_fkey'
  ) THEN
    ALTER TABLE "audit_events"
      ADD CONSTRAINT "audit_events_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- Refresh-session read model (`GET /auth/sessions`).
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMPTZ(6);
