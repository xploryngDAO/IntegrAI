-- Workspace 2FA policy (`require_2fa`).
--
-- When true, a password login of a member WITHOUT an active TOTP factor is
-- answered `403 TWO_FACTOR_SETUP_REQUIRED` with a short-lived `setupToken`; no
-- access/refresh session is issued until the operator completes
-- `POST /auth/2fa/enroll/setup` + `/auth/2fa/enroll/verify`.
--
-- SSO logins are intentionally exempt: the second factor is delegated to the
-- workspace IdP (see docs/ENTERPRISE_SSO.md). Existing rows default to false, so
-- the migration is behaviour-preserving for every live workspace.
--
-- Idempotent (`IF NOT EXISTS`) for databases bootstrapped with `prisma db push`.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "require_2fa" BOOLEAN NOT NULL DEFAULT false;
