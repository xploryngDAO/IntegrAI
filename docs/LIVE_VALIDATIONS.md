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

### 12. Convites e exportacao CSV da auditoria (API real + Edge)
```
POST /invitations (admin) -> e-mail criado
GET  /admin/invitations   -> status PENDING
DELETE /admin/invitations/:id -> 204
GET  /admin/invitations   -> total 0 (convite removido)
GET  /admin/audit-logs/export.csv -> 200 text/csv; attachment; filename=audit-logs-2026-11-06.csv
  header: created_at,action,actor_email,resource_type,resource_id,ip,user_agent (18 linhas)
Edge limpo: /admin -> abas Usuários/Convites/Logs; "Exportar CSV" presente (com filtros)
```

### 13. Reenvio de convite (API real + Mailpit)
```
POST /invitations                        -> PENDING, expira em 7d
POST /admin/invitations/:id/resend       -> 200 PENDING, nova expiração
Mailpit                                  -> 2 e-mails para o convite; token novo (64 hex) aceito
POST /auth/accept-invitation             -> AGENT criado
POST resend de convite aceito            -> 409 INVITATION_ALREADY_ACCEPTED
cleanup + validate:live                  -> 11/11
```

### 14. Isolamento multi-tenant dos endpoints admin
```
(node scripts/isolation-test.mjs — tenant B semeado com agente, convite, sessão, auditoria e ticket)
A-nao-ve-conta-B / ticket-B / detalhe 404 / mutacao 404
A-admin-users-nao-ve-B            total=0
A-admin-convites-nao-ve-B         (nenhum convite do B)
A-admin-logs-nao-ve-B             total=0
A-admin-sessoes-nao-ve-B          (nenhuma sessão do B)
A-admin-csv-nao-exporta-B         bytes=67 (só cabeçalho)
A-admin-patch-usuario-B-404 / revoga-convite-B-404 / revoga-sessao-B-404
cleanup                           tenants restantes=0
14/14 verificações passaram
```

### 15. Alerta por e-mail em login de novo dispositivo
```
login com User-Agent novo (IntegrAI-Validator/1.0) -> 200
Mailpit "Novo acesso à sua conta IntegrAI" -> 1 mensagem (corpo contém dispositivo e IP)
login repetido com o MESMO ip+user-agent -> nenhuma nova mensagem (fingerprint conhecido)
audit auth.login.new_device gravado (e-mail redigido)
validate:live -> 11/11
```

### 16. Notificacao ao operador em mudanca de papel/status
```
convite aceito (AGENT) -> PATCH role SUPERVISOR
Mailpit: "Seu papel no workspace mudou - IntegrAI"
PATCH isActive=false
Mailpit: "Sua conta foi desativada - IntegrAI"
auditoria admin.user.role_changed/deactivated mantida; e-mails best-effort
validate:live -> 11/11
```

### 17. Auditoria de exportacoes CSV
```
GET /admin/users/export.csv?role=ADMIN&search=admin -> 200
GET /admin/audit-logs?action=admin.users.exported
  -> metadata {"format":"csv","filters":{"role":"ADMIN","search":"admin"},"rowCount":1}
GET /admin/audit-logs/export.csv?action=auth.login.success -> 200
GET /admin/audit-logs?action=admin.audit.exported
  -> metadata {"format":"csv","filters":{"action":"auth.login.success"},"rowCount":36}
actor/IP registrados; validate:live -> 11/11
```

### 18. Politica de 2FA obrigatoria por workspace
```
npm run test:live-2fa-policy
signup tenant novo -> verify-email -> login inicial
PATCH /tenants/me {require2fa:true} -> 200
login -> 403 TWO_FACTOR_SETUP_REQUIRED + setupToken
POST /auth/2fa/enroll/setup -> secret -> TOTP -> enroll/verify -> sessao + 8 recovery codes
GET /auth/me (sessao do enrollment) -> 200
replay do setup token -> 401
login seguinte -> 401 TWO_FACTOR_REQUIRED
cleanup -> tenant inexistente
13/13 verificacoes
```

