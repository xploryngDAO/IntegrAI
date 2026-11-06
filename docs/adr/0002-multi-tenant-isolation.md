# ADR-0002 — Isolamento multi-tenant por `tenant_id` e escopo no JWT

## Status

Aceito

## Data

2026-11-06

## Contexto

O IntegrAI é um SaaS com vários workspaces (`tenants`) no mesmo banco
PostgreSQL. Cada workspace tem operadores, lojas conectadas com tokens
cifrados, pedidos, atendimentos, mensagens, anexos e trilha de auditoria. Um
vazamento horizontal (IDOR) entre workspaces exporia conversas, PII de
compradores e credenciais de marketplace — além de ser um incidente LGPD.

O modelo precisa responder a três perguntas ao mesmo tempo: (a) nenhuma query
de cliente pode cruzar a fronteira do workspace; (b) a exclusão de um workspace
precisa ser fisicamente possível sem deixar PII para trás; (c) o console de
plataforma precisa de acesso cross-tenant explícito, sem transformar isso no
caminho normal.

## Decisão

1. **`tenants` é a raiz do modelo.** `id`, `slug` único, `status`
   (`ACTIVE`/`SUSPENDED`/`DELETED`) e `deleted_at` (soft delete). Toda tabela de
   cliente carrega `tenant_id`.
2. **O banco impõe a fronteira nas tabelas centrais.** A migration
   `prisma/migrations/20251108000000_tenant_not_null/migration.sql`:
   - faz backfill dos órfãos para o tenant de bootstrap;
   - aplica `NOT NULL` em `agents.tenant_id`, `marketplace_accounts.tenant_id` e
     `support_tickets.tenant_id`;
   - cria FK para `tenants(id)` com `ON DELETE RESTRICT`.
   `webhook_events.tenant_id` permanece **nullable de propósito**: um evento
   rejeitado antes de resolver a conta não pertence a workspace nenhum e é
   auditoria global.
3. **Tabelas derivadas herdam o escopo pela FK do pai.** `orders_cache`,
   `ticket_messages`, `message_attachments`, `buyer_pii_vault`,
   `ticket_events` e `outbound_attempts` chegam ao tenant pelo atendimento/conta
   com `ON DELETE CASCADE`; não duplicam `tenant_id`. Onde há consulta direta
   por tenant, existem índices compostos: `invitations(tenant_id, email)` único,
   `sessions(tenant_id)`, `marketplace_accounts(tenant_id, status)`,
   `support_tickets(tenant_id, status)`, `webhook_events(tenant_id, received_at)`
   e `audit_events(tenant_id, created_at)`.
4. **O escopo vem do JWT, não da requisição.** O token é emitido com
   `issuer: sac-hub`, `audience: sac-web` e as claims `sub` e `tenantId`
   (`AgentService`). O middleware (`http/middleware/auth.ts`) expõe
   `requireTenantId`, `requireRole` e `requirePlatformAdmin`; `assertTenantActive`
   rejeita workspace `SUSPENDED`/`DELETED` no próximo request. Rotas
   administrativas filtram sempre por `claims.tenantId` e respondem **404**
   (não 403) para recurso de outro workspace. `is_platform_admin` é relido do
   banco a cada request e é o único caminho cross-tenant.
5. **Teste de isolamento como contrato.** `scripts/isolation-test.mjs` cria um
   segundo tenant com conta, operador, ticket, convite, evento de auditoria e
   sessão, autentica no tenant A e verifica 14 pontos: lista de contas, fila e
   detalhe de ticket, mutação, usuários, convites, auditoria, sessões, CSV,
   patch de usuário, revogação de convite/sessão e cleanup. O job `Security`
   (`.github/workflows/security.yml`) roda esse script contra a API local após
   `prisma migrate deploy` + seed.
