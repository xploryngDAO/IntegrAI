# Fase 4 — Plataforma e operação (design)

> Pré-requisito: Fases 0–3. Cada dado de cliente já é isolado por `tenant_id`.
> Objetivo: operar o SaaS — planos, limites, console interno, métricas e os
> direitos LGPD de exportação/eliminação por tenant.

## Escopo entregue

| Área | Entrega |
|---|---|
| Schema | `tenants.plan` (`TenantPlan`), `max_accounts`, `max_agents`, `deleted_at`, `billing_status` (`BillingStatus`), `trial_ends_at`, `billing_email`; `agents.is_platform_admin` |
| Limites | `max_agents` ao convidar/aceitar convite; `max_accounts` ao conectar loja nova |
| Console | `GET /platform/tenants` (paginação + busca + billing prefill), `PATCH /platform/tenants/:id`, `GET /platform/metrics`, `GET /platform/tenants/:id/metrics`, `GET /platform/alerts`, `POST /platform/tenants/:id/purge` |
| Billing (base) | `GET /platform/billing/summary` (MRR por plano), `PATCH /platform/tenants/:id/billing`; preços em `shared/plans.ts`; `billingStatus`/`trialEndsAt`/`billingEmail` no item da listagem |
| LGPD | `GET /tenants/me/export`, `DELETE /tenants/me` (soft delete), purga física diária (`queue.tenant.purge`) + purga manual, com remoção dos objetos S3 do workspace antes do delete transacional |
| Status page | `GET /status` e `GET /api/v1/status` públicos (probes de infra + contadores agregados por canal) |
| Sessão | tenant `SUSPENDED`/`DELETED` responde `403 TENANT_INACTIVE` no login e em toda requisição |

Fora do escopo desta fase (backlog): integração com gateway de pagamento
(Stripe/Pagar.me etc.), backup/restore por tenant e UI do console.

## Modelo de dados

```
tenants
  plan           TenantPlan    FREE | PRO | ENTERPRISE   (default FREE)
  max_accounts   INT           quota efetiva             (default 1)
  max_agents     INT           quota efetiva             (default 3)
  billing_status BillingStatus TRIALING | ACTIVE | PAST_DUE | CANCELED (default TRIALING)
  trial_ends_at  TIMESTAMPTZ   fim do trial              (default NULL)
  billing_email  VARCHAR(180)  contato financeiro        (default NULL)
  deleted_at     TIMESTAMPTZ   soft delete LGPD          (default NULL)
  status         VARCHAR       ACTIVE | SUSPENDED | DELETED

agents
  is_platform_admin BOOLEAN (default false)
```

Decisões:

1. **Plano é rótulo; quota efetiva é coluna.** O console altera
   `max_accounts`/`max_agents` sem criar plano novo (contrato enterprise,
   cortesia, incidente). `PLAN_LIMITS` só define os defaults aplicados ao criar
   o tenant ou ao trocar o plano.
2. **ENTERPRISE = praticamente ilimitado por número alto** (`1_000_000`), não
   por coluna nula: limite, console e export usam um único caminho de código.
3. **Defaults**: FREE 1 conta/3 operadores; PRO 10/25; ENTERPRISE ilimitado.
4. **Platform admin não é papel de tenant.** É um flag de operador concedido
   apenas pelo seed (`ADMIN_EMAIL` + `PLATFORM_ADMIN_EMAILS`); nunca por signup,
   convite ou `PATCH /users`.
5. **Flag conferido no banco a cada request** de `/platform/*` — o claim do JWT
   serve só para a UI. Revogar o flag vale imediatamente.
6. **Migração manual** em `prisma/migrations/20251112000000_phase4_platform_plans`
   com `IF NOT EXISTS`, backfill implícito (FREE/1/3/false) e índices.
7. **Billing é base de cobrança, não gateway.** `billing_status`/`trial_ends_at`/
   `billing_email` são persistidos pelo console; nenhum provedor é chamado. O
   preço mensal de tabela vive em `PLAN_MONTHLY_PRICE_BRL` (`shared/plans.ts`:
   FREE 0, PRO 299, ENTERPRISE 1.499 BRL) e é a única fonte do MRR.
8. **Alertas são derivados, não persistidos.** Não existe tabela de alertas: o
   console lê contas, quotas, SLA e convites no momento da consulta. Isso evita
   um job de reconciliação e nunca mostra um alerta obsoleto; em troca, o custo
   é uma leitura por chamada (cache é otimização futura).

## Limites (quota)

