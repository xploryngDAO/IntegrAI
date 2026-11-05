-- Fase 1: tabelas de contas self-service.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMPTZ(6);
UPDATE "agents" SET "email_verified_at" = now() WHERE "email_verified_at" IS NULL;

CREATE TABLE IF NOT EXISTS "invitations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "email" VARCHAR(180) NOT NULL,
  "role" "AgentRole" NOT NULL DEFAULT 'AGENT',
  "token_hash" VARCHAR(128) NOT NULL,
  "invited_by" UUID NULL REFERENCES "agents"("id") ON DELETE SET NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "accepted_at" TIMESTAMPTZ(6) NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_tenant_id_email_key" ON "invitations"("tenant_id","email");
CREATE INDEX IF NOT EXISTS "invitations_token_hash_idx" ON "invitations"("token_hash");

CREATE TABLE IF NOT EXISTS "password_resets" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "token_hash" VARCHAR(128) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6) NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "password_resets_user_id_idx" ON "password_resets"("user_id");
CREATE INDEX IF NOT EXISTS "password_resets_token_hash_idx" ON "password_resets"("token_hash");

CREATE TABLE IF NOT EXISTS "email_verifications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "token_hash" VARCHAR(128) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6) NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "email_verifications_user_id_idx" ON "email_verifications"("user_id");
CREATE INDEX IF NOT EXISTS "email_verifications_token_hash_idx" ON "email_verifications"("token_hash");

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "tenant_id" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "refresh_token_hash" VARCHAR(128) NOT NULL UNIQUE,
  "user_agent" VARCHAR(255) NULL,
  "ip" VARCHAR(64) NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6) NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX IF NOT EXISTS "sessions_tenant_id_idx" ON "sessions"("tenant_id");