-- Fase 4: platform console (plans/quotas), platform administrators and the
-- LGPD soft-delete marker.
--
-- Design notes
-- - `plan` is the commercial label; `max_accounts`/`max_agents` are the
--   EFFECTIVE quotas. Keeping them as columns lets the console grant a one-off
--   quota (or a practically unlimited ENTERPRISE workspace) without a deploy.
-- - Existing tenants get the FREE defaults (1 account / 3 agents); existing
--   operators start as non-platform-admins. The seed grants the flag to
--   `ADMIN_EMAIL` (and every address listed in `PLATFORM_ADMIN_EMAILS`).
-- - `deleted_at` is a soft delete: accounts/tickets are preserved for audit and
--   the physical purge (right to erasure) remains a future platform job.

DO $$
BEGIN
  CREATE TYPE "TenantPlan" AS ENUM ('FREE', 'PRO', 'ENTERPRISE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "plan" "TenantPlan" NOT NULL DEFAULT 'FREE';
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "max_accounts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "max_agents" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "is_platform_admin" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "tenants_status_idx" ON "tenants"("status");
CREATE INDEX IF NOT EXISTS "tenants_deleted_at_idx" ON "tenants"("deleted_at");
CREATE INDEX IF NOT EXISTS "agents_is_platform_admin_idx" ON "agents"("is_platform_admin");