`PlanLimitService` é o único gate:

| Ação | Regra |
|---|---|
| `POST /invitations` | `agentes ativos + convites pendentes < max_agents` (convite pendente reserva assento) |
| `POST /auth/accept-invitation` | `agentes ativos < max_agents` (o tenant pode ter mudado de plano) |
| Conectar loja nova (OAuth/credenciais) | `contas do tenant < max_accounts`; reconectar a mesma loja não consome quota |

Excedeu → `409 PLAN_LIMIT_REACHED` com
`details = { plan, limit, current, resource }` (`resource` = `agents` | `accounts`).

Contagens vêm de `IPlatformRepository.usageFor` (`groupBy` por `tenant_id`), sem
carregar linhas de negócio. Conta desconectada continua ocupando a quota até ser
removida (o operador pode liberar espaço).

## Console interno (`/api/v1/platform`)

Autenticação: JWT normal **+ `agents.is_platform_admin`**. Sem o flag → `403`
`AUTHORIZATION_ERROR` (mesmo para ADMIN de tenant).

### `GET /platform/tenants?page=&pageSize=&search=`
`{ data: { items, total, page, pageSize, totalPages } }`, mais recente primeiro.
Cada item:

```json
{
  "id": "...", "slug": "acme", "name": "Acme",
  "plan": "PRO", "status": "ACTIVE",
  "limits": { "maxAccounts": 10, "maxAgents": 25 },
  "counts": { "accounts": 3, "agents": 5, "tickets": 40 },
  "onboardingCompletedAt": null, "deletedAt": null,
  "createdAt": "2026-11-01T10:00:00.000Z",
  "billingStatus": "ACTIVE",
  "trialEndsAt": "2026-12-01T00:00:00.000Z",
  "billingEmail": "finance@acme.test"
}
```

`search` (opcional, 1..120 chars) é aplicado **no servidor**: `contains`
case-insensitive em `name` **OU** `slug`. Um `?search=` vazio é tratado como
ausência de filtro; acima de 120 chars → `422`. `total`/`totalPages` refletem o
conjunto filtrado (o `count` usa o mesmo `where` do `findMany`), e só os itens da
página consultam contagens de uso.

Os três campos de billing (`billingStatus`, `trialEndsAt`, `billingEmail`) são o
**prefill** do formulário de assinatura: a listagem devolve o mesmo estado que
`PATCH /platform/tenants/:id/billing` persiste, sem uma segunda requisição por
workspace. `trialEndsAt`/`billingEmail` são `null` quando não definidos (nunca
`undefined`). O `select` do Prisma é explícito (`TENANT_LIST_SELECT`), então um
campo novo em `TenantRecord` falha a compilação em vez de virar `undefined` no
JSON.

### `POST /platform/tenants/:id/purge`
Purga física **manual** (LGPD) de um workspace já soft-deleted.

- 200 com o resultado da purga (`tenantId`, `slug`, `deletedAt`, `purgedAt`,
  `counts` por tabela, `manual: true`).
- `404` workspace desconhecido; `409 CONFLICT` (`details.code =
  TENANT_NOT_DELETED`) quando `deleted_at` é `null` — a purga manual ignora o
  prazo de 30 dias, mas nunca apaga um workspace ativo.
- A rota é `JWT + is_platform_admin`; o job diário usa o mesmo serviço.

### `PATCH /platform/tenants/:id`
Body `{ plan?, maxAccounts?, maxAgents?, status? }` (`.strict()`, ao menos um).

- Trocar **só** `plan` realinha as quotas aos defaults do plano; `max*` explícito
  na mesma requisição vence (contrato customizado).
- `status` aceita apenas `ACTIVE | SUSPENDED`. `DELETED` só existe pelo fluxo
  LGPD — um tenant excluído não é reativado pelo console (`409 CONFLICT`).
- 404 tenant desconhecido, 422 body inválido/quota < 1.

### `GET /platform/metrics`
```json
{
  "generatedAt": "...",
  "totalTenants": 12, "activeTenants": 9,
  "accountsByMarketplace": { "AMAZON": 3, "MERCADO_LIVRE": 7, "SHOPEE": 2 },
  "totalAccounts": 12,
  "openTickets": 41,
  "messagesLast24h": 512,
  "slaAtRisk": 6,
  "slaRiskHorizonMinutes": 120
}
```

