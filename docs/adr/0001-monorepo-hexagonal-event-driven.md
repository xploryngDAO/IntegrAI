# ADR-0001 — Monorepo npm workspaces, hexagonal e event-driven

## Status

Aceito

## Data

2026-11-06

## Contexto

O IntegrAI (SAC Hub) integra Amazon (SP-API + SES), Mercado Livre e Shopee numa
única estação de atendimento. A SPA é um artefato estático publicado na Vercel e
a API é um processo long-running (Fastify + workers BullMQ + Postgres/Redis/S3),
com regras de negócio compartilhadas entre front e back.

Os webhooks dos marketplaces têm orçamento de resposta curto (Meli < 500 ms,
Shopee < 100 ms) e não podem executar chamadas externas no request. O domínio
precisa de contratos estáveis entre camadas, e cada canal tem particularidades
de hidratação, roteamento e sanitização que não devem vazar para o núcleo.

O repositório já nasceu único e organizado em workspaces (`package.json` raiz:
`workspaces: ["packages/*", "apps/*"]`), com `@sac/shared`, `@sac/server` e
`@sac/web`.

## Decisão

1. **Monorepo npm workspaces**, um lockfile e um `tsconfig.base.json`:
   - `packages/shared` (`@sac/shared`) — contrato congelado: enums, DTOs, portas,
     regras puras de compliance e constantes;
   - `packages/server` (`@sac/server`) — Fastify 5, Prisma, Redis/BullMQ, S3,
     adapters de canal;
   - `apps/web` (`@sac/web`) — React 18 + Vite.
   A ordem de build é explícita: `build:shared` → `prisma:generate` →
   `build:server` → `build:web` (`package.json` raiz).
2. **Hexagonal / Ports & Adapters**: as portas vivem em
   `packages/shared/src/ports/` (`infra.ts`, `repositories.ts`, `services.ts`) e
   o contrato de canal em `packages/shared/src/adapter.ts`
   (`IMarketplaceChannelAdapter`). O servidor implementa as portas em
   `infrastructure/` e `application/repositories/`, orquestra em
   `application/` e isola cada marketplace em `adapters/amazon`,
   `adapters/mercadolivre` e `adapters/shopee` (estratégia por canal). O grafo de
   dependências é montado em `packages/server/src/container.ts`; regras que a UI
   e a API precisam compartilhar (ex.: `compliance.ts`) ficam no shared.
3. **Event-driven com BullMQ**: o webhook apenas valida assinatura (quando o
   provedor oferece), registra idempotência (`SET NX EX 86400`) e publica na
   fila; o worker hidrata o recurso na API oficial e aplica o domínio. As filas
   (`queue.inbound.*`, `queue.spapi.enrichment`, `queue.outbound.dispatch`,
   `queue.sla.scan`, `queue.pii.purge`, `queue.token.refresh`,
   `queue.shopee.lost-push`, `queue.dlq`) usam backoff exponencial com full
   jitter (`computeBackoffDelay` em `@sac/shared`) e DLQ com contexto do erro.
   Schedulers cobrem SLA, purge, refresh de tokens e recuperação de pushes.
4. **Tempo real por Socket.IO** no mesmo processo da API, com eventos de fila,
   chat, presença e saúde dos canais; a SPA consome REST `/api/v1` + Socket.IO.

## Alternativas consideradas

- **Repositórios separados com `@sac/shared` publicado no npm.** Daria
  versionamento independente, mas exigiria release coordenado a cada mudança de
  contrato e dois fluxos de CI; o contrato ainda está em evolução conjunta.
  Rejeitado por custo de coordenação frente ao tamanho do time.
- **Monólito síncrono, sem filas.** Mais simples de operar, porém viola o
  orçamento de resposta dos webhooks e acopla indisponibilidade de marketplace
  ao request do operador. Rejeitado.
- **Um único pacote (server + web juntos).** Eliminaria o build do shared, mas
  misturaria dependências de browser e Node e impediria o deploy estático da
  SPA na Vercel. Rejeitado.
- **SQS/Kinesis desde o início.** Melhor para multi-região, mas adiciona
  infraestrutura gerenciada e perde recursos do BullMQ usados hoje (repeatable
  jobs, DLQ, backoff). Ficou no roadmap, não na decisão inicial.

## Consequências

**Positivas**

- Uma mudança de contrato, servidor e UI entra num único PR, com um lockfile e
  uma ordem de build reproduzível.
- O núcleo depende de portas, não de Fastify/Prisma/HTTP; os adapters de canal
  são substituíveis e testáveis sem rede.
- Webhooks respondem rápido e o trabalho pesado é retomável; falhas têm
  backoff, DLQ e auditoria (`outbound_attempts`, `webhook_events`).
- A SPA continua deployável de forma independente na Vercel, consumindo a mesma
  API.

**Negativas**

- O client Prisma é gerado em `packages/server/src/generated` (gitignored), então
  `prisma:generate` é obrigatório antes de typecheck/build no CI e nas imagens
  Docker — um passo a mais que quebra builds se esquecido.
- As imagens Docker precisam copiar os manifests de **todos** os workspaces e
  `vendor/` para o `npm ci` funcionar.
- `@sac/shared` é um ponto de acoplamento: qualquer alteração de tipo propaga
  para server e web e exige rebuild dos dois.
- Não há versionamento independente dos pacotes; consumidores externos não são
  suportados hoje.
- BullMQ em Redis é single-region; a troca por SQS/Kinesis segue como dívida
  arquitetural registrada no README.

## Referências

- [`package.json`](../../package.json) — workspaces, engines e ordem de build.
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — camadas, layout e golden rules.
- [`packages/shared/src/ports/infra.ts`](../../packages/shared/src/ports/infra.ts),
  [`repositories.ts`](../../packages/shared/src/ports/repositories.ts),
  [`services.ts`](../../packages/shared/src/ports/services.ts) e
  [`adapter.ts`](../../packages/shared/src/adapter.ts).
- [`packages/server/src/container.ts`](../../packages/server/src/container.ts) — grafo de dependências.
- [`packages/server/src/queues/`](../../packages/server/src/queues/schedulers.ts) — produtores, workers, schedulers e DLQ.
- [`README.md`](../../README.md) — visão geral, regras de ouro e operação das filas.