6. **Purge e LGPD.**
   - `GET /api/v1/tenants/me/export` exporta o workspace sem credenciais e sem
     `buyer_pii_vault`, com flag `truncated` (limites de 1.000 tickets / 5.000
     mensagens).
   - `DELETE /api/v1/tenants/me` exige senha do ADMIN + slug exato e faz soft
     delete (`status = DELETED`, `deleted_at`); a exclusão física fica agendada
     para o job diário `queue.tenant.purge` (03:00), que varre os workspaces
     fora da carência.
   - `TenantPurgeService` roda diariamente às 03:00, respeita carência de 30 dias
     (`TENANT_PURGE_RETENTION_DAYS`), apaga primeiro os objetos S3 e depois o
     banco em transação por tenant; falha de storage não impede o purge
     relacional (objetos órfãos são logados). Existe purge manual por platform
     admin, sempre exigindo soft delete prévio.
   - PII de comprador expira em `shipment + 30 dias` e é removida por
     `queue.pii.purge` (a cada 6 h); `TenantPrivacyService` cobre exportação.
   - `TenantBackup` é sempre por tenant e o restore cria um workspace **novo**,
     nunca sobrescreve outro (`docs/PHASE4_BACKUP_RESTORE.md`).

> Nota de implementação: no `prisma/schema.prisma`, `Agent.tenantId`,
> `MarketplaceAccount.tenantId` e `SupportTicket.tenantId` ainda aparecem como
> `String?`; a autoridade do `NOT NULL` é a migration acima. A divergência é
> conhecida e deve ser observada em qualquer `prisma migrate diff`.

## Alternativas consideradas

- **Banco (ou schema) por tenant.** Isolamento físico mais forte, mas
  multiplica migrações, conexões e operação; o console de plataforma e o billing
  teriam de consultar N bancos. Rejeitado para o estágio atual.
- **Row Level Security (RLS) do PostgreSQL.** Defesa em profundidade real, mas
  exigiria `SET LOCAL`/role por request no pool do Prisma e não há policy RLS nas
  migrations hoje. Ficou como evolução possível; a decisão atual é isolamento
  aplicacional + constraint no banco.
- **Confiar apenas no filtro da aplicação, sem FK/NOT NULL.** Menor atrito de
  schema, mas permite linha órfã e perde a rede de segurança do banco.
  Rejeitado.
- **Colocar `tenant_id` em todas as tabelas derivadas.** Simplificaria algumas
  queries, mas duplicaria a fonte de verdade e criaria risco de divergência com
  o pai; a FK em cascata foi preferida.

## Consequências

**Positivas**

- Um único banco e um único conjunto de migrações; operação e backup simples.
- A FK + `NOT NULL` impede órfãos nas tabelas centrais e o `RESTRICT` obriga um
  purge consciente antes de remover o tenant.
- O escopo no JWT elimina `tenantId` vindo do body/query como fonte de verdade;
  o platform admin é explícito e auditável.
- O teste de isolamento roda no CI e cobre leitura, mutação, CSV e sessões, não
  apenas o caminho feliz.
- Export, soft delete, purge físico e restore por tenant formam um ciclo LGPD
  completo e documentado.

**Negativas**

- O isolamento é **aplicacional**: uma única query sem `WHERE tenant_id` é um
  vazamento. O teste de 14 checagens é a rede disponível; RLS ainda não existe.
- A divergência entre o schema Prisma (`String?`) e o banco (`NOT NULL`) pode
  enganar o client e gerar drift em `prisma migrate diff`.
- `ON DELETE RESTRICT` faz o purge depender de uma ordem correta de exclusão;
  qualquer tabela nova precisa ser incluída no `TenantPurgeService`.
- Backup e export carregam dados sensíveis; a retenção/cópia off-site é
  responsabilidade operacional (`docs/RUNBOOK.md`).
- `webhook_events` sem tenant exige tratamento à parte no purge e nas consultas
  globais.

## Referências

- [`prisma/schema.prisma`](../../prisma/schema.prisma) — `Tenant`, campos
  `tenant_id`, índices e relações.
- [`prisma/migrations/20251108000000_tenant_not_null/migration.sql`](../../prisma/migrations/20251108000000_tenant_not_null/migration.sql).
- [`packages/server/src/http/middleware/auth.ts`](../../packages/server/src/http/middleware/auth.ts)
  e [`packages/server/src/application/AgentService.ts`](../../packages/server/src/application/AgentService.ts).
- [`scripts/isolation-test.mjs`](../../scripts/isolation-test.mjs).
- [`packages/server/src/application/TenantPurgeService.ts`](../../packages/server/src/application/TenantPurgeService.ts)
  e [`packages/server/src/application/TenantPrivacyService.ts`](../../packages/server/src/application/TenantPrivacyService.ts).
- [`docs/SECURITY.md`](../SECURITY.md) §3.7 e §8 (checklist LGPD).
- [`docs/PHASE4_BACKUP_RESTORE.md`](../PHASE4_BACKUP_RESTORE.md).
