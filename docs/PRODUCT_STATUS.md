# IntegrAI — estado consolidado do produto (nov/2026)

> Documento de handoff: o que está no ar, como validar, como operar e o que depende
> de credenciais externas. Evidências detalhadas em
> [LIVE_VALIDATIONS.md](LIVE_VALIDATIONS.md), [SECURITY.md](SECURITY.md) e
> [ENTERPRISE_SSO.md](ENTERPRISE_SSO.md).

## Links

| O quê | Onde |
|---|---|
| Aplicação (landing + login + workspace) | https://integrai-dev.vercel.app |
| Status público | https://integrai-dev.vercel.app/status |
| Guia de setup dos marketplaces | https://integrai-dev.vercel.app/setup |
| Perfil / sessões | https://integrai-dev.vercel.app/profile |
| Administração | https://integrai-dev.vercel.app/admin |
| Ajustes (2FA, SSO corporativo, LGPD) | https://integrai-dev.vercel.app/settings |
| Repositório | https://github.com/xploryngDAO/IntegrAI |
| CI | https://github.com/xploryngDAO/IntegrAI/actions |

Acesso de administrador do ambiente de demonstração: `admin@integr-ai.local`
(senha em `ADMIN_PASSWORD`, fora do repositório).

## O que existe hoje

### Autenticação e identidade
- Login por senha com JWT (1h) + refresh rotativo, sessões revogáveis
- 2FA TOTP + códigos de recuperação (setup, verificação, regeneração, disable)
- **SSO corporativo OIDC** (Microsoft Entra ID, Google, Okta): state HMAC single-use,
  nonce, PKCE S256, validação JWKS/iss/aud/exp, domínio permitido, JIT com grupo→papel,
  `enforceSso` com break-glass de platform admin, código one-time no callback
- Recuperação de senha, verificação de e-mail, convites com expiração/reenvio
- **Logout** (este navegador ou todos os dispositivos), revogação imediata de access
  token (jti), watermark por usuário (reset de senha invalida tokens antigos)
- Alertas por e-mail: **novo dispositivo** no login e **mudança de papel/status** da conta
- RBAC ADMIN/SUPERVISOR/AGENT com proteção do último ADMIN e bloqueio de auto-alteração

### Operação omnichannel
- Fila unificada com SLA, chat, composer adaptativo, cockpit 360º
- Canais reais: Amazon SP-API/SES, Mercado Livre, Shopee Open Platform v2
- Webhooks com HMAC/idempotência, filas BullMQ com backoff/jitter/DLQ
- Contas por marketplace com OAuth, diagnóstico por canal (`/diagnostics`, `doctor`)
- Onboarding guiado + `/setup` com valores copiáveis (App ID, redirect, webhook, escopos)

### Administração (tenant)
- Visão geral: usuários, sessões ativas, convites, contas por canal, tickets, auditoria 24h
- Usuários: busca, filtros, paginação, export CSV, papel, ativar/desativar, revogar sessões
- Convites: listar, revogar, **reenviar** (novo token/TTL), status PENDING/EXPIRED/ACCEPTED
- Sessões ativas com dispositivo/IP/última atividade e revogação (409 na própria)
- Logs de auditoria: filtros por ação/ator/período, paginação, export CSV
- **Exportações auditadas** (`admin.users.exported`, `admin.audit.exported`) com filtros e rowCount

### Segurança / LGPD
- Cifra AES-256-GCM de credenciais, tokens nunca em logs, PII redigida
- Headers/CSP/HSTS/COOP, CORS fail-closed, limites de body/timeout, rate limits (auth e global por IP)
- `npm run doctor`, `/status`, `/diagnostics`, incidente/LGPD em [SECURITY.md](SECURITY.md)
- Exportação e eliminação de dados do workspace (soft delete + purga física + backup/restore)

### Infra e qualidade
- **946 testes** (unit + HTTP), `tsc` server/web, builds, CI verde incluindo build da imagem Docker
- Imagem `packages/server/Dockerfile` + `docker-compose.prod.yml` (API+Postgres+Redis) validados
- Vercel reproducible (design system vendorizado em `vendor/`)
- Scripts de validação: `validate:live`, `test:live-2fa`, `test:live-sso`,
  `test:live-socket`, `isolation-test`, `verify-live` (Edge limpo)

## Como rodar

Desenvolvimento:
```bash
npm ci && npm run dev          # API + web (Vite)
npm run db:seed                # cria tenant + ADMIN
```

Produção (stack validada):
```bash
cp .env.prod.example .env.prod # preencha segredos
docker build -f packages/server/Dockerfile -t sac-hub-api:prod .
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
DATABASE_URL=postgresql://sac:<senha>@127.0.0.1:55433/sac_hub \
  ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:seed
```

## Validação rápida

```bash
npm run build:shared
npx tsc -p packages/server/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npx vitest run
npm run validate:live      # 11 cenários contra a API publicada
node scripts/isolation-test.mjs   # 14 checagens multi-tenant
node scripts/verify-live.mjs https://integrai-dev.vercel.app <email> <senha>
```

## Pendências externas (bloqueios)

1. **SSO Microsoft Entra real** — criar App registration no tenant da organização e
   informar `issuer`, client ID, client secret e redirect
   `<api>/api/v1/auth/sso/callback` (passo a passo em
   [ENTERPRISE_SSO.md](ENTERPRISE_SSO.md)). O fluxo já passou em IdP OIDC local (10/10).
2. **Hospedagem definitiva da API** — este ambiente usa túnel HTTPS temporário; a imagem
   Docker e o compose estão prontos para uma VPS/VM/Cloud.
3. **Majors de dependências** (Prisma 7, nodemailer 10, zod 4, react-router 7) e
   pentest externo — plano documentado em [SECURITY.md](SECURITY.md).

## Arquitetura (resumo)

Monorepo npm workspaces:
- `packages/shared` — DTOs, portas, enums, regras puras
- `packages/server` — Fastify 5, Prisma 6/PostgreSQL 16, Redis 7/BullMQ 5, S3, adapters por canal
- `apps/web` — React 18 + Vite + Tailwind + Convergência Design System

Hexagonal/ports & adapters, event-driven (webhooks → fila → domínio → tempo real via Socket.IO).
