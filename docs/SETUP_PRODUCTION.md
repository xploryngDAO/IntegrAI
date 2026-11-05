# Setup de produção — do zero ao go-live

Este guia assume que você já tem as contas de vendedor nos três marketplaces.
O sistema **não tem modo demonstração**: cada integração só opera com
credenciais reais. Use `npm run doctor` a qualquer momento para ver exatamente o
que falta.

## 0. Checklist rápido

- [ ] Servidor com Docker (2 vCPU / 4 GB) + domínio + HTTPS
- [ ] `Postgres 16`, `Redis 7`, bucket S3 privado
- [ ] `.env` preenchido (`docs/../.env.example`)
- [ ] `ADMIN_EMAIL`/`ADMIN_PASSWORD` definidos e `npm run db:seed` executado
- [ ] `npm run doctor` sem `fail`
- [ ] Apps criados nos 3 marketplaces (seções abaixo) e lojas conectadas em `/accounts`
- [ ] Webhooks públicos respondendo (seção 4)
- [ ] Primeiro atendimento real capturado

## 1. Subir o stack

```bash
git clone https://github.com/xploryngDAO/IntegrAI.git
cd IntegrAI
cp .env.example .env
# edite o .env (seção 2)
docker compose up -d postgres redis            # ou use serviços gerenciados
npm install
npm run prisma:migrate:deploy
npm run db:seed                                 # cria o ADMIN, sem dados fake
docker compose up -d --build                    # API :4000 + web :8080
```

Alternativas ao Docker: **Railway/Render/Fly.io** (Postgres+Redis gerenciados,
imagem `packages/server/Dockerfile`) ou VM/Kubernetes. A API é um processo
long-running (workers BullMQ + crons); **não** funciona como função serverless.
A Vercel hospeda apenas o SPA (`vercel.json`), apontando `VITE_API_BASE_URL`
para a API pública.

## 2. Variáveis obrigatórias (mínimo para subir)

| Grupo | Variáveis |
|---|---|
| Core | `NODE_ENV`, `PORT`, `APP_BASE_URL`, `WEB_ORIGIN` |
| Banco/cache | `DATABASE_URL`, `REDIS_URL` |
| Storage | `S3_BUCKET`, `S3_ATTACHMENTS_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| Segurança | `ENCRYPTION_MASTER_KEY` (32 bytes base64), `ENCRYPTION_KEY_ID`, `JWT_SECRET` |
| Bootstrap | `ADMIN_EMAIL`, `ADMIN_PASSWORD` (≥12), `ADMIN_NAME` |

Sem credenciais de marketplace o sistema sobe, autentica e mostra os canais como
“sem credenciais” — nenhuma mensagem é inventada.

## 3. Conectar os marketplaces

### 3.1 Amazon (SP-API + SES relay + SMTP relay)

**Pré-requisitos:** conta de vendedor **profissional** (contas individuais não
podem criar apps SP-API) e usuário principal da conta.

1. **Registrar-se como desenvolvedor privado**: Solution Provider Portal →
   *Register as a developer* → **Private seller application** (self-authorized,
   disponível só para a sua organização). Aceite AUP/DPP e responda o
   questionário de segurança.
2. **Criar o app**: Seller Central → *Apps and Services* → *Develop Apps* →
   *Add new app client*. Copie `LWA client ID` e `LWA client secret` para
   `AMAZON_LWA_CLIENT_ID` / `AMAZON_LWA_CLIENT_SECRET`.
3. **Habilitar as roles** do app: *Product Listing*, *Orders*, *Buyer
   Communication* (Messaging), *Direct-to-Consumer Shipping* e *Pricing*.
4. **Autorizar o app para a sua loja** (self-authorization) e copie o
   **refresh token** exibido (ele só aparece uma vez). Esse token é cadastrado
   na tela `/accounts` (campo *Refresh token*), cifrado em repouso pelo sistema.
5. **RDT (PII)**: o sistema solicita o Restricted Data Token automaticamente
   para `buyerInfo` + `shippingAddress` ao ler o pedido. Não há passo manual,
   mas o app precisa estar com DPP aceito; caso contrário o pedido vem sem PII e
   o atendimento mostra o aviso de dados protegidos.
6. **Relay de e-mail de entrada (SES/SendGrid Inbound Parse)** — obrigatório
   (polling IMAP é proibido):
   - Crie um domínio de recebimento (ex.: `inbound.seudominio.com.br`) no SES →
     *Email receiving* → rule set.
   - Ação: **SNS** ou **HTTPS** apontando para
     `https://api.seudominio.com.br/webhooks/amazon/ses`.
   - Configure o header `x-sac-signature` = HMAC-SHA256 do corpo bruto com
     `AMAZON_SES_INBOUND_SHARED_SECRET` (o relay precisa assinar; se usar SES,
     use uma Lambda intermediária que assina e faz o POST).
   - No `/accounts`, informe `inbound_email_route` (o endereço que aparece no
     `envelopeTo`) para o sistema casar a conta.
