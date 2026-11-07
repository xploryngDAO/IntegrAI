# Handoff — como concluir o go-live

Estado em **2026-11-06**: aplicação publicada e validada; restam apenas acessos externos.
Este documento lista o que já está pronto, o que falta e os comandos exatos.

## 1. O que está no ar

| Item | URL / como acessar |
|---|---|
| SPA (produção) | https://integrai-dev.vercel.app |
| API (atual) | túnel Cloudflare do ambiente de setup (ver `apps/web/runtime-config.json`) |
| Status público | https://integrai-dev.vercel.app/status |
| Console de plataforma | https://integrai-dev.vercel.app/platform (conta platform admin) |
| Admin do workspace | https://integrai-dev.vercel.app/admin |

Credenciais do ambiente de teste estão em `.env` (não versionado) e na documentação privada;
`npm run db:seed` recria o ADMIN.

## 2. Evidências já coletadas

- **1073 testes**; `test:live:all` → **15/15 etapas** na produção (verify-live, validate 11,
  isolamento 14, probe 18, 2FA policy/API/UI, SSO API/UI, socket, signup+convite 26,
  signup/convite/reset UI, a11y).
- a11y: **21 telas** (públicas + autenticadas, desktop + formulários no mobile) nos temas
  claro e escuro, 0 violações; Lighthouse 100/100/100/100 nas páginas públicas.
- Segurança: `npm audit`/OSV **0** (inclusive dev), gitleaks limpo, semgrep gate no CI,
  imagens 0 HIGH/CRITICAL, ZAP baseline **0 FAIL** (riscos aceitos documentados).
- Performance: health 222 RPS / status 233 RPS p99 ~95 ms no host público (10 conexões);
  Web Vitals LCP 72–488 ms, CLS ≤ 0,001 no workspace autenticado.
- Detalhes: [LIVE_VALIDATIONS.md](LIVE_VALIDATIONS.md), [RELEASE_CANDIDATE.md](RELEASE_CANDIDATE.md),
  [SECURITY.md](SECURITY.md), [PERFORMANCE.md](PERFORMANCE.md).

### Rodar a bateria inteira (um comando)

```bash
npm run test:live:all          # 14 etapas; --skip-ui/--skip-a11y/--only=...
npm run perf:vitals            # Web Vitals no workspace
npm run a11y:...              # scripts/a11y-audit.mjs <url> [--dark]
```

## 3. O que falta (issues no GitHub)