Definições: `activeTenants` = `status = ACTIVE AND deleted_at IS NULL`;
`openTickets` = status não terminais (`UNREAD`, `OPEN_WAITING_AGENT`,
`WAITING_BUYER`, `MEDIATION`); `messagesLast24h` = mensagens criadas nas últimas
24 h; `slaAtRisk` = ticket aberto, ainda não `sla_breached`, com
`sla_deadline_at <= agora + 120 min` (inclui atrasado ainda não marcado).

### `GET /platform/tenants/:id/metrics`
Snapshot operacional de **um** workspace. Todas as agregações usam
`tenant_id` (mensagens são escopadas pela relação `ticket`); nenhuma linha de
negócio é carregada para a memória, exceto os buckets agregados no Postgres.

```json
{
  "accounts": 3, "agents": 5,
  "ticketsByStatus": {
    "UNREAD": 2, "OPEN_WAITING_AGENT": 1, "WAITING_BUYER": 4,
    "NO_RESPONSE_NEEDED": 1, "MEDIATION": 3, "RESOLVED": 9
  },
  "openTickets": 10,
  "slaAtRisk": 6,
  "slaBreached": 2,
  "avgFirstResponseMinutes": 42.3,
  "messagesLast7d": 120,
  "ticketsLast14d": [{ "date": "2026-10-23", "count": 0 }],
  "plan": "PRO",
  "limits": { "maxAccounts": 10, "maxAgents": 25 },
  "usagePct": { "accounts": 30, "agents": 20 }
}
```

Definições:

- `accounts`/`agents`: linhas do tenant (inclui conta desconectada/operador
  inativo, igual à quota — remover é o que libera espaço).
- `ticketsByStatus`: **todos** os status, com zero quando não há ticket.
- `openTickets`: soma de `UNREAD`, `OPEN_WAITING_AGENT`, `WAITING_BUYER` e
  `MEDIATION`.
- `slaAtRisk`: mesma regra do métrico global, restrita ao tenant (aberto, não
  marcado como breached, `sla_deadline_at <= agora + 120 min`).
- `slaBreached`: tickets com `sla_breached = true` (qualquer status).
- `avgFirstResponseMinutes`: média de `first_response_at - created_at` em
  minutos, arredondada a 1 casa; `null` quando nenhum ticket foi respondido.
- `messagesLast7d`: janela móvel de 7 dias (mensagens via `ticket_id`).
- `ticketsLast14d`: 14 dias de calendário **UTC**, do mais antigo para hoje,
  com dias sem ticket preenchidos com zero.
- `usagePct`: percentual inteiro arredondado de `max_accounts`/`max_agents`;
  pode passar de 100 (a quota é um gate, não uma trava retroativa).
- `404` para workspace desconhecido. Workspace soft-deleted ainda pode ser
  inspecionado pelo console (o dado existe até a purga).

### `GET /platform/alerts`
Lista de alertas derivados de dados reais; **não há tabela de alertas**.
O envelope `data` é a lista já ordenada por severidade (`critical` → `warning`
→ `info`), depois por slug do tenant e tipo; `meta` carrega `generatedAt` e
`total`.

```json
{
  "data": [
    {
      "severity": "warning",
      "tenantId": "...", "tenantSlug": "acme",
      "type": "SLA_AT_RISK",
      "message": "11 open tickets are at SLA risk (deadline within 120 minutes).",
      "value": 11
    }
  ],
  "meta": { "generatedAt": "2026-11-05T12:00:00.000Z", "total": 1 }
}
```

| `type` | Condição | Severidade | `value` |
|---|---|---|---|
| `TENANT_SUSPENDED` | `tenants.status = SUSPENDED` | warning | `1` |
| `ACCOUNT_STATUS` | conta com `status != ACTIVE` | warning (`TOKEN_EXPIRED`) / critical (`DISCONNECTED`) | `1` |
| `ACCOUNT_ERROR` | conta `ACTIVE` com `last_error_at` nas últimas 24 h | warning | minutos desde o erro |
| `AGENTS_QUOTA` | agentes ≥ 80% de `max_agents` | warning (≥80%) / critical (≥100%) | percentual |
| `ACCOUNTS_QUOTA` | contas ≥ 80% de `max_accounts` | warning (≥80%) / critical (≥100%) | percentual |
| `SLA_AT_RISK` | abertos em risco > 10 | warning (>10) / critical (>20) | quantidade |
| `INVITATIONS_EXPIRING` | convites pendentes que expiram em 48 h | info | quantidade |

