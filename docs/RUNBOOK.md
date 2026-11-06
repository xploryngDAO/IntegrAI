# Runbook de operação — IntegrAI (self-hosted)

> Para o stack Docker da raiz (`docker-compose.prod.yml`). Complementa
> [GO_LIVE.md](GO_LIVE.md), [SECURITY.md](SECURITY.md) e [SETUP_PRODUCTION.md](SETUP_PRODUCTION.md).

## 1. Arquitetura do stack

```
Caddy (443, perfil tls) → web/nginx (SPA + proxy /api,/socket.io,/webhooks) → api (Fastify+Prisma)
                                                                              ├── postgres 16
                                                                              ├── redis 7
                                                                              └── S3 externo (AWS/MinIO/R2)
```

## 2. Comandos do dia a dia

```bash
# base (HTTP em ${WEB_HOST_PORT:-8080})
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d

# com HTTPS automático (exige DOMAIN/DNS e portas 80/443)
docker compose --env-file .env.prod -f docker-compose.prod.yml --profile tls up -d

docker compose --env-file .env.prod -f docker-compose.prod.yml ps
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f api
docker compose --env-file .env.prod -f docker-compose.prod.yml restart api
docker compose --env-file .env.prod -f docker-compose.prod.yml down          # mantém volumes
docker compose --env-file .env.prod -f docker-compose.prod.yml down -v       # APAGA dados
```

Migrações rodam no boot do container `api` (`prisma migrate deploy`). Seed do
primeiro admin: `DATABASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:seed`.

## 3. Segredos e rotação

- `JWT_SECRET` (≥32 chars), `ENCRYPTION_MASTER_KEY` (base64 de 32 bytes), `ENCRYPTION_KEY_ID`,
  `POSTGRES_PASSWORD`, `S3_*`, `SMTP_*`, `METRICS_TOKEN`.
- Produção exige segredos reais: a API **falha ao iniciar** com defaults de desenvolvimento.
- Rotação: gerar novo valor → atualizar `.env.prod` → `docker compose up -d api web`.
  - `JWT_SECRET`: invalida todas as sessões (planeje com usuários).
  - `ENCRYPTION_MASTER_KEY/KEY_ID`: exige re-cifrar segredos antes (chave antiga não é mantida).
  - `METRICS_TOKEN`: scrape do Prometheus passa a exigir o novo token.

## 4. Saúde e monitoramento

Stack de monitoramento opcional: docker compose --env-file .env.prod -f docker-compose.prod.yml --profile observability up -d (Prometheus + Grafana provisionados; requer deploy/observability/METRICS_TOKEN com o mesmo valor de METRICS_TOKEN). Validado: scrape up, dashboard `IntegrAI — API` com 9 painéis.

- Liveness: `GET /health` · Readiness: `GET /health/ready` (DB/Redis/S3, 503 quando degradado)
- Métricas: `GET /api/v1/metrics` com `Authorization: Bearer $METRICS_TOKEN` (Prometheus)
- Correlação: todo request leva `x-request-id` (aceita do cliente; ecoado em logs e erros)
- Página pública: `/status` · Alertas de plataforma: console `/platform`

Sugestão de alertas: readiness != 200, taxa 5xx > 1%, latência p95 > 1s, disco > 80%, backup falhou.

## 5. Backup, restore e DR

```bash
npm run db:backup                    # backups/db-<ts>.sql (pg_dump --clean)
npm run db:restore backups/db-<ts>.sql   # janela de manutenção (destrutivo)
```

- Agendar `db:backup` diário (cron do host) e copiar o arquivo para S3/off-site.
- Drill validado em 06/11: marker → backup 63,8 KB → alteração → restore → marker restaurado.
- Backups por tenant (JSON/S3) e retenção configurável: `BACKUP_RETENTION_DAYS` (cron no worker).
- Restore de tenant: `POST /platform/tenants/:id/backups` + `POST /platform/tenants/restore` (platform admin).

## 6. Upgrade e rollback

