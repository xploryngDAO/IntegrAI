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

### 6. Backup, restore e purga de tenant (S3 real)
```
POST /platform/tenants/:id/backup → backups/integrai/<timestamp>.json
POST /platform/tenants/restore {backupKey,newSlug} → novo tenant (2 agents, 1 account, 26 webhooks)
GET  /platform/tenants?search=<slug> → encontrado
UPDATE tenants status=DELETED (soft delete)
POST /platform/tenants/:id/purge → apagou 26 webhooks, 1 account, 2 agents, sessões e o tenant
GET  /platform/tenants?search=<slug> → 0 (removido fisicamente)
```

### 7. Portais dos marketplaces (verificação via navegador/MCP)
- `open.shopee.com/console/app` → redireciona para login (sem sessão)
- `sellercentral.amazon.com.br` → landing de vendedor (sem sessão)
- Conclusão: criar os apps exige suas contas; a plataforma já entrega valores copiáveis em `/setup` e os comandos `setup:assistant`/`setup:apply`.

### 7.1 Revogação de access token no HTTP e no Socket.IO
```
login → GET /auth/me 200
logout → 204
GET /auth/me com o mesmo token → 401
Socket.IO: conecta com token válido → logout → nova conexão com o token antigo
  → AUTHENTICATION_ERROR: invalid or expired token
novo login conecta normalmente (5/5 verificações)
```

### 7.2 Logout everywhere / reset de senha (watermark por usuário)
```
login device A + login device B (tokens distintos)
POST /auth/logout sem refreshToken (device A) → 204
GET /auth/me com token A → 401 · com token B → 401 (revogado pelo watermark)
POST /auth/login novamente → 200
validate:live → 11/11
```

### 8. SSO OIDC ponta a ponta (`npm run test:live-sso`)
Com um provedor OIDC local de teste (`scripts/oidc-stub.mjs`, RSA/JWKS reais):
```
PUT /tenants/me/sso (issuer local, client stub, domínio integrai.test)
discover → 200 · start → 302 IdP · authorize → 302 callback
callback → 302 SPA com code one-time · exchange → 200 (JIT role AGENT)
replay do code → 401 · usuário no tenant correto · cleanup
10/10 verificações passaram
```

### 9. Rate limit global por IP (HTTP)
605 requisições rápidas a uma rota inexistente: `{"401":598,"429":7}` — bloqueio após
600/min por IP; chaves de teste limpas no Redis local; `/health` e `/status` isentos.

### 10. Rate limit observado ao vivo
Após várias tentativas de login nos testes, a API respondeu `429 RATE_LIMITED` com
`details.bucket=auth.login` e `retryAfterMs` (~7,5 min restantes) — comportamento esperado.
No ambiente local as chaves `sac:auth:login:attempts:*` foram limpas no Redis para
continuar os testes; em produção não se limpam chaves.

### 9. Assistente de configuração (`npm run setup:assistant`)
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

### 11. E2E em navegador limpo (Edge/puppeteer, sem interceptação)
```
landingVisible=true · loginVisible=true · authenticated=true · localStorageToken=true (sessão persiste no reload)
/profile: sessões ativas=true · sair de todos=true
/admin: usuários=true · logs=true · acesso restrito=false (ADMIN)
logout pelo menu da conta -> /login e token removido (onLogin=true, tokenCleared=true)
```
Script: `node scripts/verify-live.mjs https://integrai-dev.vercel.app <email> <senha>`
