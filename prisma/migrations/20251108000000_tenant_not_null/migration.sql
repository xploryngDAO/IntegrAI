-- Fase 0: tenant_id obrigatorio para dados de cliente.
-- webhook_events permanece NULLABLE de proposito: eventos rejeitados antes de
-- resolver a conta nao pertencem a nenhum tenant (auditoria global).
UPDATE "webhook_events" SET "tenant_id" = '00000000-0000-4000-8000-000000000001' WHERE "tenant_id" IS NULL;

ALTER TABLE "agents" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "marketplace_accounts" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "support_tickets" ALTER COLUMN "tenant_id" SET NOT NULL;

ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marketplace_accounts" ADD CONSTRAINT "marketplace_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;