```bash
git pull
docker build -f packages/server/Dockerfile -t sac-hub-api:prod .
docker build -f apps/web/Dockerfile -t sac-hub-web:prod .
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

- Migrações são aplicadas no boot; faça **backup antes**.
- Rollback: `git checkout <tag anterior>`, rebuild das imagens e `up -d` (migrações são aditivas;
  avaliar down migration manual se houver mudança destrutiva).
- Janela recomendada: baixo tráfego; monitore `health/ready` e erros pós-deploy.

## 6.1 Janela de manutencao

Defina MAINTENANCE_MODE=true no ambiente da API e reinicie: todas as rotas /api/v1 respondem **503 MAINTENANCE** com Retry-After: 60 e equestId; health/ready/status/metrics permanecem disponiveis, webhooks de marketplace continuam processando e o handshake do Socket.IO e recusado. MAINTENANCE_MESSAGE customiza o texto. Desligue (alse) e reinicie para voltar.

## 7. Incidentes (LGPD + segurança)

1. Contenha: revogar sessões/2FA dos afetados (`/admin/users/:id/revoke-sessions`, reset-2FA),
   rotacionar segredos se houver suspeita de vazamento.
2. Avalie notificabilidade (LGPD Art. 48; Res. CD/ANPD nº 15/2024 — até 3 dias úteis).
3. Registre em `.lgpd/incidents/log.md` (retenção 5 anos) e siga [SECURITY.md](SECURITY.md).
4. Comunique ANPD/titulares quando aplicável (checkpoint humano/jurídico).

## 8. Falhas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
| login 429 em massa | rate limit de tentativas (por e-mail+IP) após testes/ataque | aguardar a janela ou limpar no Redis de dev: `redis-cli --scan --pattern 'sac:auth:login:attempts:*'` + `DEL`; em produção investigue a origem antes de limpar |
| `api` unhealthy | DB/Redis indisponível ou segredo de produção inválido | `logs api`; validar `DATABASE_URL`, `REDIS_URL`, segredos |
| web 502 | API não saudável | `ps`, `logs api`, `health/ready` |
| porta em uso | conflito com outro serviço | ajustar `API_HOST_PORT`/`WEB_HOST_PORT`/`POSTGRES_HOST_PORT` |
| login 403 `SSO_REQUIRED` | política de SSO ativa | usar `Entrar com Microsoft` ou break-glass `is_platform_admin` |
| convite/2FA sem e-mail | SMTP não configurado | configurar `SMTP_*` e testar |
| métricas 404/401 | `METRICS_TOKEN` ausente/errado | definir token e reiniciar a API |

## 9. Checklist periódico

- [ ] Diário: backup do Postgres copiado off-site; readiness/alertas revisados
- [ ] Semanal: `docker compose ps`, uso de disco, erros 5xx e rate limits
- [ ] Mensal: drill de restore; `npm audit --omit=dev`; revisão de acessos ADMIN
- [ ] Trimestral: rotação de segredos; revisão de DPAs/ROPA (LGPD)
- [ ] Anual: pentest; tabletop de incidente

## 10. Publicação do SPA e runtime-config

- **Deploy normal:** `npx vercel --prod --yes` (cota free: 100 deploys/24 h).
  Quando a cota bloqueia (`Resource is limited`), o SPA atual continua no ar;
  use o fallback `gh-pages` ou agende o redeploy.
- **Sem redeploy:** o SPA resolve a API em boot por
  `apps/web/runtime-config.json` (raw GitHub). Trocar API/túnel:
  `node scripts/tunnel-sync.mjs <https://api>` → commit do JSON. O bundle
  publicado passa a usar o novo host no próximo carregamento.
- **Quem está no ar:** `curl -s https://<spa>/ | grep assets/index-` e
  `GET /api/v1/version` (commit via `GIT_SHA`).
- **Validação rápida:** `node scripts/host-check.mjs --api=... --web=...` e
  Lighthouse nas páginas públicas; `npm run test:live:all` para bateria completa.

## 11. Rate limit durante validações (429 falso)

A bateria `test:live:all` dispara muitos logins do mesmo operador/IP; a API
(corretamente) responde 429 no meio. Em ambiente local/dev:

```bash
# limpar buckets (login, 2FA e desafios)
docker exec sac-redis sh -c "redis-cli --scan --pattern 'sac:auth:*attempts*' | while read k; do redis-cli DEL \"$k\"; done"

# A própria bateria limpa entre etapas:
node scripts/live-all.mjs --reset-login-limit
```

Em produção, espere a janela de 15 min. Nunca desative o rate limit para
"fazer o teste passar": ele é controle anti-bruteforce.

## 12. SSO: rotação de JWKS com o mesmo `kid`

Sintoma: callback do SSO volta com `?error=SSO_TOKEN_INVALID` e o log traz
`auth.sso.id_token.rejected {"reason":"signature"}`. Alguns IdPs (e o stub de
teste ao reiniciar) rotacionam a chave **mantendo o mesmo `kid`**.

O `OidcClient` já refaz o fetch do JWKS **uma vez** quando a assinatura falha
(correção validada por teste unitário e E2E de SSO pela UI). Se persistir:

1. confira `jwks_uri`/`issuer` no discovery do IdP;
2. confira o `kid` do token contra o JWKS publicado;
3. como último recurso, reinicie a API para limpar o cache de JWKS.

## 13. Gitleaks: falso positivo novo

O scan usa o histórico completo; um texto de documentação/teste pode casar com
`generic-api-key`. Procedimento:

```bash
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect \
  --source /repo --gitleaks-ignore-path /repo --exit-code 0 \
  --report-format json --report-path /repo/.gitleaks-report.json
# adicione <commit>:<file>:<rule>:<line> ao .gitleaksignore e reescaneie
```

Só ignore após confirmar que o valor é fixture/documentação, nunca um segredo real.

## 14. Monitor de uptime (GitHub Actions)

Workflow `.github/workflows/uptime.yml` roda **a cada 10 minutos** (e por
`workflow_dispatch`) sem serviço externo:

1. lê `apps/web/runtime-config.json` para descobrir a API publicada;
2. checa `GET /api/v1/health/ready` (API) e o SPA (Vercel e Pages);
3. se API ou SPA não responderem 200, **abre/atualiza** a issue
   `[ops] Produção indisponível` com o payload do readiness e o link do run;
4. quando tudo volta a 200, comenta e **fecha** a issue de incidente.

Validação: primeira execução manual (commit `c643e2f`) → `Uptime: success` e
nenhuma issue de incidente criada (sistema saudável). Esse monitor cobre o
período em que a API pública roda em túnel; o stack self-hosted continua com
Prometheus/Grafana (`deploy/observability/`).
