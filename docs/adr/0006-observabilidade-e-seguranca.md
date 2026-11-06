# ADR-0006 — Observabilidade e segurança verificável no CI

## Status

Aceito

## Data

2026-11-06

## Contexto

O produto opera webhooks, filas e atendimento em tempo real. Sem correlação,
um erro reportado pelo cliente não é rastreável até o request, o worker ou o
evento de webhook. Sem readiness, o orquestrador manda tráfego para uma API que
não alcança Postgres/Redis/S3. Sem métricas, não há alerta de 5xx ou latência.
E, como o repositório é público, um segredo commitado precisa ser barrado antes
do merge — não depois.

Acessibilidade também é requisito de produto: a UI é a estação de trabalho do
operador, e violações WCAG A/AA precisam ser detectadas de forma automatizada,
não apenas em revisão manual.

## Decisão

1. **`request-id` em toda requisição.** `x-request-id` do cliente é aceito
   apenas se casar `[A-Za-z0-9._-]{8,128}`; qualquer outro valor é descartado e
   um UUID v4 é gerado (`http/middleware/request-id.ts`). O header é sempre
   devolvido, o `request.id` vira child logger (`requestId` nas linhas) e os
   corpos de erro carregam `error.requestId`; a resposta expõe também
   `x-sac-duration-ms`. O valor entra em `allowedHeaders` do CORS.
2. **Probes separados.** `GET /health` é o relatório profundo (503 quando
   `down`); `GET /health/ready` é o gate de dependências: 200 `ready` quando
   Postgres/Redis/S3 respondem, 503 `degraded` com mapa por dependência,
   `cache-control: no-store` e sondas limitadas a ~2 s em `HealthService`. As
   duas rotas são montadas na raiz e sob `/api/v1` para load balancer e contrato.
3. **Métricas Prometheus sem dependência.** `GET /api/v1/metrics` responde no
   formato `text/plain; version=0.0.4` com um registry em memória
   (`http/metrics/registry.ts`): contador
   `sac_http_requests_total{method,status_class}` com labels limitados,
   histograma de duração com buckets padrão, `sac_process_uptime_seconds` e
   gauges `sac_db_up`/`sac_redis_up`/`sac_storage_up` alimentados pelo último
   `/health/ready`. A rota fica **desabilitada (404)** sem `METRICS_TOKEN`;
   com token, aceita `Authorization: Bearer` ou `x-metrics-token` e compara em
   tempo constante sobre SHA-256.
4. **Secret scanning no CI.** O job `Security` roda gitleaks sobre o histórico
   completo (`fetch-depth: 0`), com `--exit-code 1 --redact` e baseline revisado
   em `.gitleaksignore`; o repositório está em *no leaks found*. O mesmo job
   sobe Postgres/Redis, aplica migrações, semeia o admin e executa a sonda de
   isolamento e a sonda de segurança.
5. **Sonda de segurança automatizada.** `scripts/security-probe.mjs` verifica,
   contra a API em execução: headers (CSP restritiva, XFO, COOP, nosniff),
   `401` sem token nas rotas sensíveis, JWT adulterado e `alg: none` rejeitados,
   CORS fail-closed para origem desconhecida, `415` para Content-Type inválido,
   JSON malformado sem stack trace, busca resistente a injeção, rate limit de
   login respondendo `429` e auditoria acessível ao ADMIN. Não substitui pentest
   externo — é regressão contínua dos controles.
6. **Acessibilidade WCAG 2.1 A/AA no CI.** `scripts/a11y-audit.mjs` injeta
   axe-core em navegador limpo e audita as regras `wcag2a`, `wcag2aa`,
   `wcag21a` e `wcag21aa` em landing, login, admin, perfil, contas e ajustes;
   qualquer violação faz o script sair com código 1. O workflow `Security`
   instala/resolve Chromium, sobe o preview do Vite em `127.0.0.1:4173` e roda a
   auditoria autenticada. A evidência atual é **0 violações** nas seis telas
   (`docs/PRODUCT_STATUS.md`).