Workspaces `DELETED`/soft-deleted ficam fora do snapshot. Uma conta com status
não `ACTIVE` gera **um** alerta (`ACCOUNT_STATUS`) e não duplica
`ACCOUNT_ERROR`; o erro recente é avaliado para contas ativas. O limiar de SLA
é `SLA_AT_RISK_ALERT_THRESHOLD = 10` (exportado por `PlatformService`).

### Billing (base para cobrança)
Preços mensais de tabela em `shared/plans.ts` (`PLAN_MONTHLY_PRICE_BRL`):
**FREE 0, PRO 299, ENTERPRISE 1.499 BRL**. Não há gateway integrado: as rotas
abaixo só persistem/derivam o estado comercial.

`GET /platform/billing/summary`:

```json
{
  "mrr": 2097,
  "byPlan": [
    { "plan": "FREE", "tenants": 2, "mrr": 0 },
    { "plan": "PRO", "tenants": 2, "mrr": 598 },
    { "plan": "ENTERPRISE", "tenants": 1, "mrr": 1499 }
  ],
  "trialing": 3,
  "pastDue": 1
}
```

- `mrr` = Σ (preço do plano × workspaces com `billing_status = ACTIVE`) em BRL.
- `byPlan` sempre tem os três planos; `tenants`/`mrr` contam **somente**
  assinaturas `ACTIVE` (FREE aparece com `mrr: 0`). Trials, inadimplentes e
  cancelados não entram no MRR.
- `trialing`/`pastDue`: quantidade de workspaces nesses estados.
- Workspaces soft-deleted e `CANCELED` não são cobrados (fora do summary).

`PATCH /platform/tenants/:id/billing` body `.strict()`
`{ billingStatus?, trialEndsAt?, billingEmail? }` (ao menos um):

- `billingStatus`: `TRIALING | ACTIVE | PAST_DUE | CANCELED`.
- `trialEndsAt`: data ISO-8601 ou `null` para limpar.
- `billingEmail`: e-mail ≤180 chars ou `null` para limpar; é normalizado com
  `trim` e não precisa ser o e-mail de login do ADMIN.
- Resposta: `{ tenantId, slug, plan, billingStatus, trialEndsAt, billingEmail,
  monthlyPriceBrl, updatedAt }`.
- `404` workspace desconhecido; `409 CONFLICT` (`details.code =
  TENANT_DELETED`) para workspace soft-deleted; `422` body vazio/ inválido.
- Suspender um workspace não impede ajustar o billing (cobrança e operação são
  eixos separados).
- Os três campos de assinatura também vêm no item de `GET /platform/tenants`
  (prefill do formulário), com os mesmos valores e `null` explícito.

**Follow-up (fora do escopo):** integrar um gateway (Stripe/Pagar.me) com
webhooks idempotentes para `invoice.paid`/`payment_failed`, histórico de
faturas, proration, impostos e método de pagamento; transicionar
`TRIALING → PAST_DUE` por job de dunning e `TRIALING → CANCELED` ao fim do
trial. Nada disso muda o contrato atual das rotas.

## LGPD por tenant

### `GET /tenants/me/export` (ADMIN do tenant)
Download `application/json` com `Content-Disposition: attachment;
filename="tenant-<slug>-export-<YYYY-MM-DD>.json"` (sem envelope `{data}` para o
arquivo ser utilizável direto).

Conteúdo: `meta` (versão do formato, data, autor, limites, truncamento, notas),
`tenant`, `agents`, `accounts`, `tickets`, `messages`, `events`.

**Excluído de propósito** (documentado em `meta.notes`):

- `password_hash`, `two_factor_secret_enc` e códigos de recuperação;
- `access_token_enc` / `refresh_token_enc` e chaves de `channel_config` que
  pareçam credencial (`token`, `secret`, `password`, `api_key`, `private_key`);
- PII crua do comprador nos tickets (`buyer_display_name`,
  `buyer_anonymized_email`, `buyer_external_id`, `buyer_contact_hash`);
- `buyer_pii_vault` (dados restritos Amazon, expurgados pelo job de retenção);
- HTML, `content_payload` e artefatos brutos S3 das mensagens.

Limites do artefato: 1.000 tickets (mais recentes) e 5.000 mensagens;
`meta.truncated` indica corte. A exportação nunca sai do tenant do JWT.

### `DELETE /tenants/me` (ADMIN do tenant)
Body `{ password, confirmSlug }`, ambos obrigatórios:

