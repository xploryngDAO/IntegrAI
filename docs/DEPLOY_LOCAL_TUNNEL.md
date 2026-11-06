# MVP sem VPS: API local + túnel + SPA na Vercel

O frontend está na Vercel, mas o backend (Fastify + workers + Postgres + Redis)
precisa de um host. No MVP ele roda nesta máquina e é exposto por um túnel HTTPS
do Cloudflare. **Nenhum deploy da Vercel é necessário quando a URL do túnel
muda**: o SPA resolve a API em runtime (ver abaixo).

## Componentes

| Componente | Endereço local | Observação |
|---|---|---|
| API (stack completo) | `http://127.0.0.1:4101` | `node --env-file=.env packages/server/dist/index.js` |
| PostgreSQL 16 | `127.0.0.1:55432` | container `sac-postgres` |
| Redis 7 | `127.0.0.1:56379` | container `sac-redis` |
| S3 compatível (`s3rver`) | `http://127.0.0.1:4568` | buckets `sac-hub-raw`, `sac-hub-attachments` |
| Túnel público | `https://<random>.trycloudflare.com` | muda a cada reinício |
| SPA | https://integrai-dev.vercel.app | lê `apps/web/runtime-config.json` no boot |

## Configuração em runtime (a peça que evita redeploys)

`apps/web/src/lib/runtimeConfig.ts` resolve `apiBaseUrl` e `wsUrl` **antes do
primeiro render**, nesta ordem:

1. `apps/web/runtime-config.json` publicado na `main` (GitHub raw, CORS `*`);
2. último config válido em `localStorage` (GitHub fora do ar/perda de rede);
3. `VITE_API_BASE_URL` / `VITE_WS_URL` gravados no build;
4. `/api/v1` e same-origin (stack self-hosted).

O arquivo é pequeno e versionado de propósito:

```json
{
  "apiBaseUrl": "https://<tunnel>/api/v1",
  "wsUrl": "https://<tunnel>",
  "updatedAt": "2026-11-06T12:00:00.000Z"
}
```

Fluxo quando o túnel reinicia:

```bash
node scripts/tunnel-sync.mjs https://<nova-url>.trycloudflare.com
# 1. valida /api/v1/health/ready antes de escrever qualquer coisa
# 2. reescreve apps/web/runtime-config.json
# 3. reescreve APP_BASE_URL / MELI_REDIRECT_URI / SHOPEE_REDIRECT_URI no .env

git add apps/web/runtime-config.json
git commit -m "chore(runtime): aponta o SPA para o novo túnel"
git push
```

O SPA publicado passa a usar a nova URL no próximo carregamento (o fetch usa
cache-buster para furar o cache de 5 min do GitHub raw). **Não rode
`vercel deploy` só por causa do túnel.** O push dispara o build automático da
Vercel porque o projeto é Git-connected; se esse build for cancelado ou falhar
por cota, o site que já está no ar continua lendo o `runtime-config.json` novo —
o deploy só é necessário quando o **código** da SPA muda.

> Se a Vercel responder `api-deployments-free-per-day`, a cota diária do plano
> Hobby (100 deploys/24 h) acabou: aguarde o reset (~24 h) ou faça upgrade para
> Pro. O site que já está no ar continua funcionando; só a publicação de código
> novo fica bloqueada.

## Como reproduzir o ambiente

```bash
# 1. infraestrutura
docker compose up -d postgres redis
npx s3rver -d .s3-data -a 127.0.0.1 -p 4568 --no-vhost-buckets \
  --allow-mismatched-signatures \
  --configure-bucket sac-hub-raw --configure-bucket sac-hub-attachments

# 2. API (HOST=127.0.0.1 + TRUST_PROXY=true no .env para o IP real atrás do túnel)
node --env-file=.env packages/server/dist/index.js

# 3. URL pública
npx cloudflared tunnel --url http://127.0.0.1:4101 --no-autoupdate
# copie a URL https://xxx.trycloudflare.com

# 4. sincronize runtime config + .env
node scripts/tunnel-sync.mjs https://xxx.trycloudflare.com
git add apps/web/runtime-config.json && git commit -m "chore(runtime): tunnel" && git push

# 5. (opcional) publicação deliberada da SPA, já com os envs do túnel atual:
node scripts/deploy-vercel.mjs
```

## IP real atrás do túnel

Com o túnel, toda requisição chega de `127.0.0.1`. Sem `TRUST_PROXY`, o rate
limit por IP e a auditoria usariam o loopback para **todos** os operadores. Por
isso o `.env` local usa:

```dotenv
HOST=127.0.0.1
TRUST_PROXY=true
```

O bind em loopback impede que alguém na LAN forje `X-Forwarded-For` e burle o
rate limit. Em Docker/self-hosted o padrão continua `HOST=0.0.0.0` e
`TRUST_PROXY` deve ser a lista de CIDRs do edge (ver `docs/SECURITY.md` §6.8).

## Diagnóstico

```bash
npm run doctor
# ou, de qualquer lugar:
curl https://<tunnel>/api/v1/health/ready
```

O `GET /api/v1/diagnostics` (ADMIN) e o botão *Testar conexão* em `/accounts`
fazem chamadas reais e mostram o que falta para cada marketplace.

## Limitações conhecidas do MVP

- O túnel gratuito **não tem SLA** e depende desta máquina ligada.
- **E-mail transacional**: o `.env` atual aponta para o Mailpit local; cadastro,
  convite e reset não chegam a caixas reais. Configure um SMTP real
  (Resend/Brevo/SES/SendGrid) antes de abrir para usuários externos.
- **Marketplaces**: só o Mercado Livre está credenciado; Amazon e Shopee
  precisam das credenciais (`npm run doctor` lista o que falta).
- Sem SSO corporativo (Entra) e sem pentest externo — ver `docs/GO_LIVE.md`.
- Quando houver host definitivo (Railway/Render/Fly/VPS), basta trocar
  `apiBaseUrl`/`wsUrl` no `runtime-config.json`; o SPA não precisa de rebuild.
