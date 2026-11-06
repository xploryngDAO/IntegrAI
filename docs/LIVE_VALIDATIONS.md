# Validações ao vivo — configuração assistida (06/11/2026)

> Segredos ficam apenas no `.env` local (gitignored). Nada sensível é versionado.

## Configurações aplicadas no ambiente

| Variável | Estado | Observação |
|---|---|---|
| `BILLING_WEBHOOK_SECRET` | configurado (64 hex) | valida HMAC do webhook de billing |
| `AMAZON_SES_INBOUND_SHARED_SECRET` | configurado | assinatura do relay SES |
| `SMTP_HOST` / `SMTP_FROM` | configurados apontando para o Mailpit local (`:1025`) | envio real de e-mail exercitado |
| `MELI_CLIENT_ID/SECRET` | configurados | app real, loja conectada |
| `SHOPEE_PARTNER_ID/KEY` | **pendente** | depende do app parceiro Shopee |
| `AMAZON_APP_ID` + LWA | **pendente** | depende do app público SP-API |
| `BILLING_CHECKOUT_URL_TEMPLATE` | **pendente** | depende do gateway real (Stripe/Pagar.me) |

## Evidências executadas

### 1. Billing — máquina de estados e idempotência (API real)
```
POST /api/v1/billing/webhook  (assinado)  activated   → PROCESSED (tenant integrai)
POST ... (mesmo externalId)               → DUPLICATE
POST ...  payment.failed                  → PROCESSED (PAST_DUE)
GET /platform/billing/summary             → pastDue=1
GET /platform/billing/events              → 2 eventos
```
Depois do teste: `PATCH /platform/tenants/:id/billing {TRIALING}` (estado limpo) e eventos de teste removidos.

### 2. E-mail transacional real (SMTP → Mailpit)
```
POST /auth/signup (empresa SMTP Live)
→ Mailpit recebeu "Confirme seu e-mail - IntegrAI"
→ token extraído do e-mail e POST /auth/verify-email → {verified:true}
→ POST /auth/login → 200, tenant novo, role ADMIN
```
Tenant temporário removido ao final.

### 3. Backup por tenant → S3 (s3rver local)
```
POST /platform/tenants/:id/backup → backups/<slug>/<timestamp>.json, 2.527 bytes
counts: agents=1, accounts=0, tickets=0, messages=0...
GET /platform/tenants/:id/backups → 1 item
```

### 4. 2FA ponta a ponta (`npm run test:live-2fa`)
```
signup → e-mail no Mailpit → verify-email → login
→ 2fa/setup → 2fa/verify (TOTP gerado localmente) → 8 recovery codes
→ login bloqueado (TWO_FACTOR_REQUIRED) → 2fa/challenge (TOTP) → sessão emitida
→ 2fa/disable com recovery code → login volta a funcionar
cleanup do tenant temporário
11/11 verificações passaram
```

### 5. Convite de operador ponta a ponta
```
POST /invitations (ADMIN) → e-mail "Convite para operar o IntegrAI" no Mailpit
→ token extraído do link /invite?token=... → POST /auth/accept-invitation → usuário AGENT criado
→ login do convidado 200 → GET /invitations com token AGENT → 403 (RBAC)
cleanup de sessões/convite/usuário
```

### 6. Assistente de configuração (`npm run setup:assistant`)
Mostra por canal o que está configurado/pendente, os webhooks exatos e o próximo passo com link do portal; `--generate` cria segredos locais ausentes (billing/SES) sem sobrescrever.

### 6. Estado geral
```
GET /status                 → operational (4 serviços, 1 canal)
GET /accounts (ADMIN)       → 1 loja Mercado Livre ativa
npm run validate:live       → 11/11
```

## Vínculos de configuração (como concluir)

1. **Shopee**: criar app no Open Platform → obter `partner_id`/`partner_key` → configurar
   `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY` e push URL `<api>/webhooks/shopee`;
   depois `/accounts` → conectar. Sandbox: `SHOPEE_API_BASE=https://openplatform.sandbox.test-stable.shopee.sg`.
2. **Amazon**: criar app público SP-API → `AMAZON_APP_ID`, LWA client/secret, aceitar DPP,
   security assessment, SES inbound (`AMAZON_SES_INBOUND_SHARED_SECRET`) e relay SMTP no Seller Central.
3. **Billing real**: configurar `BILLING_CHECKOUT_URL_TEMPLATE` + `BILLING_SUCCESS_URL`/`CANCEL_URL`
   e apontar o gateway para `POST /api/v1/billing/webhook` com o mesmo secret.
4. **Produção**: `prisma migrate deploy`, SMTP/S3 reais, `VITE_API_BASE_URL` na Vercel.

As páginas `/setup` (guia com valores copiáveis e status) e `/status` foram publicadas para apoiar esses passos.