## Alternativas consideradas

- **`prom-client` como dependência.** Daria histogramas e registro padrão, mas
  adiciona dependência e superfície de atualização; o conjunto de métricas
  necessário é pequeno e cabe em um registry sem alocação por request.
  Rejeitado.
- **Expor `/metrics` sem autenticação.** Simplificaria o scrape, mas revelaria
  volume e latência sem controle; o token opt-in mantém a rota invisível (404)
  por padrão. Rejeitado.
- **Só logs, sem métricas.** Logs respondem “o que aconteceu”, mas não sustentam
  alerta de taxa de 5xx/p95. Rejeitado.
- **Correlação apenas no client (sem ecoar/validar `x-request-id`).** Perderia a
  ligação entre erro exibido e log do servidor, e aceitar o header cru abriria
  injeção em log. Rejeitado.
- **Auditoria de acessibilidade manual por release.** Não escala e regride sem
  aviso; axe no CI é determinístico e barato. Rejeitado.
- **SAST genérico em vez de secret scanning.** Cobre classes diferentes; o risco
  imediato de repositório público é segredo commitado. O gitleaks foi escolhido
  e o SAST segue como evolução.

## Consequências

**Positivas**

- Um `requestId` liga resposta de erro, log de acesso, evento de webhook e
  suporte, com validação contra injeção e geração de UUID quando ausente.
- Readiness evita tráfego em API sem Postgres/Redis/S3 e alimenta gauges sem
  custo no scrape.
- Métricas e sonda de segurança viram regressão de CI, não checklist manual.
- gitleaks bloqueia segredo no histórico; axe bloqueia regressão de
  acessibilidade nas telas principais.
- Nenhuma dependência nova para métricas; labels têm cardinalidade limitada.

**Negativas**

- O registry é em memória: contadores zeram no restart (o Prometheus lida com
  `rate()`) e não há métricas por rota/tenant.
- Os gauges de dependência só mudam quando `/health/ready` é chamado; entre
  probes, refletem o último veredito.
- `METRICS_TOKEN` precisa ser rotacionado junto com os demais segredos; sem ele,
  a rota responde 404 e o scrape falha silenciosamente.
- gitleaks exige clone com histórico completo e manutenção do baseline; um
  fingerprint novo pode bloquear o CI.
- As sondas de segurança e de acessibilidade dependem de admin semeado e de
  Chromium no runner; são mais frágeis que testes unitários.
- axe cobre regras automatizáveis de WCAG A/AA, não substitui teste com leitor de
  tela nem revisão de UX.

## Referências

- [`packages/server/src/http/middleware/request-id.ts`](../../packages/server/src/http/middleware/request-id.ts),
  [`request-context.ts`](../../packages/server/src/http/middleware/request-context.ts) e
  [`error-handler.ts`](../../packages/server/src/http/middleware/error-handler.ts).
- [`packages/server/src/http/routes/health.routes.ts`](../../packages/server/src/http/routes/health.routes.ts)
  e [`packages/server/src/application/HealthService.ts`](../../packages/server/src/application/HealthService.ts).
- [`packages/server/src/http/routes/metrics.routes.ts`](../../packages/server/src/http/routes/metrics.routes.ts)
  e [`packages/server/src/http/metrics/registry.ts`](../../packages/server/src/http/metrics/registry.ts).
- [`.github/workflows/security.yml`](../../.github/workflows/security.yml).
- [`scripts/security-probe.mjs`](../../scripts/security-probe.mjs) e
  [`scripts/isolation-test.mjs`](../../scripts/isolation-test.mjs).
- [`scripts/a11y-audit.mjs`](../../scripts/a11y-audit.mjs).
- [`docs/RUNBOOK.md`](../RUNBOOK.md) §4 e [`docs/SECURITY.md`](../SECURITY.md) §13.
