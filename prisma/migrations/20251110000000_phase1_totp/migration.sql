-- Fase 1: 2FA TOTP.
-- The TOTP secret is stored encrypted by the existing AES-256-GCM cipher
-- (`two_factor_secret_enc`); recovery codes are only ever stored as SHA-256.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "two_factor_secret_enc" TEXT;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "two_factor_recovery_codes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "code_hash" VARCHAR(64) NOT NULL UNIQUE,
  "used_at" TIMESTAMPTZ(6) NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "two_factor_recovery_codes_user_id_idx"
  ON "two_factor_recovery_codes"("user_id");