7. **Relay SMTP de saída (Rota 1)** — a Amazon proíbe SES direto ao comprador.
   Use o relay aprovado em *Seller Central → Messages → Buyer-Seller Messaging
   → Email relay* e preencha `SMTP_HOST/PORT/USER/PASSWORD`. No `/accounts`,
   informe `smtp_sender_email` (remetente verificado, com SPF/DKIM) e
   `approved_sender_domains`.
8. **Região**: `AMAZON_SPAPI_ENDPOINT` = `...-na`, `...-eu` ou `...-fe`
   correspondente ao marketplace da loja.

Validação: `npm run doctor` → checks `amazon.config`, `amazon.lwa`,
`amazon.participations` (+ `amazon.rdt` se `AMAZON_DIAGNOSE_ORDER_ID` for um
pedido real).

### 3.2 Mercado Livre

1. Crie a aplicação em <https://developers.mercadolivre.com.br/devcenter>
   (tipo *in-house* para uso próprio).
2. Copie `App ID`/`Secret` para `MELI_CLIENT_ID`/`MELI_CLIENT_SECRET`.
3. Cadastre a **Redirect URI** exatamente como
   `https://api.seudominio.com.br/api/v1/accounts/oauth/mercadolivre/callback`.
4. Em **Notifications**, configure:
   - Callback URL: `https://api.seudominio.com.br/webhooks/mercadolivre`
   - Tópicos: `questions`, `messages`, `post_purchase`, `orders_v2`,
     `shipments` (o recebimento precisa responder **200 em <500 ms**; o sistema
     enfileira e responde imediatamente).
5. Em `/accounts` → *Conectar loja* → **Mercado Livre** → *Autorizar*: o fluxo
   OAuth grava access/refresh tokens cifrados e renova a cada ~6 h sob lock.
   > Atenção: o refresh token do Meli é rotativo. O sistema serializa a
   > renovação com Redlock; reinícios não podem rodar dois workers com o mesmo
   > refresh token sem o lock (o próprio banco/Redis resolve).
6. Recuperação de notificações perdidas: o job de manutenção consulta
   `GET /missed_feeds?app_id=...` e republica na fila (janela de 2 dias).

Validação: `npm run doctor` → `meli.config`, `meli.token`, `meli.identity`
(+ `meli.items` com `MELI_DIAGNOSE_PROBE=true`).

### 3.3 Shopee (Open Platform v2)

1. Crie a aplicação em <https://open.shopee.com> → *App Management*. Copie
   `partner_id`/`partner_key` para `SHOPEE_PARTNER_ID`/`SHOPEE_PARTNER_KEY`.
2. Cadastre o **Redirect URL**
   `https://api.seudominio.com.br/api/v1/accounts/oauth/shopee/callback`.
3. Configure o **Push (webhook)**:
   - URL: `https://api.seudominio.com.br/webhooks/shopee`
   - Push codes: `2` (order status), `3` (tracking), `4` (sellerchat),
     `6` (return), `7` (cancellation), `10` (shipping document).
   - A assinatura é validada sobre `URL completa + "|" + rawBody` com
     `partner_key`; mantenha o NTP sincronizado (< 5 min de skew).
