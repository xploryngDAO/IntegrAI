# Roadmap — IntegrAI / SAC Hub

> Objetivo: transformar o SAC Hub de uma operação single-tenant em um **SaaS
> multi-cliente**, onde cada cliente cria sua conta, conecta as próprias lojas e
> opera com isolamento total de dados.
>
> Estado inicial (05/11/2026): Mercado Livre conectado e validado; login único
> criado por bootstrap; base sem `tenant_id`; apps de marketplace globais no `.env`.

## Visão de arquitetura alvo

```
Cliente A ─┐                        ┌─ App Meli (IntegrAI)
Cliente B ─┼─ tenants / users ──────┼─ App Shopee (IntegrAI)  ← cliente só autoriza
Cliente C ─┘   (JWT com tenant)     └─ App Amazon (público SP-API)
                    │
             dados escopados por tenant_id
        (accounts, tickets, mensagens, eventos, SLA…)
```

### Modelo de credenciais de marketplace

| Canal | Modelo | Quem cria o app | Cliente faz |
|---|---|---|---|
| Mercado Livre | App único da IntegrAI, N sellers autorizam | IntegrAI | login + autorizar |
| Shopee | App parceiro único, N shops autorizam | IntegrAI | login + autorizar |
| Amazon | App público SP-API aprovado (revisão + security assessment) | IntegrAI | autorizar no Seller Central |
| Amazon (alternativa) | App privado por seller | cliente (ruim) | criar app + colar credenciais → **não recomendado** |

## Fases

### Fase 0 — Multi-tenant (bloqueante) — em andamento

**Objetivo:** todo dado de cliente isolado por `tenant_id`; login devolve o tenant.

Entregas:
1. Schema: `tenants` + `tenant_id` em `agents`, `marketplace_accounts`, `support_tickets`, `webhook_events`, `sla_policies`.
2. Migração com backfill: cria tenant `IntegrAI` e vincula todos os dados existentes.
3. Auth: JWT com `tenantId`; `/auth/me` retorna tenant; guard anexa o agente.
4. Repositórios e serviços: leituras escopadas por tenant; escritas herdam o tenant da conta/ticket.
5. Workers: contexto de tenant por job (via conta/ticket) para gravar eventos corretos.
6. Diagnóstico/health por tenant.
7. Seed: cria tenant + ADMIN; sem credenciais de marketplace.
8. Testes: isolamento A≠B (cliente A não enxerga conta/ticket de B).

Critérios de aceite:
- Dois tenants no banco; `GET /accounts` e `GET /tickets` só retornam os do token.
- Webhook de uma conta cria ticket no tenant da conta.
- `npm run db:seed` idempotente.
- `tsc` e testes verdes.

Riscos: migração em dados existentes; esquecer um `findMany` sem filtro (mitigado por extensão Prisma + testes de isolamento).

### Fase 1 — Contas e autenticação self-service

- Signup com verificação de e-mail (SMTP/SES), criação automática de tenant.
- Reset de senha, convite de operadores, papéis e permissões na UI.
- 2FA opcional para ADMIN; sessões/refresh e revogação.
- Rate limit e bloqueio progressivo no login.
- Auditoria de login e ações sensíveis.

Critérios: cliente cria conta sozinho, verifica e-mail, entra e convida equipe sem suporte.

### Fase 2 — Onboarding guiado

- Wizard "Conectar lojas" com checklist por canal e status ao vivo (diagnóstico real).
- Amazon: substituir formulário LWA por "Autorizar na Amazon" (OAuth SP-API) + guia SES/relay.
- Ajuda contextual, links oficiais, detecção de erros comuns (redirect, escopos, sandbox).
- Empty states com próximo passo (não só "fila vazia").

Critérios: cliente novo conecta Meli/Shopee em <3 min sem suporte; Amazon guiada.

### Fase 3 — Apps de marketplace em produção

- Meli: certificação do app (quando exigida) e revisão de escopos.
- Shopee: aprovação do app parceiro, push URL e sandbox validados.
- Amazon: app público SP-API, revisão da Amazon + security assessment, DPP.
- Credenciais por tenant apenas onde inevitável (ex.: Amazon privado), cifradas.

Critérios: N clientes reais conectados com apps aprovados e webhooks estáveis.

### Fase 4 — Plataforma e operação

- Console interno: tenants, planos, limites, uso, suspensão.
- Billing (assinatura) e quotas por plano.
- Métricas por tenant (SLA, volume, erros), alertas e status page.
- Backup/restore por tenant e LGPD (exportação/eliminação de dados).

## Decisões pendentes

| Decisão | Opções | Recomendação |
|---|---|---|
| Isolamento | coluna `tenant_id` (single DB) × schema/DB por tenant | single DB com `tenant_id` + extensão Prisma |
| Login | próprio × provedor (Auth0/Clerk/Supabase) | próprio (já temos JWT/bcrypt) na Fase 1; SSO depois |
| E-mail transacional | SES × SMTP × provedor | SES (já previsto para Amazon) |
| Amazon | app público × private por cliente | público (Fase 3) |

## Progresso

- [x] Roadmap documentado
- [x] Fase 0 — schema + migração (tenant_id nullable, backfill do tenant `integrai`)
- [x] Fase 0 — auth com tenant (JWT/login/verify + middleware)
- [x] Fase 0 — escopo de leitura (contas, agentes, tickets lista/detalhe) + escrita de tickets com tenant
- [ ] Fase 0 — testes de isolamento
- [ ] Fase 1 — signup/reset/convites
- [ ] Fase 2 — onboarding guiado
- [ ] Fase 3 — apps aprovados
- [ ] Fase 4 — console/billing
