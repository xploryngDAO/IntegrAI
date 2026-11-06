# Release candidate — IntegrAI / SAC Hub

**Baseline:** `eb5f39d` (2026-11-06) · **Status:** RC aprovado para homologação self-hosted;
go-live público condicionado aos itens da seção 6.

## 1. Escopo entregue

| Área | Entrega |
|---|---|
| Canais | Amazon SP-API/SES, Mercado Livre e Shopee v2 (adapters reais, webhooks assinados, retry/DLQ) |
| Atendimento | Fila unificada, cockpit 3 colunas, SLA, Socket.IO, anexos, respostas rápidas |
| Identidade | Senha + JWT/refresh rotativo, 2FA TOTP/recovery, convites, reset, verificação de e-mail |
| Empresa | SSO OIDC (Entra/Google/Okta) com PKCE/nonce/one-time code, `enforceSso`, break-glass, política 2FA, **testar conexão SSO** |
| Admin | Visão geral, usuários (filtros/CSV), convites, sessões, auditoria (filtros/CSV), logs |
| LGPD | Export/erasure/purge, retenção, mapa de dados, ROPA/gaps, incidente (Res. 15/2024) |
| Operação | request-id, `/health/ready`, `/metrics`, manutenção, backup/restore, TLS (Caddy), Prometheus/Grafana |
| Qualidade | 1073 testes, CI (test/security/a11y/imagens), gitleaks, WCAG AA |

## 2. Evidências desta baseline

Comandos executados em 2026-11-06 (todos com exit 0):

```text
npm run build:shared                         exit 0
tsc packages/server --noEmit                 exit 0
tsc apps/web --noEmit                        exit 0
npx vitest run                               exit 0 — 1073 testes
npm run build:server                         exit 0
npm run build --workspace @sac/web           exit 0
```

Validações contra a API real:

```text
validate:live            11/11 cenários
isolation-test           14/14 verificações
security-probe           18/18 verificações
/health/ready            ready · database=ok · redis=ok · storage=ok
a11y (6 rotas)           0 violações (WCAG 2.1 AA)
verify-live (bundle)     landing/login/sessão/perfil/admin/logout OK
```

CI (GitHub Actions): `CI` e `Security` verdes para `ade2b24`/`eb5f39d`
(Security = gitleaks + isolamento + sonda + WCAG AA na preview efêmera).

## 3. Como executar (self-hosted, opção recomendada até o host definitivo)

```bash
cp .env.prod.example .env.prod   # preencher segredos reais
docker build -f packages/server/Dockerfile -t sac-hub-api:prod .
docker build -f apps/web/Dockerfile -t sac-hub-web:prod .
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
# HTTPS: ... --profile tls up -d   |   Monitoramento: ... --profile observability up -d
```

Já validado: stack healthy, seed, login, perfil, admin, logout, a11y no bundle servido e
backup/restore do Postgres (marker restaurado).

## 4. Deploy público

| Item | Situação | Ação |
|---|---|---|
| Vercel | **publicado em 2026-11-06** em `https://integrai-dev.vercel.app` (bundle atual com runtime-config; API via túnel) | redeploys: `vercel --prod` ou `npm run deploy:vercel` |
| GitHub Pages | workflow manual pronto (alternativa) | habilitar Settings → Pages → GitHub Actions |
| API/host | stack Docker pronta e validada; hoje a API roda local atrás do Cloudflare tunnel | provisionar VM/domínio e apontar `WEB_ORIGIN`/DNS + `runtime-config.json` |

## 5. Segurança e privacidade

- `npm audit --omit=dev`: 0 vulnerabilidades
- gitleaks: 0 vazamentos (127 commits; baseline revisado em `.gitleaksignore`)
- Sonda 18/18 (headers, JWT, CORS, 415, injeção, rate limit, RBAC)
- Isolamento multi-tenant 14/14
- Segredos cifrados (AES-256-GCM), JWT curto + refresh rotativo/denylist, 2FA, sessões revogáveis
- Pentest externo **ainda não realizado** (bloqueia go-live público)
- Imagens Docker: **trivy 0 HIGH/CRITICAL** (API sem npm/npx no runtime; web em nginx:stable-alpine), varredura no CI
- **Identidade de build**: `GET /version` (público) expõe `version/commit(GIT_SHA)/node/env/uptime`; CI injeta o SHA na imagem Docker.`n- **Produção recusa segredos de dev**: JWT/criptografia default, `SHOPEE_PARTNER_KEY` ausente,
  credenciais S3 `minioadmin`, CORS curinga (`WEB_ORIGIN=*`) e `TRUST_PROXY=true` bloqueiam o boot
  (`Unsafe production secrets`).
- **Webhooks autenticados**: Shopee HMAC com chave obrigatória; Amazon SES HMAC; Mercado Livre com segredo na
  Callback URL (fail closed sem segredo); billing HMAC. Assinatura inválida → 401, sem processar evento.
- SAST semgrep: 0 achados em código de produção (14 em fixtures de teste)
- `TRUST_PROXY=127.0.0.1` atrás do túnel: X-Forwarded-For forjado é ignorado (IP real do edge no rate limit/auditoria)
- **Deploy público verificado**: E2E (landing/login/sessão/perfil/admin/logout) e axe WCAG AA em 21 telas (8 desktop + 2 mobile)
  diretamente em `https://integrai-dev.vercel.app`

## 6. Bloqueios para go-live público (requerem o cliente)

1. **Microsoft Entra ID** — App registration (issuer, client ID, secret, redirect)
   → validar com `node scripts/sso-doctor.mjs` e “Testar conexão” em `/settings`.
2. **Host/domínio da API** — VM + DNS + TLS (compose/Caddy prontos); hoje a API usa o túnel local.
3. **Pentest externo** — obrigatório antes de exposição comercial.
4. SMTP de produção (SES/SMTP) para e-mails de convite/2FA/alerta.

> Acompanhamento no GitHub: #1 Entra ID · #2 Host da API · #3 Pentest · #4 SMTP · #5 Redeploy Vercel.`n`n## 7. Rollback

- Imagens: rebuild a partir do commit anterior (`git checkout <sha>` + `docker build` + `up -d`).
- Banco: `npm run db:restore backups/db-<ts>.sql` (backup antes do upgrade).
- Migrações são aditivas; avaliar down migration manual em mudanças destrutivas.
- Runbook completo: [RUNBOOK.md](RUNBOOK.md).

## 8. Decisão

**GO** para homologação interna/self-hosted e **demo pública na Vercel** (evidências acima).
**NO-GO** para produção comercial até concluir os itens 1, 2, 3 e 4 da seção 6.