1. `confirmSlug` precisa ser igual a `tenants.slug` (trim + case-insensitive) → senão 422.
2. `password` é comparada com bcrypt contra o hash do ADMIN autenticado → senão 403 `INVALID_PASSWORD`.
3. Revoga todas as sessões refresh do tenant (`sessions.revoked_at = now`).
4. Soft delete: `status = 'DELETED'`, `deleted_at = now`.
5. Resposta `202` com `{ tenantId, slug, status, deletedAt, purge: { scheduled: true, note } }`.

Contas, agentes, tickets, mensagens e eventos **permanecem** (auditoria). A
partir do próximo request, qualquer token do tenant recebe
`403 TENANT_INACTIVE`; o login também é bloqueado.

## Purga física (LGPD)

O soft delete preserva tudo; a exclusão definitiva é feita pelo
`TenantPurgeService`, usado por dois caminhos:

| Caminho | Quando | Prazo de carência |
|---|---|---|
| `queue.tenant.purge` (BullMQ, cron `0 3 * * *`) | diário, 03:00 | respeita `TENANT_PURGE_RETENTION_DAYS` (default 30) |
| `POST /platform/tenants/:id/purge` (platform admin) | sob demanda | ignora a carência; exige `deleted_at` |

Regras:

- **Artefatos S3 antes, transação depois.** Antes do delete transacional o job
  coleta as chaves do workspace (`webhook_events.payload_s3_uri`,
  `ticket_messages.body_raw_s3_uri`,
  `ticket_messages.content_payload.attachment_keys` e
  `message_attachments.s3_uri` — o schema guarda a URI, não um `s3_key`) e as
  apaga via `IObjectStorage.deleteObjects`, tolerando `NoSuchKey`. O resultado
  registra `s3ObjectsDeleted`/`s3Failed`. Se o storage falhar (ou a coleta
  falhar), a purga do banco continua e o job reporta `s3Failed`; os objetos
  órfãos ficam para retry manual / lifecycle policy do bucket. O delete de cada
  tenant continua em **uma transação** (`PrismaTenantPurgeRepository.purge`),
  com ordem FK-safe: `sessions` → `invitations` → `password_resets` /
  `email_verifications` / `two_factor_recovery_codes` (pelos ids dos agentes) →
  `buyer_pii_vault` → `message_attachments` → `ticket_messages` →
  `ticket_events` → `outbound_attempts` → `support_tickets` → `orders_cache` →
  `sla_policies` → `webhook_events` → `marketplace_accounts` → `agents` →
  `tenants`. Tabelas sem `tenant_id` são escopadas pela relação pai
  (`ticket`/`account`).
- Lote limitado por `TENANT_PURGE_BATCH_SIZE` (25): um backlog é drenado em dias
  consecutivos em vez de bloquear o worker; `?limit` do endpoint manual não se
  aplica (é sempre um tenant).
- Falha de um tenant não interrompe o sweep: entra em `failures` e é logada
  (`tenant.purge.failed`); sucesso loga `tenant.purge.tenant_deleted` com a
  contagem por tabela e `tenant.purge.completed` com os totais.
- Um candidato sem `deleted_at` é recusado defensivamente
  (`TENANT_NOT_SOFT_DELETED`) — nunca há hard delete de workspace ativo.
- **Retenção legal** (fiscal/financeiro) deve ser avaliada antes de encurtar o
  prazo de 30 dias. A purga é irreversível (não há restore nesta fase).

## Status page pública

`GET /status` (bare) e `GET /api/v1/status` (prefixo do SPA) são **públicos**
(allowlist do auth middleware) e devolvem o corpo plano, sem envelope `{ data }`:

```json
{
  "status": "operational",
  "checkedAt": "2026-11-05T12:00:00.000Z",
  "services": [
    { "name": "api", "status": "operational", "latencyMs": 3 },
    { "name": "database", "status": "operational", "latencyMs": 11 },
    { "name": "redis", "status": "operational", "latencyMs": 4 },
    { "name": "storage", "status": "operational", "latencyMs": 25 }
  ],
  "channels": [
    { "marketplace": "MERCADO_LIVRE", "accounts": 3, "healthy": 2, "lastErrorAt": "2026-11-05T11:40:00.000Z" }
  ]
}
```

Regras:

- **Só probes de infraestrutura.** `database` = `SELECT 1`, `redis` = `PING`,
  `storage` = probe real do bucket. Nenhum adaptador/marketplace é chamado:
  a página é barata e **não gasta quota paga**. Reutiliza os mesmos probes de
  `HealthService`/`DiagnosticsService`.
