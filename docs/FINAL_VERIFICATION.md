# Verificação final da baseline

**Commit:** `2dd436c` (2026-11-06) · **Ambiente:** API no túnel Cloudflare + SPA na Vercel
(`https://integrai-dev.vercel.app`) + Mailpit local.

## Comandos (todos exit 0)

```text
npm run build:shared
tsc -p packages/server/tsconfig.json --noEmit
tsc -p apps/web/tsconfig.json --noEmit
npx vitest run                 # 1072 testes
npm run build:server
npm run build --workspace @sac/web
```

## Validações ao vivo

| Suite | Resultado | Observação |
|---|---|---|
| `validate:live` | **11/11** | inclui webhook Meli **fail-closed** quando `MELI_WEBHOOK_SECRET` está vazio |
| `isolation-test` | **14/14** | isolamento multi-tenant |
| `security-probe` | **18/18** | headers, JWT, CORS, 415, injeção, rate limit, RBAC |
| `a11y-audit` | **10/10 telas, 0 violações** | 8 desktop + landing/login mobile |
| `/api/v1/health/ready` | `ready` | database=ok · redis=ok · storage=ok |
| `npm audit` / OSV | **0 vulnerabilidades** | full tree + lockfile (581 pacotes) |

## Evidências específicas da rodada

- `scripts/host-check.mjs` → 8/9 obrigatórios + aviso de HSTS (quick tunnel; Caddy aplica em produção)
- `scripts/email-check.mjs` → conexão + entrega validada no Mailpit
- `scripts/tunnel-sync.mjs` → health/ready e regravação de runtime-config/.env
- `apps/web/runtime-config.json` servido pelo raw do GitHub e consumido no boot do SPA

## Fora desta baseline (issues abertas)

- **#1** Entra ID real (script `entra:provision` pronto) · **#2** host/domínio da API ·
  **#3** pentest externo · **#4** SMTP de produção (validador `email:check` pronto) ·
  **#5** redeploy Vercel (cota `100/24h`) — o SPA publicado ainda é o bundle anterior.
- O branch **`gh-pages`** já contém o build atual (base `/IntegrAI/`) como alternativa.

Detalhes por tela/arquivo: [LIVE_VALIDATIONS.md](LIVE_VALIDATIONS.md) ·
[RELEASE_CANDIDATE.md](RELEASE_CANDIDATE.md) · [HANDOFF.md](HANDOFF.md) ·
[SECURITY.md](SECURITY.md).
