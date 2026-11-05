# Rodando a API real com URL pública (túnel) — setup atual

O frontend está na Vercel, mas o backend (Fastify + workers + Postgres + Redis)
precisa de um host. Enquanto não há um servidor definitivo, este ambiente roda a
API real na sua máquina e a expõe por um túnel HTTPS do Cloudflare, sem conta.

## Componentes que estão rodando

| Componente | Endereço local | Observação |
|---|---|---|
| API (stack completo) | `http://127.0.0.1:4101` | `node --env-file=.env packages/server/dist/index.js` |
| PostgreSQL 16 | `127.0.0.1:55432` | container `sac-postgres` |
| Redis 7 | `127.0.0.1:56379` | container `sac-redis` |
| S3 compatível (`s3rver`) | `http://127.0.0.1:4568` | buckets `sac-hub-raw`, `sac-hub-attachments` |
| Túnel público | `https://<random>.trycloudflare.com` | muda a cada reinício |
| SPA | https://integrai-dev.vercel.app | build com `VITE_API_BASE_URL`/`VITE_WS_URL` do túnel |

## Como reproduzir

```bash
# 1. infraestrutura
docker compose up -d postgres redis
npx s3rver -d .s3-data -a 127.0.0.1 -p 4568 --no-vhost-buckets \
  --allow-mismatched-signatures \
  --configure-bucket sac-hub-raw --configure-bucket sac-hub-attachments

# 2. API com as variáveis reais
node --env-file=.env packages/server/dist/index.js

# 3. URL pública
npx cloudflared tunnel --url http://127.0.0.1:4101 --no-autoupdate
# copie a URL https://xxx.trycloudflare.com

# 4. aponte a API e o SPA para a URL nova
#    .env: APP_BASE_URL, MELI_REDIRECT_URI, SHOPEE_REDIRECT_URI, WEB_ORIGIN
#    Vercel: VITE_API_BASE_URL=<url>/api/v1, VITE_WS_URL=<url>
npx vercel deploy --prod
```

> O túnel gratuito **não tem garantia de uptime** e depende desta máquina ligada.
> Para produção real, publique o backend em VM/Railway/Render/Fly com
> `docker compose up -d --build` e aponte `VITE_API_BASE_URL` para o domínio
> próprio (ver `docs/SETUP_PRODUCTION.md`).

## Diagnóstico

```bash
npm run doctor
# ou, de qualquer lugar:
curl https://<tunnel>/api/v1/health
```

O `GET /api/v1/diagnostics` (ADMIN) e o botão *Testar conexão* em `/accounts`
fazem chamadas reais e mostram o que falta para cada marketplace.
