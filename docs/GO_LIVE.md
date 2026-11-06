# Go-live checklist — IntegrAI

> Estado técnico atual: aplicação e API validadas (993 testes, 0 vulnerabilidades de
> produção, WCAG AA, isolamento multi-tenant, sonda de segurança). Este checklist
> lista o que falta para produção comercial e quem depende de quê.

## 1. Infraestrutura da API

- [ ] Provisionar host (VM/VPS/Cloud) com Docker + Compose
- [ ] `cp .env.prod.example .env.prod` e preencher segredos reais
      (`POSTGRES_PASSWORD`, `JWT_SECRET`, `ENCRYPTION_MASTER_KEY`, `S3_*`, SMTP)
- [ ] `docker build -f packages/server/Dockerfile -t sac-hub-api:prod .`
- [ ] `docker compose --env-file .env.prod -f docker-compose.prod.yml up -d`
- [ ] `DATABASE_URL=... ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:seed`
- [ ] Configurar `TRUST_PROXY` com os CIDRs do edge (rate limit por IP)
- [ ] TLS/domínio da API + healthchecks + restart policy
- [ ] Backup automático do Postgres e do bucket S3

## 2. Frontend (Vercel)

- [ ] `VITE_API_BASE_URL` e `VITE_WS_URL` apontando para a API definitiva
- [ ] `VITE_DOCS_URL` publicado
- [ ] Domínio customizado + HSTS/CSP (já configurados em `vercel.json`)
- [ ] Cota de deploy do plano (hoje free: 100 deploys/dia) adequada ao fluxo

## 3. Identidade corporativa (SSO)

- [ ] Criar **App registration** no Microsoft Entra ID
- [ ] Redirect URI: `<api>/api/v1/auth/sso/callback`
- [ ] Preencher `issuer`, `client ID`, `client secret` em `/settings → Autenticação corporativa`
- [ ] Mapear grupos → papéis (ADMIN/SUPERVISOR/AGENT)
- [ ] Validar login real “Entrar com Microsoft” e então ativar `enforceSso`
- [ ] Garantir break-glass: platform admin (`is_platform_admin`) e recovery codes

## 4. Marketplaces

- [ ] **Mercado Livre**: app já configurado; validar token/refresh em produção
- [ ] **Shopee**: `SHOPEE_PARTNER_ID/KEY`, push URL, redirect URI, sandbox → produção
- [ ] **Amazon**: app público SP-API, LWA, DPP, security assessment, SES inbound/relay
- [ ] Rodar `/setup` para copiar os valores exatos e `/diagnostics` para validar

## 5. Segurança e conformidade

- [ ] **Pentest externo** (aplicação + infraestrutura) antes do go-live
- [ ] WAF/rate limiting de borda (Cloudflare/Vercel) + alertas
- [ ] APM/Sentry + correlação de request-id
- [ ] LGPD: designar/publicar encarregado, política de privacidade, ROPA, DPAs
      (ver `.lgpd/STATUS.md` e `.lgpd/gaps.md`)
- [ ] Plano de resposta a incidentes + registro de 5 anos (Res. 15/2024)
- [ ] Verificar `npm audit --omit=dev` = 0 antes de cada release

## 6. Operação

- [ ] Scrape de métricas em `/api/v1/metrics` com `METRICS_TOKEN` (Prometheus/Grafana)
- [ ] Probes: liveness `/health` e readiness `/health/ready` (Postgres/Redis/S3)
- [ ] Correlação por `x-request-id` (logs + erros) no APM


- [ ] Monitorar `/status` e `/api/v1/health`
- [ ] Cron de purga de tenants e retenção de backups (`BACKUP_RETENTION_DAYS`)
- [ ] Rotina de rotação de segredos (JWT/ENCRYPTION/SMTP/S3)
- [ ] Runbook de suporte: reset de 2FA, revogação de sessões, reenvio de convites
- [ ] Documentar SLA e canais de suporte

## 7. Validação pré-anúncio

```bash
npm run build:shared && npx tsc -p packages/server/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit && npx vitest run
npm run validate:live      # 11 cenários
node scripts/isolation-test.mjs   # 14 checagens
npm run security:probe     # 18 checagens
node scripts/a11y-audit.mjs       # WCAG AA (0 violações)
node scripts/verify-live.mjs https://<app> <email> <senha>
```
