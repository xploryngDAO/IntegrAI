# Architecture Decision Records (ADRs)

Registro das decisões arquiteturais do IntegrAI / SAC Hub. Cada ADR documenta o
**contexto**, a **decisão**, as **alternativas rejeitadas** e as **consequências**
de uma escolha que seria cara de reverter. O código mostra o que foi feito; o ADR
explica por quê.

Escopo: monorepo e camadas, isolamento multi-tenant, autenticação corporativa,
persistência, deploy e observabilidade/segurança.

## Status das decisões

| ADR | Decisão | Status | Data |
|---|---|---|---|
| [0001](0001-monorepo-hexagonal-event-driven.md) | Monorepo npm workspaces, hexagonal (ports & adapters) e event-driven com BullMQ | Aceito | 2026-11-06 |
| [0002](0002-multi-tenant-isolation.md) | Isolamento multi-tenant por `tenant_id` (NOT NULL/FK) e escopo no JWT, com purge/LGPD | Aceito | 2026-11-06 |
| [0003](0003-autenticacao-corporativa-oidc.md) | SSO corporativo OIDC (Entra/Google/Okta), state+nonce+PKCE, one-time code, enforce SSO/break-glass e política de 2FA | Aceito | 2026-11-06 |
| [0004](0004-prisma-7-driver-adapter.md) | Prisma 7 com generator `prisma-client`, `@prisma/adapter-pg` e client gerado gitignored | Aceito | 2026-11-06 |
| [0005](0005-deploy-self-hosted-e-vercel.md) | Vercel somente para o SPA + stack Docker self-hosted (nginx same-origin, Caddy TLS opcional), backup/restore e CI | Aceito | 2026-11-06 |
| [0006](0006-observabilidade-e-seguranca.md) | `request-id`, `/health/ready`, `/metrics` Prometheus, gitleaks, sonda de segurança e WCAG AA com axe no CI | Aceito | 2026-11-06 |

Todas as decisões acima estão **em vigor** nesta baseline. Nenhuma foi
substituída ou depreciada até a data desta revisão.

## Template (resumido)

Ao criar um ADR, copie o bloco abaixo para
`docs/adr/NNNN-titulo-em-kebab-case.md` e preserve a ordem das seções:

```markdown
# ADR-NNNN — Título imperativo e curto

## Status

Aceito | Proposto | Substituído por ADR-NNNN | Depreciado

## Data

AAAA-MM-DD

## Contexto

Forças em jogo: requisitos, restrições, incidentes, dívida e o que torna a
decisão necessária agora. Sem inventar fatos; referencie arquivos existentes.

## Decisão

O que foi decidido, em itens verificáveis. Inclua caminhos de arquivos e
nomes de comandos/rotas quando forem parte da decisão.

## Alternativas consideradas

Cada alternativa com o motivo real da rejeição (não apenas “pior”).

## Consequências

**Positivas** — o que ganhamos.
**Negativas** — custos, riscos aceitos, dívida e o que passa a ser obrigatório.

## Referências

Links relativos para docs/arquivos que sustentam a decisão.
```

## Convenções

- **Numeração sequencial** de quatro dígitos; o arquivo é
  `NNNN-titulo-em-kebab-case.md`. Não reutilize números e não apague um ADR
  antigo: para mudar uma decisão, escreva um novo e marque o anterior como
  `Substituído por ADR-NNNN`.
- **Um ADR = uma decisão.** Se a mudança cobre dois assuntos independentes,
  escreva dois registros (ou deixe explícito o que é consequência).
- **Data** no formato `AAAA-MM-DD`. A data é a da aceitação, não a do commit.
- **Status** segue `Proposto → Aceito → (Substituído | Depreciado)`. Enquanto
  não houver aceite, o ADR não descreve o sistema como se a decisão já valesse.
- **Referências relativas** (`../SECURITY.md`, `../../prisma/schema.prisma`)
  mantêm os links válidos no GitHub e no editor.
- **Sem código de produção no ADR**: ilustrações curtas são aceitáveis, mas a
  fonte de verdade é o repositório.

## Como adicionar

1. Confirme que não existe ADR cobrindo a mesma decisão (veja a tabela acima).
2. Copie o template para `docs/adr/NNNN-titulo.md` com o próximo número livre.
3. Preencha contexto, decisão, alternativas rejeitadas e consequências com fatos
   verificáveis no repositório.
4. Adicione a linha na tabela **Status das decisões** deste README.
5. Se a decisão alterar segurança, autenticação, dados ou deploy, atualize
   também o documento operacional correspondente (`docs/SECURITY.md`,
   `docs/ENTERPRISE_SSO.md`, `docs/RUNBOOK.md`, `docs/ARCHITECTURE.md`).

## Documentos relacionados

- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — visão de camadas e golden rules.
- [`docs/SECURITY.md`](../SECURITY.md) — modelo de ameaças, controles e LGPD.
- [`docs/ENTERPRISE_SSO.md`](../ENTERPRISE_SSO.md) — operação do SSO OIDC.
- [`docs/PHASE1_AUTH.md`](../PHASE1_AUTH.md) — autenticação, sessões e 2FA.
- [`docs/PHASE4_BACKUP_RESTORE.md`](../PHASE4_BACKUP_RESTORE.md) — backup/restore por tenant.
- [`docs/RUNBOOK.md`](../RUNBOOK.md) — operação do stack self-hosted.
- [`docs/PRODUCT_STATUS.md`](../PRODUCT_STATUS.md) — estado consolidado do produto.
