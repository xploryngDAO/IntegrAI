-- Fase 4: billing base for the platform console (subscription state, trial end
-- and billing contact). No payment gateway is integrated here: this migration
-- only adds the columns the future integration will read/write.
--
-- Design notes
-- - `billing_status` defaults to TRIALING so every existing workspace keeps
--   operating while the commercial status is filled in by the console.
-- - `trial_ends_at` is nullable: a workspace can be on a non-time-boxed plan
--   (FREE/PRO/ENTERPRISE) or have no trial scheduled.
-- - `billing_email` is nullable and independent from the ADMIN login e-mail, so
--   finance can receive invoices without owning an operator account.

DO $$
BEGIN
  CREATE TYPE "BillingStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "billing_status" "BillingStatus" NOT NULL DEFAULT 'TRIALING';
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "trial_ends_at" TIMESTAMPTZ(6);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_email" VARCHAR(180);

CREATE INDEX IF NOT EXISTS "tenants_billing_status_idx" ON "tenants"("billing_status");
