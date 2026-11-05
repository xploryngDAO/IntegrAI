-- Remove o modo de demonstração.
-- Atendimentos, pedidos e lojas passam a existir exclusivamente a partir dos
-- marketplaces reais (webhooks + OAuth). Não há mais dados sintéticos no banco.
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "is_demo";