- **Sem PII nem segredos.** `services` expõe apenas nome/status/latência (sem
  `detail`, connection string ou mensagem de erro). `channels` é agregado por
  marketplace: `accounts` (total), `healthy` (quantas contas estão saudáveis
  pelo estado armazenado) e `lastErrorAt` (o erro mais recente, ISO ou `null`).
  Nunca sai `accountId`, nome da loja, e-mail ou token.
- **Saudável sem chamada ao marketplace:** conta `ACTIVE`, com credencial
  armazenada e sem erro nos últimos 30 minutos. Token de acesso expirado
  isoladamente não derruba o canal (o refresh é automático).
- **Nível geral:** `database` ou `redis` fora → `down`; `storage` fora ou
  qualquer canal parcialmente saudável → `degraded`; tudo ok → `operational`.
  `api` é `operational` por construção (a própria resposta prova).
- **Sempre HTTP 200**, inclusive em `degraded`/`down`; monitores leem o campo
  `status`. Se o snapshot falhar de forma inesperada, a rota responde um
  fallback conservador `down` (200) em vez de 500. Timeout de 5 s por probe.
- **Cache:** `public, max-age=30` no `/status` bare; sob `/api/v1` o hook global
  de `no-store` prevalece.

## Segurança

- `requirePlatformAdmin` relê o operador no banco; `isActive = false` também nega.
- `verifyToken` confere o tenant em toda requisição autenticada (custo de 1
  lookup por request; cache com TTL curto é otimização futura).
- `DELETE /tenants/me` exige reautenticação e o slug, e o serviço também valida
  que o ator é ADMIN **daquele** tenant (defesa para chamadas internas).
- Todos os detalhes usam códigos estáveis (`PLAN_LIMIT_REACHED`,
  `TENANT_INACTIVE`, `INVALID_PASSWORD`).

## Testes

- `PlanLimits.test.ts` — quotas de agentes/contas, convites pendentes, ENTERPRISE,
  tenant suspenso/excluído.
- `PlanLimitWiring.test.ts` — prova que conta nova e convite/aceite passam pelo gate.
- `PlatformService.test.ts` — RBAC, listagem/paginação, troca de plano/quota,
  métricas.
- `PlatformMetrics.test.ts` — métricas por tenant, zero-fill dos status/série de
  14 dias, percentuais de quota, 404.
- `PlatformAlerts.test.ts` — cada tipo de alerta, limiares de quota/SLA,
  ordenação por severidade e janelas de consulta.
- `PlatformBilling.test.ts` — MRR por plano, trials/inadimplentes, PATCH
  (status/trial/e-mail), limpeza com `null`, 404/409/422.
- `repositories/platform.tenant-metrics.test.ts` — escopo `tenant_id` das
  agregações, snapshot de alertas e filtro de soft-deleted no billing.
- `TenantPrivacy.test.ts` — export sem segredos/PII, delete com senha/slug e erros.
- `TenantPurge.test.ts` — carência de 30 dias, lote, falha isolada, purga manual
  (409 para workspace ativo/404 desconhecido), S3 antes do banco, `s3Failed`
  quando o storage falha e `NoSuchKey`/duplicatas normalizadas.
- `repositories/tenant-purge.test.ts` — ordem FK-safe, transação única, escopo
  por tenant e coleta das chaves S3 (`payload_s3_uri`, `body_raw_s3_uri`,
  `s3_uri`, `attachment_keys`) com Prisma fake, sem banco.
- `infrastructure/storage/s3-delete.test.ts` — `deleteObject`/`deleteObjects`
  com cliente fake: roteamento por bucket, chunk de 1.000, `NoSuchKey`
  tolerado, falha parcial/transporte contada sem throw.
- `repositories/tenants.list.test.ts` — busca `name`/`slug` case-insensitive com
  `findMany` e `count` usando o mesmo `where`.
- `queues/tenantPurgeWiring.test.ts` — nomes de fila/job, cron `0 3 * * *` e
  defaults de retenção (`buildSchedulerSpecs`, sem Redis).
- `AgentTenantGate.test.ts` — login/verify de tenant ativo, suspenso, excluído e legado.
- `platform-routes.test.ts` / `tenant-privacy-routes.test.ts` — HTTP, 401/403/422,
  busca, purga manual, headers de download e 202.
- `StatusService.test.ts` — níveis (`operational`/`degraded`/`down`), agregação
  por marketplace sem PII, timeouts e probe/repositório falhando sem throw.
- `status-routes.test.ts` — corpo plano nos dois caminhos públicos, allowlist
  exata e fallback `down` em HTTP 200.
