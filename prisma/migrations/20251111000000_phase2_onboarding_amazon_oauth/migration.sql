-- Fase 2: guided onboarding completion marker on the tenant.
-- The wizard is always re-runnable; this column only records the first time the
-- workspace finished it (cleared when the operator explicitly restarts it).
-- Amazon SP-API OAuth itself needs no schema change: the refresh token already
-- lives encrypted in `marketplace_accounts.refresh_token_enc` and the seller id
-- in `external_seller_id`/`channel_config`.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" TIMESTAMPTZ(6);
