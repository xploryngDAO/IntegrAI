# Fase 4 — Plataforma e operação (design)

> Pré-requisito: Fases 0–3. Cada dado de cliente já é isolado por `tenant_id`.
> Objetivo: operar o SaaS — planos, limites, console interno, métricas e os
> direitos LGPD de exportação/eliminação por tenant.

## Escopo entregue

| Área | Entrega |
|---|---|
| Schema | `tenants.plan` (`TenantPlan`), `max_accounts`, `max_agents`, `deleted_at`; `agents.is_platform_admin` |
| Limites | `max_agents` ao convidar/aceitar convite; `max_accounts` ao conectar loja nova |
| Console | `GET /platform/tenants`, `PATCH /platform/tenants/:id`, `GET /platform/metrics` |
| LGPD | `GET /tenants/me/export`, `DELETE /tenants/me` (soft delete) |
| Sessão | tenant `SUSPENDED`/`DELETED` responde `403 TENANT_INACTIVE` no login e em toda requisição |

Fora do escopo desta fase (backlog): billing/assinatura, purga física, status
page, alertas, backup/restore por tenant, UI do console.

## Modelo de dados

```
tenants
  plan          TenantPlan  FREE | PRO | ENTERPRISE   (default FREE)
  max_accounts  INT         quota efetiva             (default 1)
  max_agents    INT         quota efetiva             (default 3)
  deleted_at    TIMESTAMPTZ soft delete LGPD          (default NULL)
  status        VARCHAR     ACTIVE | SUSPENDED | DELETED

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

### `GET /platform/tenants?page=&pageSize=`
`{ data: { items, total, page, pageSize, totalPages } }`, mais recente primeiro.
Cada item:

```json
{
  "id": "...", "slug": "acme", "name": "Acme",
  "plan": "PRO", "status": "ACTIVE",
  "limits": { "maxAccounts": 10, "maxAgents": 25 },
  "counts": { "accounts": 3, "agents": 5, "tickets": 40 },
  "onboardingCompletedAt": null, "deletedAt": null,
  "createdAt": "2026-11-01T10:00:00.000Z"
}
```

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
5. Resposta `202` com `{ tenantId, slug, status, deletedAt, purge: { scheduled: false, note } }`.

Contas, agentes, tickets, mensagens e eventos **permanecem** (auditoria). A
partir do próximo request, qualquer token do tenant recebe
`403 TENANT_INACTIVE`; o login também é bloqueado.

> **Purge físico é job futuro.** Não existe rotina de exclusão definitiva nesta
> fase. O endpoint registra a intenção (`deleted_at`) e a resposta declara
> `purge.scheduled = false`. O job futuro deve: respeitar retenções legais
> (fiscal/financeiro), apagar `buyer_pii_vault` e artefatos S3, e então remover
> as linhas do tenant.

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
- `TenantPrivacy.test.ts` — export sem segredos/PII, delete com senha/slug e erros.
- `AgentTenantGate.test.ts` — login/verify de tenant ativo, suspenso, excluído e legado.
- `platform-routes.test.ts` / `tenant-privacy-routes.test.ts` — HTTP, 401/403/422,
  headers de download e 202.