### 19. Reset administrativo de 2FA
```
operador criado por convite + TOTP habilitado (8 recovery codes)
login antes -> 401 TWO_FACTOR_REQUIRED
POST /admin/users/:id/reset-2fa -> 200 twoFactorEnabled=false
login depois -> 200 (fator removido, sessoes revogadas)
validate:live -> 11/11
```

### 20. Retencao de backups (purga S3 + DB)
```
POST /platform/tenants/:id/backup -> backups/integrai/<ts>.json
UPDATE tenant_backups.created_at = now() - 120 days
API reiniciada com BACKUP_PURGE_CRON='* * * * *' (retencao 90d)
job tenant.backup.purge -> linha removida do banco
GET S3 do objeto -> 404 (objeto apagado)
validate:live -> 11/11
```

### 21. Refresh automatico e expiracao segura de sessao (Edge limpo)
```
login -> token salvo
corromper access token + reload -> 401 /auth/me
  -> refresh token valido rotaciona a sessao -> continua autenticado, token trocado
corromper access E refresh + reload
  -> refresh falha -> sessao local encerrada -> /login, tokens = null
```

### 22. Request-id, readiness e metrics (API real)
```
GET /api/v1/health/ready -> 200 status=ready checks db/redis/storage = ok
GET /api/v1/metrics (sem token) -> 401
GET /api/v1/metrics (Bearer METRICS_TOKEN) -> 200 text/plain; version=0.0.4
  sac_http_requests_total{...} / histogram / sac_process_uptime_seconds presentes
GET /api/v1/tenants/me com x-request-id: probe-req_12345 (sem JWT)
  -> 401, header x-request-id ecoado e error.requestId = probe-req_12345
validate:live -> 11/11
```

### 23. Bundle de producao validado localmente (Vite preview + proxy)
```
npm run build --workspace @sac/web
VITE_PROXY_TARGET=<api> npx vite preview --port 4173
a11y-audit http://127.0.0.1:4173 -> 0 violacoes (landing, login, admin, profile, accounts, settings)
verify-live http://127.0.0.1:4173 -> landing/login/sessao persistida/profile/admin/logout OK
```
Feito enquanto a cota free da Vercel bloqueava o deploy (100/24h).

### 24. Signup publico -> verificacao -> convite -> aceite (fluxo real)
```
POST /auth/signup (empresa nova) -> 201 + tenantId
e-mail de verificacao (Mailpit) -> token -> POST /auth/verify-email -> 200
login do novo ADMIN -> 200
POST /invitations (AGENT) -> 201
e-mail de convite (Mailpit) -> token -> POST /auth/accept-invitation -> 200
login do convidado -> 200; /auth/me role=AGENT; /tenants/me mesmo slug
DELETE /tenants/me (password+confirmSlug) -> 202
POST /platform/tenants/:id/backup -> 200 (backups/<slug>/<ts>.json) e indice na listagem
POST /platform/tenants/restore -> 200 (novo workspace; counts.agents=2)
POST /platform/tenants/:id/purge -> 200; 0 residuos no banco
DELETE /platform/tenants/:id (platform admin, sem senha) -> 200 soft delete do restaurado
POST /platform/tenants/:id/purge (restaurado) -> 200; 0 residuos no banco
26/26 verificacoes passaram (npm run test:live-signup)
```

### 25. TRUST_PROXY atras do tunel (anti-spoof de IP)
```
API: HOST=127.0.0.1 · TRUST_PROXY=127.0.0.1 (confia so no salto do cloudflared)
Buckets de login limpos; POST /auth/login via tunel com X-Forwarded-For: 203.0.113.9 (forjado)
Chave criada: sac:auth:login:attempts:admin@integr-ai.local:<IPv6 publico real do cliente>
=> XFF do cliente NAO foi usado; o IP real do edge chegou ao rate limit/auditoria
```

