-- Fase 4 - backup/restore por workspace.
--
-- `tenant_backups` is the INDEX of the JSON artifacts stored in object storage
-- (`backups/<tenantSlug>/<timestamp>.json`). `IObjectStorage` has no list
-- operation, so the console reads this table instead of listing the bucket.
--
-- Design notes
-- - The backup file itself lives in the bucket; Postgres only keeps the pointer,
--   the byte size, the per-table counts and the author (platform admin).
-- - `ON DELETE CASCADE`: purging a workspace (LGPD) also removes its backup
--   index rows; the objects are handled by the bucket lifecycle policy
--   (`BACKUP_RETENTION_DAYS`, documented in docs/PHASE4_PLATFORM.md).
-- - `agents.must_reset_password` marks an operator recreated by a RESTORE: the
--   password is random and never disclosed, so the next password reset is
--   mandatory. It is cleared automatically by `updatePassword`.
--
-- The migration is idempotent (`IF NOT EXISTS` + guarded FK) so it can be
-- applied on databases that were bootstrapped with `prisma db push`.

CREATE TABLE IF NOT EXISTS "tenant_backups" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "s3_key" VARCHAR(512) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "counts" JSONB NOT NULL DEFAULT '{}',
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tenant_backups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_backups_tenant_id_s3_key_key"
  ON "tenant_backups"("tenant_id", "s3_key");

CREATE INDEX IF NOT EXISTS "tenant_backups_tenant_id_created_at_idx"
  ON "tenant_backups"("tenant_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenant_backups_tenant_id_fkey'
  ) THEN
    ALTER TABLE "tenant_backups"
      ADD CONSTRAINT "tenant_backups_tenant_id_fkey"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "must_reset_password" BOOLEAN NOT NULL DEFAULT false;
