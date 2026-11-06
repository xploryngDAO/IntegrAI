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

## 7. Incidentes (LGPD + segurança)

1. Contenha: revogar sessões/2FA dos afetados (`/admin/users/:id/revoke-sessions`, reset-2FA),
   rotacionar segredos se houver suspeita de vazamento.
2. Avalie notificabilidade (LGPD Art. 48; Res. CD/ANPD nº 15/2024 — até 3 dias úteis).
3. Registre em `.lgpd/incidents/log.md` (retenção 5 anos) e siga [SECURITY.md](SECURITY.md).
4. Comunique ANPD/titulares quando aplicável (checkpoint humano/jurídico).

## 8. Falhas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
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