### 26. Exportacoes CSV e rejeicao de webhook invalido
```
GET /admin/users/export.csv -> 200 text/csv (header name,email,role,is_active,last_login_at,created_at,sessions_count)
GET /admin/audit-logs/export.csv -> 200 text/csv (~30 KB, header created_at,action,actor_email,resource_type,resource_id,ip,user_agent)
POST /webhooks/shopee com assinatura invalida -> 401 (rejeitado, sem 5xx)
```

### 27. Webhook do Shopee sem segredo configurado e rejeitado
```
POST /webhooks/shopee com HMAC-SHA256(url|corpo) usando chave vazia (forjavel)
-> 401 REJECTED · log "Shopee webhook rejected: partner key not configured"
   reason interno WEBHOOK_SECRET_NOT_CONFIGURED
Em producao a API recusa iniciar sem SHOPEE_PARTNER_KEY (>=16 chars)
```

### 28. Webhook do Mercado Livre sem segredo e rejeitado
```
POST /webhooks/mercadolivre (sem ?secret=, seller 42 conectado) -> 401 REJECTED
logs: "meli.webhook.secret_not_configured" · reason WEBHOOK_SECRET_NOT_CONFIGURED
GET /platform/integration-setup -> Meli configured=false, missing=["MELI_WEBHOOK_SECRET"]
   webhookSecretEnv=MELI_WEBHOOK_SECRET
```

### 29. Webhook valido do Mercado Livre (com segredo) aceito
```
MELI_WEBHOOK_SECRET=test-meli-secret-dev; API reiniciada
GET /platform/integration-setup -> configured=true e webhookUrl com ?secret=test-meli-secret-dev
POST /webhooks/mercadolivre?secret=... (seller conectado 3816933555) -> 200 {"status":"OK"}
POST mesmo payload com ?secret=wrong -> 401 (meli.webhook.invalid_secret)
POST seller desconhecido 42 com segredo valido -> 401 UNKNOWN_SELLER (segredo passou; conta nao resolve)
Env restaurado (segredo vazio) e API reiniciada; eventos de teste removidos de webhook_events
```

### 30. Upload de anexos e download assinado (controles reais)
```
POST /files/upload (multipart "file", image/png 70 bytes) -> 200 key=attachments/2026/11/...-pixel.png
POST /files/upload (text/html)                                -> 422 (MIME nao permitido)
POST /files/upload (arquivo vazio)                            -> 422
POST /files/upload (11 MB image/png)                          -> 413 (limite)
GET  /files/signed?key=...                                    -> 200 com URL presignada
GET  URL presignada                                           -> 200 (70 bytes)
```

### 31. Regressao das suites live de identidade (pos-hardening)
```
npm run test:live-2fa-policy -> 13/13 (require2fa: bloqueio 403, enrollment 200, replay 401,
   login passa a exigir TOTP, cleanup)
npm run test:live-sso       -> 10/10 (stub OIDC: discover, start 302, callback one-time code,
   exchange JIT AGENT, replay 401, tenant correto, cleanup)
Estado final: SSO do tenant 404 (limpo) e 0 usuarios JIT residuais
```

### 32. Idempotencia de webhook e revogacao de socket
```
POST /webhooks/mercadolivre?secret=... (evento evt-dedup-live-1, seller conectado) -> 200 {"status":"OK"}
POST identico novamente                                                -> 200 {"status":"DUPLICATE"}
webhook_events: 1 linha para evt-dedup-live-1 (sem processamento duplicado)
npm run test:live-socket -> 5/5 (login, socket conecta, logout 204, socket rejeita token revogado,
   novo login conecta)
evento e segredo de teste removidos; env restaurado
```

### 33. Deploy publico na Vercel validado em producao
```
vercel --prod -> https://integrai-j1ajthsgo-xploryngdaos-projects.vercel.app (alias integrai-dev.vercel.app)
alias 200 · bundle assets/index-BQSU6B_C.js (contem runtime-config + manutencao)
runtime-config.json (raw main) 200 apontando para o tunel da API
verify-live na URL publica -> landing/login/sessao/perfil/admin/logout OK
axe WCAG 2.1 AA na URL publica -> 0 violacoes em 8 telas (landing, login, admin, profile,
   accounts, settings, platform, status)
```