| Issue | Tarefa | Precisa de você |
|---|---|---|
| [#1](https://github.com/xploryngDAO/IntegrAI/issues/1) | App registration no Entra ID + SSO real | **sim** (login no tenant; `entra-provision` + `sso:apply` prontos) |
| [#2](https://github.com/xploryngDAO/IntegrAI/issues/2) | VM/domínio definitivo da API com TLS | **sim** (host/DNS; `host:check` pronto) |
| [#3](https://github.com/xploryngDAO/IntegrAI/issues/3) | Pentest externo (briefing + ZAP prontos) | **sim** (contratação) |
| [#4](https://github.com/xploryngDAO/IntegrAI/issues/4) | SMTP de produção | **sim** (provedor/credenciais; `email:check`/`smtp:doctor`) |

Issues #5, #6 e #7 (redeploys/a11y/Lighthouse) estão **fechadas** — produção em
`assets/index-Nw17pUz4.js`.

## 4. Entra ID (issue #1) — caminho rápido

```bash
# 1) cria o App registration via device code (você autentica no navegador, 15 min)
node scripts/entra-provision.mjs --redirect=<API_PUBLICA>/api/v1/auth/sso/callback

# 2) valida a configuração (11 checks OIDC)
node scripts/sso-doctor.mjs --issuer=<issuer> --client-id=<id> --secret=<secret> \
  --redirect-uri=<API_PUBLICA>/api/v1/auth/sso/callback --domains=suaempresa.com

# 3) aplica a conexão e roda os 10 checks automaticamente (ADMIN):`nnode scripts/sso-apply.mjs --domains=suaempresa.com`n# 4) em /settings -> Autenticação corporativa: conferir e "Testar conexão"
# 4) login real com "Entrar com Microsoft"
```

## 5. Host da API (issue #2)

```bash
# na VM com Docker:
cp .env.prod.example .env.prod   # segredos reais (JWT, encryption, S3, SMTP, webhooks)
docker build -f packages/server/Dockerfile -t sac-hub-api:prod .
docker build -f apps/web/Dockerfile -t sac-hub-web:prod .
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
# antes de apontar o SPA, valide o host:\n# node scripts/host-check.mjs --api=https://api.seudominio.com --web=https://integrai-dev.vercel.app\n# (inclui checagem de que o runtime-config.json publicado aponta para esse host)\n\n# HTTPS automático (após DNS):
docker compose --env-file .env.prod -f docker-compose.prod.yml --profile tls up -d

# aponta o SPA publicado para a API definitiva:
node scripts/tunnel-sync.mjs https://api.seudominio.com
git add apps/web/runtime-config.json && git commit -m "chore: API definitiva" && git push
```

Monitoramento opcional: `--profile observability` (Prometheus + Grafana provisionados).
Runbook: [RUNBOOK.md](RUNBOOK.md).

## 6. SMTP (issue #4)

1. Configurar `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM` no `.env.prod` (SES, SendGrid ou corporativo).
   - **Hostinger (plano atual):** `SMTP_HOST=smtp.hostinger.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`,
     `SMTP_USER=<caixa@dominio>`, `SMTP_PASSWORD=<senha da caixa>`,
     `SMTP_FROM="IntegrAI <nao-responda@dominio>"`. Requer uma caixa de e-mail criada no hPanel.
2. SPF/DKIM/DMARC do domínio remetente (o Hostinger publica os registros ao criar a caixa;
   conferir no DNS do domínio). Para volume alto, SES com domínio verificado é a opção mais barata.
3. Validar:
   ```bash
   node --env-file=.env.prod scripts/email-check.mjs --to=seu-email@empresa.com
   ```
   Depois: `POST /auth/forgot-password` (link abre no SPA), convite em `/admin`, login de novo dispositivo.

## 7. Redeploy do SPA (issue #5)

```bash
npx vercel --prod --yes
node scripts/a11y-audit.mjs https://integrai-dev.vercel.app   # 10 telas, 0 violações
```

## 7.1 SPA alternativo no GitHub Pages`n`nO branch `gh-pages` ja contem o build atual (`index-7e5sbE_A.js`, base `/IntegrAI/`); para ativar: **Settings -> Pages -> Deploy from a branch -> gh-pages / root**. URL: https://xploryngdao.github.io/IntegrAI/ (CORS da API ja autoriza). Validado localmente servindo o dist em `/IntegrAI/`.  `n`n## 8. Depois do go-live

- Rodar `npm run validate:live`, `isolation-test` e `security-probe` no host novo.
- Ativar backup diário off-site (`npm run db:backup` + cópia para S3).
- Acompanhar alertas (readiness, 5xx, latência) — ver [RUNBOOK.md](RUNBOOK.md).
- Agendar reteste de pentest após correções.

## Vercel — configuração do projeto

- Projeto `integrai-dev` é **Git-connected** (`xploryngDAO/IntegrAI`): push na
  main dispara deploy de produção (sujeito à cota diária do plano Hobby).
- `nodeVersion` fixado em **22.x** (LTS) via API, alinhado ao CI/local; antes
  estava em 26.x (não-LTS).
- Runtime-config continua sendo a fonte da API em boot; o deploy só muda o bundle.
- Envs `VITE_API_BASE_URL`/`VITE_WS_URL` (production) atualizadas em 2026-11-06 para o túnel atual;
  ao trocar para o VPS, atualizar runtime-config + essas duas envs antes do deploy.

## Auditoria de infraestrutura (2026-11-06)

- Conta Hostinger: 1 plano **Premium compartilhado** (`personia.me`), **0 VPS**;
  domínios ativos `personia.me`, `frequency.space`, `canvaslabs.studio`, `canvaslabs.com.br`.
- O compartilhado não serve para a API: ela exige **PostgreSQL 16 + Redis 7**
  (o plano oferece MySQL) — subdomínio só é útil depois de existir host/DB.
- Caminhos para #2: (a) VPS 2 vCPU/4 GB + `deploy/` (API+Postgres+Redis+Caddy);
  (b) gerenciados (Postgres/Redis + host Node) com `DATABASE_URL`/`REDIS_URL`;
  (c) túnel atual como transitório.
- Nenhuma compra/DNS foi alterada. Detalhes no comentário da issue #2.
- Provisionamento em 1 comando: `scripts/provision-vps.sh` (Docker, firewall, .env com
  segredos, build das imagens, stack TLS + health check, rotação de log do Docker e backup
  diário do Postgres com 14 dias). Portas de Postgres/Redis/API/web
  agora escutam apenas em 127.0.0.1; público somente 22/80/443 via Caddy.

### Opções de VPS (catálogo 2026-11-06)

| Plano | Recursos | Anual (1º período) | Observação |
|---|---|---|---|
| KVM 1 | 1 vCPU · 4 GB · 50 GB | R$ 395,88 (~R$ 32,99/mês) | suficiente para a stack atual |
| KVM 2 | 2 vCPU · 8 GB · 100 GB | R$ 599,88 (~R$ 49,99/mês) | **recomendado** para produção inicial |
| KVM 4 | 4 vCPU · 16 GB · 200 GB | R$ 839,88 | folga para growth |

Sem compra feita; decisão registrada na issue #2.

## Banco/Redis gerenciados (alternativa ao VPS com containers)

Se você já tem Postgres/Redis gerenciados, o overlay `docker-compose.managed.yml`
sobe só API + web + Caddy, apontando para as URLs externas:

```bash
DATABASE_URL='postgresql://user:pass@host:5432/db?schema=public' \
REDIS_URL='rediss://default:pass@host:6379' \
DOMAIN=api.suaempresa.com APP_BASE_URL=https://api.suaempresa.com \
WEB_ORIGIN=https://integrai-dev.vercel.app \
JWT_SECRET=... ENCRYPTION_MASTER_KEY=... \
S3_ENDPOINT=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
bash scripts/provision-vps.sh
```

Antes de provisionar, valide as URLs com `npm run check:managed` (TLS, versão, latência e
migrações Prisma). O script detecta as duas URLs, escreve no `.env.prod`, usa o overlay
(sem Postgres/Redis locais), aplica migrações no boot e valida `/health/ready`. Backup/restore
também passam a usar as URLs externas (`pg_dump "$DATABASE_URL"`).
