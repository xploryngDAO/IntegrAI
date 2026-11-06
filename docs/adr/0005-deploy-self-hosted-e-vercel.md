# ADR-0005 — Vercel para o SPA + stack Docker self-hosted para a API

## Status

Aceito

## Data

2026-11-06

## Contexto

A API é um processo long-running: Fastify, workers BullMQ, schedulers (SLA,
purge, refresh de token), Socket.IO e conexões persistentes com Postgres, Redis
e S3. Ela não cabe no modelo de função serverless. O SPA, ao contrário, é um
artefato estático (Vite) que se beneficia de CDN e deploy por push.

O produto precisa de um caminho de produção reproduzível para clientes que vão
hospedar em VPS/VM própria, com webhooks públicos, WebSocket e HTTPS, sem
depender de um único fornecedor de PaaS.

## Decisão

1. **Vercel hospeda somente o SPA público.** `vercel.json` define framework
   `vite`, `installCommand` com `npm install`, build
   `npm run build:shared && npm run build --workspace @sac/web`, saída em
   `apps/web/dist`, rewrite de SPA para `index.html` e os headers de segurança
   (CSP, HSTS, X-Frame-Options, COOP, Permissions-Policy). O SPA aponta para a
   API publicada via `VITE_API_BASE_URL`, definido no build — não há fallback
   simulado sem API.
2. **Backend em stack Docker self-hosted** (`docker-compose.prod.yml`):
   - `api`: imagem `sac-hub-api:prod` (`packages/server/Dockerfile`), roda
     `prisma migrate deploy` no boot, healthcheck em `/api/v1/health`, `tini`
     como entrypoint;
   - `postgres:16-alpine` com volume `pgdata` e healthcheck `pg_isready`;
   - `redis:7-alpine` com `--appendonly yes` e volume `redisdata`;
   - storage S3 **externo** (AWS S3, MinIO, R2 ou compatível), configurado por
     `S3_*` no `.env.prod`;
   - `web`: imagem `sac-hub-web:prod` (nginx 1.27-alpine) que serve o `dist` e
     faz proxy **same-origin** de `/api/`, `/socket.io/`, `/webhooks/` e
     `/health` para o container da API (`apps/web/nginx.conf`);
   - `caddy`: perfil opcional `tls`, com HTTPS automático (Let's Encrypt) na
     frente do `web`, exigindo `DOMAIN`, DNS e portas 80/443
     (`deploy/Caddyfile`).
   Sem o perfil `tls`, o stack sobe em HTTP na porta `${WEB_HOST_PORT:-8080}`.
3. **Same-origin como padrão de segurança e operação.** Com nginx na frente, SPA,
   API, Socket.IO e webhooks compartilham a mesma origem; o CSP do SPA pode usar
   `'self'` e o CORS deixa de ser o caminho principal. O proxy encaminha
   `X-Forwarded-For`/`X-Forwarded-Proto`, e `TRUST_PROXY` precisa ser configurado
   corretamente quando houver edge/proxy adicional (`docs/SECURITY.md` §6.8).
4. **Backup e restore fazem parte do deploy.**
   - `npm run db:backup` gera `backups/db-<timestamp>.sql` via `pg_dump --clean`
     dentro do container `postgres`; `npm run db:restore <arquivo>` aplica com
     `psql` em janela de manutenção (destrutivo, `--clean --if-exists`).
   - Backups por tenant (`TenantBackup`, JSON no S3) e restore para um workspace
     **novo** são expostos no console de plataforma
     (`docs/PHASE4_BACKUP_RESTORE.md`).
   - Rotina: backup diário + cópia off-site; drill de restore validado em
     2026-11-06 (`docs/RUNBOOK.md`).
5. **CI constrói e testa os dois artefatos.** `.github/workflows/ci.yml` roda
   `build:shared`, `prisma:generate`, typecheck de server/web, `vitest run`,
   builds e `docker build` das imagens `sac-hub-api` e `sac-hub-web` — o deploy
   não depende de uma máquina de desenvolvedor para provar que as imagens
   compilam.

## Alternativas consideradas

- **API também na Vercel (serverless).** Eliminaria o host Docker, mas a API tem
  workers, schedulers, BullMQ e Socket.IO de longa duração — incompatível com o
  modelo de funções. Rejeitado.
- **Somente Vercel para o SPA, API em PaaS gerenciado (Render/Railway/Fly).**
  É um caminho suportado pela documentação (`docs/SETUP_PRODUCTION.md`), mas não
  é o padrão porque o compose entrega same-origin, webhooks e WebSocket no mesmo
  host, sem depender de configuração de CORS por fornecedor. Mantido como
  alternativa operacional.
- **Self-hosted também para o SPA (nginx apenas, sem Vercel).** Eliminaria a
  CDN e o deploy por push, mas concentraria tudo num host. É possível com o
  mesmo `web` do compose; preterido por perder a CDN e o preview da Vercel.
- **Kubernetes desde o início.** Daria escala e rollout avançado, mas adiciona
  complexidade operacional desproporcional ao tamanho atual. Rejeitado.
- **TLS terminado no próprio nginx sem Caddy.** Exigiria gestão manual de
  certificados; o perfil `tls` com Caddy automatiza emissão/renovação. Rejeitado
  como padrão, mantido como opção.

## Consequências

**Positivas**

- SPA em CDN global, deploy por push em `main`, previews e rollback rápidos.
- Stack de produção reproduzível em qualquer host com Docker, com saúde,
  migração automática e volumes declarados.
- Same-origin simplifica CSP/CORS e faz webhooks/WebSocket funcionarem no mesmo
  domínio; Caddy opcional resolve HTTPS sem intervenção manual.
- Backup/restore e runbook fazem parte do artefato, não da memória da equipe.

**Negativas**

- Duas superfícies de deploy (Vercel + host Docker) e risco de **version skew**:
  o SPA é compilado com `VITE_API_BASE_URL` fixo e uma API antiga pode quebrar a
  UI nova.
- O host Docker é responsabilidade do operador: patches, disco, DNS, TLS,
  rotação de segredos, backup off-site e monitoramento.
- O `docker-compose.prod.yml` usa `pull_policy: never` e imagens construídas
  localmente; sem um registry, cada host precisa buildar as duas imagens.
- TLS é opt-in: sem o perfil `tls`, o stack expõe HTTP na porta 8080 e depende de
  um proxy externo para HTTPS.
- `TRUST_PROXY=false` é o default seguro; atrás de Caddy/edge é preciso
  configurá-lo, senão o rate limit vê todos os clientes com o IP do proxy.
- S3 é externo: não há storage no compose, e a indisponibilidade do bucket afeta
  anexos e backups por tenant.

## Referências

- [`vercel.json`](../../vercel.json).
- [`docker-compose.prod.yml`](../../docker-compose.prod.yml).
- [`apps/web/Dockerfile`](../../apps/web/Dockerfile) e
  [`apps/web/nginx.conf`](../../apps/web/nginx.conf).
- [`deploy/Caddyfile`](../../deploy/Caddyfile).
- [`packages/server/Dockerfile`](../../packages/server/Dockerfile).
- [`scripts/db-backup.mjs`](../../scripts/db-backup.mjs) e
  [`scripts/db-restore.mjs`](../../scripts/db-restore.mjs).
- [`docs/RUNBOOK.md`](../RUNBOOK.md) §5–§6.
- [`docs/PHASE4_BACKUP_RESTORE.md`](../PHASE4_BACKUP_RESTORE.md).
- [`docs/SETUP_PRODUCTION.md`](../SETUP_PRODUCTION.md).
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
