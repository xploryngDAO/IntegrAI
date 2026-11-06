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

- `1069` testes; `validate:live` 11/11; isolamento 14/14; sonda 18/18; suítes 2FA 13/13,
  SSO 10/10, socket 5/5, signup 26/26, signup UI 8/8, convite UI 11/11.
- a11y: 10 telas (8 desktop + 2 mobile) com 0 violações; Lighthouse mobile a11y 100 (build atual).
- Segurança: 0 vulns de produção; imagens 0 HIGH/CRITICAL (trivy); gitleaks 0; SAST semgrep 0 em produção.
- Detalhes: [LIVE_VALIDATIONS.md](LIVE_VALIDATIONS.md), [RELEASE_CANDIDATE.md](RELEASE_CANDIDATE.md),
  [SECURITY.md](SECURITY.md).

## 3. O que falta (issues no GitHub)

| Issue | Tarefa | Precisa de você |
|---|---|---|
| [#1](https://github.com/xploryngDAO/IntegrAI/issues/1) | App registration no Entra ID + SSO real | **sim** (login no tenant) |
| [#2](https://github.com/xploryngDAO/IntegrAI/issues/2) | VM/domínio definitivo da API com TLS | **sim** (host/DNS) |
| [#3](https://github.com/xploryngDAO/IntegrAI/issues/3) | Pentest externo | **sim** (contratação) |
| [#4](https://github.com/xploryngDAO/IntegrAI/issues/4) | SMTP de produção | **sim** (provedor/credenciais) |
| [#5](https://github.com/xploryngDAO/IntegrAI/issues/5) | Redeploy Vercel (fixes a11y mobile) | cota/upgrade |

## 4. Entra ID (issue #1) — caminho rápido

```bash
# 1) cria o App registration via device code (você autentica no navegador, 15 min)
node scripts/entra-provision.mjs --redirect=<API_PUBLICA>/api/v1/auth/sso/callback

# 2) valida a configuração (11 checks OIDC)
node scripts/sso-doctor.mjs --issuer=<issuer> --client-id=<id> --secret=<secret> \
  --redirect-uri=<API_PUBLICA>/api/v1/auth/sso/callback --domains=suaempresa.com

# 3) em /settings -> Autenticação corporativa: salvar e "Testar conexão"
# 4) login real com "Entrar com Microsoft"
```

## 5. Host da API (issue #2)

```bash
# na VM com Docker:
cp .env.prod.example .env.prod   # segredos reais (JWT, encryption, S3, SMTP, webhooks)
docker build -f packages/server/Dockerfile -t sac-hub-api:prod .
docker build -f apps/web/Dockerfile -t sac-hub-web:prod .
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
# HTTPS automático (após DNS):
docker compose --env-file .env.prod -f docker-compose.prod.yml --profile tls up -d

# aponta o SPA publicado para a API definitiva:
node scripts/tunnel-sync.mjs https://api.seudominio.com
git add apps/web/runtime-config.json && git commit -m "chore: API definitiva" && git push
```

Monitoramento opcional: `--profile observability` (Prometheus + Grafana provisionados).
Runbook: [RUNBOOK.md](RUNBOOK.md).

## 6. SMTP (issue #4)

1. Configurar `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM` no `.env.prod` (SES, SendGrid ou corporativo).
2. SPF/DKIM/DMARC do domínio remetente.
3. Validar: `POST /auth/forgot-password` (link abre no SPA), convite em `/admin`, login de novo dispositivo.

## 7. Redeploy do SPA (issue #5)

```bash
npx vercel --prod --yes
node scripts/a11y-audit.mjs https://integrai-dev.vercel.app   # 10 telas, 0 violações
```

## 7.1 SPA alternativo no GitHub Pages`n`nO branch `gh-pages` ja contem o build com base `/IntegrAI/`; para ativar: **Settings -> Pages -> Deploy from a branch -> gh-pages / root**. URL: https://xploryngdao.github.io/IntegrAI/ (CORS da API ja autoriza). Validado localmente servindo o dist em `/IntegrAI/`.  `n`n## 8. Depois do go-live

- Rodar `npm run validate:live`, `isolation-test` e `security-probe` no host novo.
- Ativar backup diário off-site (`npm run db:backup` + cópia para S3).
- Acompanhar alertas (readiness, 5xx, latência) — ver [RUNBOOK.md](RUNBOOK.md).
- Agendar reteste de pentest após correções.