4. Em `/accounts` → *Conectar loja* → **Shopee** → *Autorizar*: o fluxo
   `auth_partner` retorna `code`+`shop_id` e o sistema troca por tokens. O
   refresh token é **single-use**; a renovação roda sob Redlock a cada 3h30.
5. **Sandbox**: para homologar antes, use
   `SHOPEE_API_BASE=https://partner.test-stable.shopeemobile.com` e as
   credenciais de teste do seu app. O `doctor` mostra quando está em sandbox.
6. **Push perdido**: cron de 5 min chama `v2.push.get_lost_push_message` e
   injeta na fila inbound (cursor em Redis).

Validação: `npm run doctor` → `shopee.config`, `shopee.clock`, `shopee.sign`,
`shopee.token`, `shopee.shop_info` (+ `shopee.lost_push` com
`SHOPEE_DIAGNOSE_LOST_PUSH=true`).

## 4. Exposição dos webhooks

A API precisa de **HTTPS público** para:

| Canal | Rota |
|---|---|
| Amazon (SES relay) | `POST /webhooks/amazon/ses` |
| Mercado Livre | `POST /webhooks/mercadolivre` |
| Shopee | `POST /webhooks/shopee` |

Opções: (a) DNS A/AAAA para a VM com Caddy/Traefik/nginx + Let's Encrypt;
(b) túnel (Cloudflare Tunnel/ngrok) apenas para homologação; (c) load balancer
gerenciado com TLS. O `APP_BASE_URL` deve ser a URL pública — ela entra na
assinatura do webhook da Shopee.

## 5. Primeiro atendimento real

1. `docker compose logs -f api` e `curl https://api.seudominio.com.br/api/v1/health`.
2. Abra o frontend, faça login com o ADMIN do bootstrap.
3. `/accounts` → conecte uma loja real de cada canal → *Testar conexão* deve
   retornar todos os checks `ok`.
4. Gere um evento real (ex.: faça uma pergunta de teste no Mercado Livre em um
   anúncio seu) e confirme o ticket aparecendo na fila com SLA.
5. Responda pelo composer e confirme a entrega no marketplace.

## 6. Go-live e operação

- **Migrations**: `npm run prisma:migrate:deploy` no deploy (o container já roda).
- **Doctor periódico**: agende `npm run doctor` (ex.: cron 1×/dia) e alerte em
  `exit 1`.
- **Backups**: Postgres diário + versionamento do bucket S3.
- **PII**: a purge dos 30 dias da Amazon roda por cron; não desative.
- **Rate limits**: ajuste `RL_*` se o marketplace alterar políticas.
- **DLQ**: monitore `queue.dlq`; cada job carrega o erro original.
- **Rotação de chaves**: `ENCRYPTION_KEY_ID` novo + keyring para decifrar dados
  antigos (ver `SecretCipher`).

## 7. Problemas comuns

| Sintoma | Causa provável | Correção |
|---|---|---|
| `doctor` → `amazon.lwa: invalid_grant` | refresh token revogado/trocado | regenere no Seller Central e reconecte em `/accounts` |
| `amazon.participations: 403` | app sem role ou não autorizado | habilite as roles e reautorize o app |
| PII vazia no pedido Amazon | RDT negado / DPP pendente | aceite DPP e verifique o acesso ao pedido |
| `meli.token: invalid_grant` | refresh token já consumido | reautorize (o refresh do Meli é rotativo) |
| `shopee.clock: skew` | horário do servidor | ative NTP/chrony (< 5 min) |
| `shopee.shop_info: error_sign` | `partner_key` errado ou base URL sandbox/prod trocada | confira `SHOPEE_PARTNER_KEY` e `SHOPEE_API_BASE` |
| Webhook 401 Shopee | assinatura sobre URL/rawBody | use a URL pública exata do `APP_BASE_URL` e preserve o corpo bruto |
| Webhook Meli desativado | resposta > 500 ms | o sistema responde imediato; verifique proxy/fila |
