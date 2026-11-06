# Segurança corporativa — IntegrAI / SAC Hub

> **Status:** documento vivo · **Última revisão:** 2026-11-05 · **Owner:** Engenharia + DPO
> **Escopo:** API Fastify (`packages/server`), SPA React servida pela Vercel
> (`apps/web`), adapters de marketplace, banco PostgreSQL/Redis/S3 e integrações OAuth/OIDC.
>
> Este documento **não substitui** um pentest independente nem parecer jurídico.
> Ele descreve o modelo de ameaças, os controles que existem no código, os gaps
> conhecidos e o plano de resposta a incidentes. Toda mudança de autenticação,
> CORS, upload, webhook ou tratamento de PII deve atualizar este arquivo no mesmo
> PR.

---

## 1. Sumário executivo

O desenho parte de três premissas:

1. **A API só devolve JSON.** A SPA é um artefato estático na Vercel e a API vive
   em outro host (Render/Vercel/Tunnel). Portanto o CSP que protege o documento
   é o **da Vercel**, não o da API; o CSP da API é defesa em profundidade contra
   parser confusion.
2. **Token não é cookie.** A autenticação é `Authorization: Bearer <JWT>`; não há
   cookie de sessão, o que elimina CSRF clássico hoje. Se cookies forem
   introduzidos, esta premissa muda e a seção 3.1 vira bloqueante.
3. **Webhook é input hostil.** Todo push de marketplace é verificado por HMAC
   (quando o provedor oferece), resolvido para uma conta conectada e
   idempotente no Redis/banco. O payload nunca é confiado para hidratação; o
   worker busca o recurso na API oficial.

Controles maduros já presentes: AES-256-GCM com keyring para tokens de loja,
JWT com `iss`/`aud`/algoritmo fixos, refresh rotativo single-use, RBAC por rota,
rate limit distribuído nas rotas de força bruta, headers de segurança, CORS com
allowlist, `no-store` em `/api`, HMAC de webhooks com `timingSafeEqual`,
idempotência de 24 h, export/exclusão LGPD e purge de PII.

Gaps priorizados estão na seção 14 (P0/P1/P2). Os mais relevantes: segredos de
desenvolvimento aceitos em produção, ausência de rate limit HTTP global,
`localStorage` para o access token na SPA, webhook Mercado Livre sem assinatura
e dependências com correções apenas em major.

---

## 2. Ativos, fronteiras de confiança e modelo de ameaças

### 2.1 Ativos

| Ativo | Onde vive | Impacto se vazar/corromper |
|---|---|---|
| Access/refresh tokens de marketplace | `marketplace_accounts.*_enc` (AES-256-GCM) | Acesso total às lojas do cliente, envio de mensagens, leitura de pedidos |
| Credenciais de operador | `agents.password_hash` (bcrypt cost 12), TOTP `two_factor_secret_enc` | Sequestro de conta, ações em nome do atendente |
| PII de comprador (nome, e-mail, documento, telefone, endereço) | `buyer_pii_vault` com `expires_at` | Dano direto ao titular, multa LGPD, quebra de confiança |
| Mensagens e anexos | `ticket_messages`, S3 privado | Vazamento de conversa, links maliciosos, NF-e |
| Segredos de infraestrutura | env (`ENCRYPTION_MASTER_KEY`, `JWT_SECRET`, HMACs, SMTP) | Comprometimento total |
| Sessões de operador | JWT (12 h) + refresh opaco (30 d) | Ações não autorizadas, persistência pós-logout |

### 2.2 Fronteiras de confiança

```
Internet
  │  (1) SPA Vercel ──fetch──► API Fastify (JSON, Bearer JWT)
  │  (2) Marketplace ──POST──► /webhooks/* (sem JWT; HMAC quando disponível)
  │  (3) Gateway de billing ──POST──► /api/v1/billing/webhook (HMAC)
  │  (4) IdP corporativo ──redirect──► /auth/sso/callback (state + PKCE + ID token)
  │  (5) Provedor OAuth do marketplace ──redirect──► /accounts/oauth/:m/start|callback
  ▼
API ──► PostgreSQL (Prisma) / Redis (rate limit, idempotência, cache)
API ──► S3 (anexos, presigned GET 5 min) / SMTP / APIs dos marketplaces
API ──► BullMQ workers (mesmo código, sem porta HTTP própria)
```

Toda travessia é hostil. Em especial: payload de webhook, query string, body
JSON, multipart, headers (`Origin`, `Authorization`, `Idempotency-Key`,
`X-Forwarded-For`), respostas de IdP/marketplace e o próprio conteúdo das
mensagens (que pode conter links/phishing para o comprador).

### 2.3 STRIDE por fronteira

| Fronteira | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| SPA → API | JWT forjado (bloqueado por HS256 + `iss`/`aud`) | body adulterado (Zod) | falta de log de auditoria | resposta com PII de outro tenant (404 por tenant) | body gigante (1 MiB) / flood (gap: rate limit global) | escalada de papel (`requireRole`/`requirePlatformAdmin`) |
| Marketplace → webhook | push forjado (HMAC/timestamp; Meli = gap) | payload trocado (hidratação via API) | `webhook_events` | payload com PII em log (não logamos body) | retry storm (idempotência + ACK) | evento para loja alheia (resolução de conta) |
| Billing → webhook | assinatura HMAC | payload trocado (HMAC sobre bytes crus) | `webhook_events` BILLING | — | replay (idempotência por `externalId`) | ativação indevida de plano |
| IdP → SSO | `state`/`nonce`/PKCE/assinatura | ID token adulterado (RS256 + JWKS) | logs de login | claim de e-mail não verificado | callback flood | auto-provisionamento fora do domínio |
| Operador → admin console | 2FA TOTP | — | `ticket_events`/logs | export LGPD | — | `is_platform_admin` re-lido do banco |

---

## 3. Ameaças e controles por cenário

### 3.1 CSRF

**Estado atual:** a API não usa cookies; o token vai em `Authorization`. Um site
terceiro não consegue anexar esse header nem ler a resposta (CORS allowlist),
então CSRF clássico não se aplica.

**Controles:** CORS com allowlist explícita + `credentials: true` +
`strictPreflight` (`packages/server/src/http/app.ts`); wildcard é descartado por
`resolveAllowedOrigins`; `Cache-Control: no-store` em `/api`.

**Gatilho de mudança:** qualquer cookie de sessão/refresh exige
`SameSite=Lax/Strict`, `Secure`, `HttpOnly`, verificação de `Origin` e token
anti-CSRF (double-submit ou sincronizador). Sem isso, **não** introduzir cookies.

### 3.2 Replay

| Superfície | Controle | Arquivo |
|---|---|---|
| Webhooks de marketplace | `SET NX EX 86400` por `marketplace:eventId` + linha em `webhook_events` (`DUPLICATE`) | `application/WebhookIngressService.ts` |
| Shopee | janela de timestamp (default 300 s, `SHOPEE_WEBHOOK_TOLERANCE_SECONDS`) + HMAC + `timingSafeEqual` | `adapters/shopee/inbound/ShopeeWebhookParser.ts` |
| Billing | HMAC sobre bytes crus + unique `billing:<externalId>`; replay responde 200 `DUPLICATE` | `application/BillingService.ts` |
| OAuth de marketplace | `state` assinado, com nonce, TTL 10 min, cache server-side, **single-use** (queimado antes do exchange) | `application/AccountService.ts` (`consumeState`) |
| SSO OIDC | `state` assinado + cache single-use, `nonce` no ID token, PKCE S256 | `application/SsoAuthService.ts`, `application/sso/*` |
| Refresh token | rotação com revogação atômica; replay de token revogado = 401 | `application/AuthSessionService.ts` |
| Access JWT | denylist por `jti` no Redis: logout grava `sac:auth:deny:<jti>` com TTL = restante do token e `verifyToken` rejeita o replay (401) | `application/auth/access-token-revocation.ts` |

### 3.3 Enumeração de contas

Controles deliberados:

- `login`: bcrypt sempre executado (hash dummy para e-mail inexistente) e a
  mesma resposta `401 Invalid credentials`; o 429 depende só de e-mail+IP
  (`application/AgentService.ts`).
- `forgot-password` / `resend-verification`: sempre `202`, com o mesmo corpo,
  exista ou não a conta; rate limit cobrado **antes** do lookup
  (`application/AuthService.ts`).
- `signup`: responde `409` para e-mail já cadastrado — trade-off aceito para UX
  de cadastro; documentado no checklist LGPD. Mitigação: rate limit e CAPTCHA
  (gap P2).
- Convites: token opaco de alta entropia; erro genérico para token inválido.
- `/status` e `/health`: payload agregado, sem IDs de conta/e-mail
  (`http/routes/status.routes.ts`, `health.routes.ts`).

### 3.4 Força bruta

`application/auth/rate-limit.ts` implementa janela fixa atômica em Redis (Lua)
com fallback em memória quando o Redis cai, cobrada antes da verificação:

| Fluxo | Limite | Janela |
|---|---|---|
| `login` | 10 tentativas por e-mail + IP | 15 min |
| `2fa/challenge` | 5 por `jti` **e** 5 por IP | 15 min |
| `forgot-password` | 3 por e-mail | 15 min |
| `resend-verification` | 3 por e-mail | 15 min |
| regenerar códigos 2FA | 5 por operador | 15 min |

O 429 carrega `details.retryAfterMs` e agora também o header `Retry-After`
(`http/middleware/error-handler.ts`). A cobertura distribuída pressupõe Redis
compartilhado entre instâncias.

**Gap:** não há rate limit HTTP global (por IP/rota) para webhooks e endpoints
públicos; ver seção 14 (P1).

### 3.5 SSRF

- Não existe endpoint que aceite URL arbitrária para fetch no servidor. As URLs
  de saída vêm de configuração (`AMAZON_SPAPI_ENDPOINT`, `MELI_API_BASE`,
  `SHOPEE_API_BASE`, endpoints OIDC) ou de valores opacos do marketplace.
- OIDC: `discover()` só aceita `https`, valida que o `issuer` do documento é
  exatamente o issuer configurado e exige endpoints `https`
  (`application/sso/OidcClient.ts`).
- Anexos: o cliente envia a **key** de storage, não uma URL; a key precisa
  começar em `attachments/` e passa por `isSafeAttachmentKey`
  (`http/utils/storage-key.ts`, `http/controllers/file.controller.ts`).
- Presigned GET é gerado no servidor com TTL de 300 s; o bucket é privado.
- Diagnósticos só chamam hosts de configuração.

**Regra para novas features:** URL vinda do usuário (importar por URL, webhook
de saída, avatar remoto) exige allowlist de host, bloqueio de IP
privado/loopback/link-local/metadata (`169.254.169.254`), `redirect: 'error'` e
pin do IP resolvido.

### 3.6 Injeção

- SQL/ORM: Prisma com queries parametrizadas. O único `$queryRawUnsafe` do
  repositório é a sonda constante `SELECT 1` em `container.ts` (sem input de
  usuário); nenhuma query concatena dados de request.
- Validação de borda: Zod em body/query/params
  (`http/schemas/*`, `parseInput`), com limites de tamanho por campo.
- XSS: a SPA renderiza mensagens como texto (`MessageBubble` sem
  `dangerouslySetInnerHTML`); e-mails transacionais escapam HTML
  (`escapeHtml` em `infrastructure/email/email-service.ts`).
- Header/SMTP injection: valores de e-mail passam por normalização e o
  transporte SMTP é montado no servidor.
- Command injection: sem `child_process` no runtime.
- Path traversal: `sanitizeFileName` + `isSafeAttachmentKey`.
- **Gap conhecido:** o parser catch-all (`*`) aceita qualquer `Content-Type` para
  não quebrar o relay SES; as rotas `/api/v1` validam o corpo com Zod, mas não
  exigem `application/json` explicitamente. Não há cookie, então o vetor CSRF
  simples não se aplica; ainda assim, um guard de content-type por prefixo é
  recomendado (P2).

### 3.7 Vazamento de PII

- PII restrita da Amazon **não** fica em `support_tickets`: vai para
  `buyer_pii_vault` com `expires_at` (shipment + 30 dias) e é hard-deleted pelo
  cron `queue.pii.purge` (`application/TenantPurgeService.ts`, workers, S3).
- Acesso à PII é por ticket e por tenant; listas não retornam PII de comprador.
- Export LGPD exclui credenciais e o vault (`TenantPrivacyService`), e inclui
  apenas até 1.000 tickets/5.000 mensagens com flag `truncated`.
- Logs: request-context nunca registra body/headers; `redactPiiForLogs` mascara
  e-mail/telefone em mensagens de erro; pino tem `redact` para
  `authorization`, `password`, tokens, `clientSecret`, `partnerKey`,
  `secretAccessKey` (`infrastructure/logger.ts`).
- `Cache-Control: no-store` em toda resposta `/api/*` evita cache compartilhado.
- Erros 5xx em produção não expõem stack (`http/middleware/error-handler.ts`).

**Gaps:** `agent.login.failed` registra o e-mail completo
(`application/AgentService.ts:177`); `email-service` em modo dev imprime link +
destinatário no console (somente fora de produção). Ver seção 14.

### 3.8 Sequestro de sessão

- JWT HS256 com `issuer`/`audience` fixos e algoritmo whitelisted
  (`AgentService.verifyToken`); challenge token tem `scope` e é rejeitado como
  access token.
- Refresh opaco (48 bytes) armazenado por hash, rotação single-use por refresh,
  revogação em logout, troca de senha e "logout everywhere"
  (`AuthSessionService`).
- `requireTenantId` impede operador sem workspace de criar recursos (403);
  `requireRole` e `requirePlatformAdmin` revalidam o privilégio (o admin de
  plataforma é relido do banco a cada request).
- Workspace suspenso/soft-deleted invalida o token no próximo request
  (`assertTenantActive`).
- O SPA guarda o access token em `localStorage` (`apps/web/src/lib/api.ts`), o
  que o expõe a XSS. Mitigações atuais: CSP restritiva na Vercel, sem
  `innerHTML`/`eval`, dependências auditadas. **Gap P1:** migrar para cookie
  `HttpOnly`/`SameSite` (com o pacote de CSRF da 3.1) ou memória + refresh
  silencioso.
- Access token (TTL `JWT_EXPIRES_IN`, default 1 h): `POST /auth/logout` grava
  `sac:auth:deny:<jti>` com TTL igual ao tempo restante do token e
  `AgentService.verifyToken` rejeita o `jti` denylistado (401). A leitura é
  **fail-open** (warn + aceita) para uma indisponibilidade do Redis não
  derrubar a API; tokens antigos **sem `jti`** continuam válidos até `exp` e não
  são revogáveis individualmente (`application/auth/access-token-revocation.ts`).

### 3.9 Phishing de OAuth / SSO

- O fluxo de marketplace só inicia a partir de um operador autenticado; o
  `state` assinado amarra marketplace, tenant, nonce e `issuedAt`, e é
  consumido uma única vez (`AccountService.startOAuth/consumeState`).
- O callback é público por necessidade (o provedor não apresenta JWT), mas
  qualquer `state` inválido/expirado/reusado falha antes do exchange de código.
- Tokens de marketplace são trocados server-side com `client_secret` e gravados
  cifrados; nunca voltam ao navegador.
- SSO corporativo: `discover` por domínio, allowlist de domínio obrigatória
  (lista vazia = ninguém), `email_verified`, validação completa do ID token e
  provisionamento restrito ao domínio (seção 12).
- Recomendações: comunicar aos clientes que só aceitem o consentimento iniciado
  em `app.integrai...`; treinar operadores contra telas de consentimento
  recebidas por e-mail; manter `AMAZON_APP_REDIRECT_URI`/redirects exatos nos
  portais.

---

## 4. Controles implementados (mapa de arquivos)

| Controle | Implementação | Teste |
|---|---|---|
| Headers de segurança da API (CSP, HSTS, XFO, COOP/CORP, Permissions-Policy) | `http/app.ts` | `http/__tests__/security-hardening.test.ts` |
| Headers do SPA | `vercel.json` | manual (seção 5.3) |
| CORS allowlist + rejeição de wildcard | `http/app.ts` (`resolveAllowedOrigins`) | `security-hardening.test.ts` |
| Limite de body (1 MiB API / 12 MiB webhook / 10 MiB upload) | `http/app.ts`, `http/constants.ts`, `@fastify/multipart` | `security-hardening.test.ts` |
| Timeout de request (60 s) | `http/app.ts` (`HTTP_REQUEST_TIMEOUT_MS`) | — |
| JWT + RBAC + tenant gate | `http/middleware/auth.ts`, `application/AgentService.ts` | `invitation-routes.test.ts`, `tenant-routes.test.ts` |
| Rate limit de auth/2FA | `application/auth/rate-limit.ts` | `application/__tests__/AuthRateLimit.test.ts` |
| `Retry-After` no 429 | `http/middleware/error-handler.ts` | `security-hardening.test.ts` |
| Cifra AES-256-GCM com keyring | `infrastructure/crypto/cipher.ts` | testes de cipher/2FA |
| Rotação de refresh token | `application/AuthSessionService.ts` | `application/__tests__/AuthSessions.test.ts` |
| Redação de PII em logs | `infrastructure/logger.ts`, `shared/src/compliance.ts` | indireto |
| Request logging sem body | `http/middleware/request-context.ts` | — |
| HMAC Amazon SES | `adapters/amazon/inbound/SesRelayParser.ts` | `adapters/amazon/__tests__/sesRelay.test.ts` |
| HMAC Shopee + timestamp | `adapters/shopee/inbound/ShopeeWebhookParser.ts`, `client/sign.ts` | `adapters/shopee/__tests__/sign.test.ts` |
| HMAC billing | `application/BillingService.ts`, `http/controllers/billing.controller.ts` | `http/__tests__/billing-routes.test.ts` |
| Idempotência de webhook | `application/WebhookIngressService.ts` | testes de ingress |
| Validação de upload | `http/controllers/file.controller.ts`, `utils/storage-key.ts` | — |
| Export/exclusão LGPD | `application/TenantPrivacyService.ts`, `http/routes/tenants.routes.ts` | `tenant-privacy-routes.test.ts` |
| Purge de PII/tenant | `application/TenantPurgeService.ts`, `queues/workers.ts` | `tenantPurgeWiring.test.ts` |
| Erros sem stack em produção | `http/middleware/error-handler.ts` | `security-hardening.test.ts` |

---

## 5. Cabeçalhos de segurança

### 5.1 API (Fastify)

`http/app.ts` registra `@fastify/helmet` com política explícita (sem defaults
frouxos) e adiciona `Permissions-Policy` via hook. Em toda resposta:

| Header | Valor | Por quê |
|---|---|---|
| `Content-Security-Policy` | `default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'none'; manifest-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'none'; worker-src 'none'` | A API só serve JSON; nenhuma resposta pode virar documento ativo |
| `Strict-Transport-Security` | `max-age=15552000; includeSubDomains` **somente `NODE_ENV=production`** | Fixa HTTPS no navegador sem envenenar `localhost` em dev |
| `X-Content-Type-Options` | `nosniff` | Impede MIME sniffing de JSON como HTML |
| `X-Frame-Options` | `DENY` | Dupla proteção com `frame-ancestors` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Não vaza path/query para terceiros |
| `Cross-Origin-Opener-Policy` | `same-origin` | Isola a janela de ataques de opener |
| `Cross-Origin-Resource-Policy` | `same-origin` | Impede embed de respostas da API |
| `Permissions-Policy` | `accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` | Nega capacidades que a API nunca usa |
| `Cache-Control` / `Pragma` | `no-store, no-cache, must-revalidate` / `no-cache` em `/api/*` | Dados por operador/tenant |
| `X-DNS-Prefetch-Control` / `X-Permitted-Cross-Domain-Policies` / `X-XSS-Protection` | `off` / `none` / `0` | Defaults seguros do helmet |

> **Importante:** um CSP entregue pela API **não** protege a SPA, porque o
> documento é servido por outra origem. O CSP efetivo do front está no
> `vercel.json`.

### 5.2 SPA (Vercel)

`vercel.json` (headers globais) aplica:

```
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none';
  frame-ancestors 'none'; form-action 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:;
  font-src 'self' data:; connect-src 'self' https: wss:;
  media-src 'self' https: blob:; worker-src 'self' blob:;
  manifest-src 'self'; upgrade-insecure-requests
Strict-Transport-Security: max-age=15552000; includeSubDomains
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

Racional:

- `img-src https:` é necessário para avatares/imagens servidas por CDNs de
  marketplace e por URLs presigned do S3; `data:`/`blob:` cobrem previews locais.
- `connect-src 'self' https: wss:` cobre a API em outro host
  (`VITE_API_BASE_URL`) e o Socket.IO (`VITE_WS_URL`) sem embutir o host no
  arquivo estático. **Endurecimento recomendado:** trocar `https: wss:` pelos
  hosts exatos (`https://api.<dominio> wss://api.<dominio>`) depois que o
  domínio de produção estiver fixo; a CSP não aceita variável de ambiente.
- `style-src 'unsafe-inline'` é necessário para estilos inline do React; não há
  `unsafe-eval` nem script inline (`apps/web/index.html` só carrega
  `/src/main.tsx`).
- O toolbar de preview da Vercel pode ser bloqueado pela CSP; produção não o usa.

### 5.3 Como verificar

```bash
# API local (headers completos)
curl -sI http://localhost:4000/api/v1/health | findstr /i "content-security strict-transport x-frame permissions"

# Produção (HSTS presente)
curl -sI https://<api-host>/api/v1/health

# SPA (CSP entregue pela Vercel)
curl -sI https://<spa-host>/ | findstr /i "content-security strict-transport"
```

Critério de aceite: API em produção com HSTS + CSP `default-src 'none'`; SPA com
CSP sem `unsafe-eval`, sem `script-src *` e com `frame-ancestors 'none'`.

---

## 6. Segredos, criptografia, limites e integridade

### 6.1 Cifra de segredos (AES-256-GCM)

`infrastructure/crypto/cipher.ts`:

- AES-256-GCM, IV aleatório de 12 bytes por operação, tag de 16 bytes;
- formato versionado `v1:<keyId>:<ivB64>:<tagB64>:<cipherB64>`;
- `ENCRYPTION_MASTER_KEY` precisa decodificar para exatamente 32 bytes
  (validado no schema de env);
- keyring por `keyId` permite rotação: novas gravações usam a chave atual,
  leituras antigas continuam funcionando enquanto a chave antiga estiver no anel;
- `hash()` = HMAC-SHA256 com chave derivada por HKDF (domain separation
  `sac:pii:lookup:v1`) para buscas por igualdade sem reutilizar a chave de cifra;
- erros de decifra não retornam plaintext nem detalhes sensíveis.

Cifrados hoje: `access_token_enc`, `refresh_token_enc`, `two_factor_secret_enc`,
`tenant_sso_connections.client_secret_enc`.

**Ponto de atenção:** `ENCRYPTION_MASTER_KEY` e `JWT_SECRET` têm valores default
de desenvolvimento em `config/env.schema.ts`. `assertProductionSafety` valida
apenas o tamanho do JWT, não rejeita os defaults. Ver gap P0 na seção 14.

### 6.2 Nunca logar token/PII

Regras aplicadas:

- `request-context.ts` registra apenas método, path sem query, status, duração,
  `agentId` e IP — nunca body nem headers.
- `infrastructure/logger.ts` define `redact` para `authorization`,
  `password*`, `accessToken`, `refreshToken`, `clientSecret`, `partnerKey`,
  `secretAccessKey`.
- `redactPiiForLogs` (e-mails mascarados, telefones suprimidos) é usado em
  erros de webhook, startup, worker e rate limit.
- O controller de billing loga apenas `type`, `tenantId`, `duplicate`,
  `billingStatus` — não o payload.
- Webhook controller loga `eventId`, `status`, `durationMs`; nunca o corpo.

Auditoria por `grep` (2026-11-05) encontrou:

- `agent.login.failed` com `email` completo (`AgentService.ts:177`) — **P1**;
- `console.log` de link de verificação/reset/convite + destinatário em
  `infrastructure/email/email-service.ts` — **somente** quando
  `NODE_ENV != production` e SMTP não configurado (aceitável em dev, mas não
  usar em staging compartilhado).

Nunca colar token em ticket/issue; ao reportar incidente, usar `requestId` e
`agentId`.

### 6.3 Limites de body e timeouts

| Superfície | Limite | Onde |
|---|---|---|
| JSON autenticado `/api/v1/*` | **1 MiB** | `onRoute` em `http/app.ts` (`MAX_API_JSON_BYTES`) |
| Webhooks `/webhooks/*` (SES/MIME, Meli, Shopee) | 12 MiB | `DEFAULT_BODY_LIMIT_BYTES` |
| Upload multipart | 10 MiB, 1 arquivo, 10 campos, 12 parts | `@fastify/multipart` (`http/app.ts`) |
| Request inteiro | 60 s | `HTTP_REQUEST_TIMEOUT_MS` |
| Diagnóstico ao vivo | 30 s (resposta 504) | `DIAGNOSTICS_TIMEOUT_MS`, `utils/timeout.ts` |
| Webhook budgets | Meli 500 ms / Shopee 100 ms / Amazon 1 s (alerta) | `shared/src/constants.ts` |

O parser JSON preserva os bytes crus (`request.rawBody`) para o HMAC; o parser
`*`/`message/rfc822` é bufferizado para o relay SES. O limite de 12 MiB não é
“folga”: é o teto do MIME de entrada da Amazon. O teto de 1 MiB vale só para as
rotas `/api/v1`, aplicado por `onRoute` (Fastify não herda `bodyLimit` de
plugin).

### 6.4 CORS

- `WEB_ORIGIN` aceita lista separada por vírgula; entradas são normalizadas
  (trim, sem barra final).
- `*` é descartado (nunca refletido) porque `credentials: true` e a API carrega
  dados por operador.
- Lista vazia = nenhuma origem cross-origin permitida (fail closed).
- `allowedHeaders`: `content-type`, `authorization`, `idempotency-key`,
  `x-request-id`; `maxAge: 600`.
- Em produção, configurar somente os domínios reais do SPA (Vercel) e do
  console; nunca incluir previews aleatórios.

### 6.5 Rate limits

Além dos limites de autenticação (3.4), os **token buckets de saída** protegem
marketplaces contra bloqueio (`infrastructure/ratelimit/token-bucket.ts`,
`RL_*` no env). Eles não protegem a API contra flood; ver gap P1.

### 6.6 Webhooks — HMAC e idempotência

| Provedor | Autenticação | Replay |
|---|---|---|
| Amazon SES relay | `x-sac-signature: HMAC-SHA256(rawBody, AMAZON_SES_INBOUND_SHARED_SECRET)`, comparação em tempo constante | idempotência por `eventId`/message id + `webhook_events` |
| Shopee | `Authorization: HMAC-SHA256(webhookUrl + "|" + rawBody, partnerKey)` + timestamp ±300 s | idempotência por `eventId`; `SET NX EX 86400` |
| Mercado Livre | **sem assinatura criptográfica**; resolve `user_id` para conta conectada | idempotência por `_id`; hidratação via API |
| Billing | `x-billing-signature: HMAC-SHA256(rawBody, BILLING_WEBHOOK_SECRET)` | unique `billing:<externalId>` |

Regra: o corpo do webhook **nunca** é fonte de verdade de conteúdo; o worker
hidrata o recurso na API oficial. Isso limita o impacto de um push forjado do
Meli a chamadas de API e linhas de auditoria (ver risco R-05).

### 6.7 Segredos — checklist operacional

- `.env` está no `.gitignore`; `.env.example` não contém segredo real.
- Rotação: trocar `ENCRYPTION_MASTER_KEY` exige manter a chave antiga no keyring
  até que todos os registros sejam re-cifrados; `JWT_SECRET` rotacionado
  invalida todas as sessões (aceitável, comunicar).
- Segredos de marketplace/SSO são criptografados no banco; nunca aparecem em
  respostas (o read model expõe `clientSecretConfigured`, não o valor).
- Se um segredo vazar: rotacionar **primeiro**, depois investigar; remover do
  histórico não basta.
- Acesso ao cofre do provedor (Render/Vercel/AWS) restrito a poucas pessoas com
  2FA; auditar convites periodicamente.

---

## 7. Dependências — `npm audit --omit=dev`

Execução: **2026-11-05**, Node 24.14.0, npm 11.1.0, lockfile commitado.

```
7 vulnerabilities (5 high, 2 moderate, 0 critical)
```

| Pacote | Versão | Severidade | Advisory (resumo) | Correção | Decisão |
|---|---|---|---|---|---|
| `deepmerge-ts` | 7.1.5 (via `@prisma/config`) | high | exaustão de pilha ao mesclar objetos recursivos (GHSA-ggr8-5vv4-36mx) | `deepmerge-ts@8` (major) | não aplicado: `@prisma/config@6.19.3` fixa `7.1.5`; exige `prisma@7` |
| `prisma` / `@prisma/client` | 6.19.3 | high | cadeia acima | `prisma@7.10.1+` (major) | não aplicado; CLI/dev, não atende request |
| `nodemailer` | 6.10.1 | high | múltiplos: parser de endereço (DoS), injeção de header, `disableFileAccess`/SSRF, validação de TLS OAuth2 | `nodemailer@10.3.1` (major) | não aplicado; planejar upgrade com testes de e-mail |
| `zod` | 3.25.76 | high | exaustão de memória em coleções com limites (GHSA-mrhx-c7xc-m3w5) | `zod@4.6.7` (major) | não aplicado; migração de schemas |
| `react-router` / `react-router-dom` | 6.30.6 | moderate | open redirect via `\` (bypass CVE-2025-68470); injeção em `deserializeErrors` (SSR) | `7.18.5` (major) | não aplicado; SPA sem SSR e rotas estáticas reduzem alcance |

Análise de alcance:

- **prisma/deepmerge-ts**: `@prisma/config` é usado pelo CLI (migrate/generate),
  não pelo `@prisma/client` em runtime. O merge é feito sobre configuração
  local, não input de usuário → explorabilidade baixa.
- **zod**: a falha exige coleção enorme/recursiva controlada pelo atacante. Os
  schemas limitam arrays/strings e o body tem teto de 1 MiB; risco residual
  baixo, mas a correção é recomendada.
- **nodemailer**: o uso é SMTP com destinatário validado e conteúdo montado pelo
  servidor; ainda assim, parsing de endereço e TLS são superfícies reais.
- **react-router**: SPA sem SSR; as rotas são fixas. O open redirect exige link
  controlado pelo atacante, que hoje não é renderizado a partir de input.

**Não foi executado `npm audit fix --force`** (mudaria majors sem teste e pode
quebrar build/testes). `npm audit fix` (não-force) não resolve a cadeia Prisma
porque a dependência é fixada. Plano: PRs separados por pacote (zod 4 → schemas;
nodemailer 10 → e-mails transacionais; prisma 7 → CLI/migrations; react-router 7
→ SPA), cada um com `npm run build` + `npm test` + smoke de login/envio.

---

## 8. Checklist LGPD (Lei 13.709/2018)

### 8.1 Inventário e bases legais

| Tratamento | Dados | Base legal | Retenção |
|---|---|---|---|
| Atendimento ao comprador | nome/e-mail/telefone/documento/endereço (vault), mensagens | execução de contrato (Art. 7, V) + legítimo interesse do lojista | PII 30 dias após envio; mensagens conforme política do tenant |
| Conta de operador | nome, e-mail, hash de senha, TOTP | execução de contrato | enquanto a conta existir |
| Segurança/auditoria | IP, user-agent, `requestId`, eventos | legítimo interesse / obrigação legal | logs conforme política de retenção |
| Billing | e-mail de cobrança, status de assinatura | execução de contrato | obrigação fiscal |
| SSO corporativo | e-mail, nome, grupos/roles do IdP | execução de contrato | enquanto a conexão existir |

- [ ] ROPA (Art. 37) atualizado com os tratamentos acima e operadores
      (Vercel, Render/AWS, S3, SMTP, marketplaces).
- [ ] Base legal revisada por jurídico para cada tratamento; legítimo interesse
      com teste de balanceamento documentado.
- [ ] RIPD (Art. 38) para PII de comprador em escala e para SSO/provisionamento
      automático.

### 8.2 Direitos do titular (Art. 18/19)

- [x] Exportação: `GET /api/v1/tenants/me/export` gera JSON por tenant, sem
      credenciais e sem o vault de PII, com `truncated` quando aplicável.
- [x] Exclusão: `DELETE /api/v1/tenants/me` exige senha do ADMIN + slug exato,
      faz soft delete e agenda purge físico (`queue.tenant.purge`).
- [x] Purge físico diário de workspace soft-deleted + purge de PII vencida.
- [ ] Procedimento formal de DSAR (canal, identidade, prazo de 15 dias,
      template de resposta) e registro de solicitações.
- [ ] Verificar se backups/índices/caches também são cobertos pelo purge e
      documentar o prazo máximo de persistência residual.

### 8.3 Segurança e governança

- [x] Criptografia em trânsito (HTTPS; HSTS na API em produção e na Vercel).
- [x] Criptografia de segredos em repouso (AES-256-GCM) e bucket privado.
- [x] Controle de acesso por tenant + RBAC + revalidação de admin de plataforma.
- [x] Registro de auditoria (`ticket_events`, `webhook_events`, logs
      estruturados com `requestId`).
- [x] Plano de resposta a incidentes (seção 9) com prazo ANPD.
- [ ] Designar e publicar o Encarregado (DPO) — Art. 41; canal de contato.
- [ ] Política de privacidade e termos publicados/versionados.
- [ ] Contratos de operador (DPA) com Vercel, Render/AWS, SMTP e marketplaces.
- [ ] Transferência internacional (Art. 33): mapear região dos provedores e
      adotar cláusulas-padrão/adequação.
- [ ] Revisão de retenção de logs (não guardar IP/e-mail além do necessário).
- [ ] Trilha de treinamento/conscientização e revisão periódica de acessos.

---

## 9. Resposta a incidentes (LGPD Art. 48 + Resolução CD/ANPD nº 15/2024)

### 9.1 Papéis

| Papel | Responsabilidade |
|---|---|
| Incident Commander (IC) | coordena, decide contenção, mantém timeline |
| Security Lead | investiga, preserva evidências, define erradicação |
| DPO/Encarregado | avalia risco aos titulares, decide/redige comunicação à ANPD |
| Engenharia de plantão | aplica mitigação, deploy, monitora |
| Comunicação/Jurídico | clientes, imprensa, contratos, notificações |

### 9.2 Fluxo (relógio começa na detecção)

1. **Detecção e triagem (0–1 h):** alerta, relato ou auditoria; abrir incidente
   com `requestId`/janela; classificar (vazamento, indisponibilidade,
   integridade, acesso indevido).
2. **Contenção (1–4 h):** revogar sessões/segredos, bloquear IP/origem, desligar
   integração afetada, isolar tenant. Preservar evidências **antes** de limpar
   (snapshot de logs, hash de artefatos, cópia do banco afetado).
3. **Erradicação e recuperação (4–24 h):** corrigir causa raiz, rotacionar
   chaves (`ENCRYPTION_MASTER_KEY`, `JWT_SECRET`, HMACs), restaurar backup
   verificado, monitorar recorrência.
4. **Avaliação LGPD (até 24 h):** o DPO decide se há risco/dano relevante aos
   titulares. Se sim, **comunicar a ANPD em até 3 dias úteis** (Res. 15/2024),
   com os elementos obrigatórios: descrição do incidente, natureza/categoria dos
   dados, titulares afetados, medidas técnicas de segurança, riscos, motivo da
   demora (se houver), medidas de mitigação, canal de contato, etc.
5. **Comunicação aos titulares:** quando houver risco/dano relevante, em
   linguagem clara, com o que aconteceu, dados afetados, medidas e canal.
6. **Encerramento e postmortem (até 5 dias úteis):** análise sem culpa, ações
   com owner/prazo, atualização deste documento e do RIPD. **Registrar o
   incidente por 5 anos** (Res. 15/2024).
7. **Follow-up:** reteste das ações, revisão de detecção/monitoramento,
   comunicação a clientes enterprise conforme contrato.

### 9.3 Contatos (preencher antes do go-live)

```
DPO/Encarregado: <nome> · <e-mail> · <telefone>
Security on-call: <canal> · <escalation>
Jurídico: <contato>
ANPD: https://www.gov.br/anpd/pt-br (formulário de comunicação de incidente)
Clientes enterprise: <CSM/contrato>
```

### 9.4 Evidências mínimas

- `webhook_events` e `ticket_events` da janela; logs estruturados por
  `requestId`/`agentId`; trilha do provedor (Render/Vercel/AWS); diff de
  configuração; hashes de artefatos; decisão e horário de cada contenção.

---

## 10. Pentest recomendado

**Quando:** antes do go-live enterprise, anualmente, e após mudanças em
autenticação/SSO, upload, webhooks ou multi-tenancy.

**Escopo mínimo (gray-box, com credenciais de teste em tenant isolado):**

- Autenticação: login, 2FA (TOTP/recovery), refresh rotativo, logout, lockout,
  enumeração, força bruta distribuída.
- SSO OIDC: state/nonce/PKCE, validação de ID token, troca de `redirect_uri`,
  replay, domain allowlist, provisionamento, `enforce_sso` e break-glass.
- Autorização multi-tenant: IDOR horizontal/vertical em tickets, contas,
  arquivos, export/delete, console de plataforma.
- Webhooks: forja de push, replay, assinatura, SSRF via payload/resource,
  idempotência, DoS de tamanho.
- Upload/armazenamento: MIME/magic bytes, SVG/HTML, presigned URL, path
  traversal, key injection.
- API: injeção, mass assignment, CORS, headers/CSP, cache, erros, rate limit.
- SPA: XSS stored/reflected/DOM, open redirect, exposição de token em
  `localStorage`, dependências.
- Infra: exposição de portas, TLS, Redis/Postgres/S3, segredos, IAM, backups.

**Metodologia:** OWASP ASVS L2, OWASP Top 10 (2021) e API Security Top 10
(2023), teste manual + ferramentas (Burp/ZAP, nuclei) com regra de “não
derrubar produção”.

**Entregáveis:** relatório executivo, achados com CVSS, PoC, evidência,
recomendação, reteste em até 30 dias e carta de remediação. Achados
críticos/altos bloqueiam go-live enterprise.

---

## 11. Matriz de risco

Escala: probabilidade (1–5) × impacto (1–5). Risco residual após controles.

| ID | Risco | P | I | Score | Nível | Controles / observação |
|---|---|---|---|---|---|---|
| R-01 | Vazamento de token de marketplace | 2 | 5 | 10 | Alto | AES-GCM, redaction, RBAC, keyring; rotate se suspeita |
| R-02 | Enumeração/força bruta em login | 3 | 3 | 9 | Médio | rate limit + bcrypt dummy + 429 uniforme; monitorar |
| R-03 | PII de comprador exposta além da retenção | 2 | 5 | 10 | Alto | vault + purge 30 d + export sem PII; validar backups |
| R-04 | XSS na SPA → roubo de token em `localStorage` | 2 | 5 | 10 | Alto | CSP, sem innerHTML; **migrar para cookie HttpOnly (P1)** |
| R-05 | Push Meli forjado (sem assinatura) | 3 | 2 | 6 | Médio | resolução de conta + hidratação via API + idempotência; avaliar segredo compartilhado |
| R-06 | Sequestro de sessão (access 12 h sem denylist) | 2 | 4 | 8 | Médio | refresh rotativo + tenant gate; reduzir TTL/denylist |
| R-07 | SSRF via feature futura de URL | 2 | 4 | 8 | Médio | nenhuma feature hoje; regra obrigatória na seção 3.5 |
| R-08 | Injeção SQL/NoSQL | 1 | 5 | 5 | Baixo | Prisma parametrizado + Zod |
| R-09 | Phishing de OAuth/consentimento | 3 | 3 | 9 | Médio | state/nonce/PKCE; treinamento e comunicação |
| R-10 | Dependência vulnerável explorada | 3 | 3 | 9 | Médio | audit + roadmap de majors; monitorar advisories |
| R-11 | Flood/DoS em webhook/API pública | 3 | 3 | 9 | Médio | assinatura + idempotência + body limit; **falta rate limit HTTP (P1)** |
| R-12 | Segredo default em produção | 2 | 5 | 10 | Alto | checklist de deploy; **falta fail-closed (P0)** |
| R-13 | Enumeração de tenant em `signup` | 3 | 2 | 6 | Médio | trade-off de UX; rate limit |
| R-14 | Upload de SVG/HTML servido inline | 2 | 3 | 6 | Médio | `image/*` inclui SVG; avaliar bloqueio/Content-Disposition |

Revisão trimestral; qualquer mudança de arquitetura recalcula a matriz.

---

## 12. OAuth/OIDC corporativo — requisitos obrigatórios para o SSO

Esta seção é o **contrato de segurança** para o SSO enterprise (Entra ID,
Google Workspace, Okta ou OIDC genérico). A implementação atual vive em
`application/SsoAuthService.ts`, `application/TenantSsoService.ts` e
`application/sso/{OidcClient,validation,pkce}.ts`; o schema em
`prisma/schema.prisma` (`TenantSsoConnection`). O merge do SSO só é aceito com
**todos** os itens abaixo cobertos e testados.

### 12.1 Fluxo de autorização

- [ ] `state`: valor aleatório com ≥32 bytes de entropia, **HMAC-assinado**,
      vinculado a provider/tenant/`redirect_uri`, armazenado server-side
      (Redis) com TTL ≤10 min e **single-use** (consumido antes do exchange).
- [ ] `nonce`: gerado por login, enviado no `authorization_request` e conferido
      no ID token; single-use.
- [ ] **PKCE S256 obrigatório** em todos os fluxos (inclusive confidential
      client), `code_verifier` gerado no servidor, nunca no navegador.
- [ ] `redirect_uri` exato, https (exceto localhost em dev), registrado no IdP;
      nunca derivado de header/query.
- [ ] `response_type=code`; `response_mode=query`; nada de implicit/hybrid.
- [ ] `scope` mínimo: `openid profile email` (+ `groups` somente se o mapa de
      papéis exigir).

### 12.2 Validação do ID token (obrigatória, sem exceção)

| Claim/etapa | Regra |
|---|---|
| Assinatura | RS256/ES256 com `kid` do JWKS do issuer; rejeitar `none`, HS256 não configurado, algoritmo fora da allowlist |
| `iss` | igualdade exata ao issuer configurado **e** ao `issuer` do discovery (sem wildcard, sem sufixo) |
| `aud` | contém o `client_id`; se múltiplas audiences, `azp` precisa ser o `client_id` |
| `exp` | obrigatório, não expirado (skew ≤60 s) |
| `nbf` / `iat` | válidos, `iat` não no futuro (skew ≤60 s) |
| `nonce` | igual ao nonce emitido e ainda não usado |
| `sub` | presente e estável; nunca usar e-mail como chave primária |
| `email` | presente, normalizado (trim/lowercase, punycode) |
| `email_verified` | **true**; ausente = rejeitar (ou exigir configuração explícita) |
| Domínio | e-mail precisa pertencer a `allowed_domains` (lista vazia = ninguém); comparação exata de domínio, sem `endsWith` ingênuo que aceite `evilacme.com` |
| `hd` (Google) | quando aplicável, igual ao domínio permitido |
| `tid` (Entra) | quando aplicável, igual ao tenant configurado |

- [ ] JWKS/discovery em HTTPS, com timeout, limite de tamanho e cache (1 h);
      refetch forçado em rotação de `kid`; nunca confiar no documento sem
      validar `issuer`.
- [ ] Erros de validação são genéricos ao usuário (sem diferenciar “e-mail não
      verificado” de “domínio inválido” na resposta pública) e detalhados
      apenas no log interno, sem token.

### 12.3 Sessão e provisionamento

- [ ] Somente após todas as validações: resolver/criar operador, aplicar
      `group_role_map` → `AgentRole` (menor privilégio), respeitar
      `auto_provision` e `default_role`.
- [ ] `enforce_sso` bloqueia senha **depois** da validação da senha (não
      enumera); platform admin é break-glass explícito e auditado.
- [ ] Sessão emitida pelo mesmo `issueSession` do login (refresh rotativo, JWT
      com `iss`/`aud`), sem token do IdP no navegador.
- [ ] Re-vincular/atualizar e-mail só com `email_verified`, nunca por claim
      não verificado.
- [ ] Logout/revogação do lado do IdP quando disponível. O logout local revoga
      o refresh **e** denylista o `jti` do access token atual; um access token
      emitido por outro device segue válido até `exp` (o "logout everywhere" não
      denylista por usuário).
- [ ] Auditoria: `auth.sso.*` com `tenantId`, `provider`, `result`, sem token
      nem e-mail completo.

### 12.4 Requisitos de configuração (por tenant)

- [ ] `issuerUrl` https, normalizado, sem barra final.
- [ ] `clientSecretEnc` cifrado (ou `null` = public client com PKCE).
- [ ] `allowedDomains` preenchido e revisado; nunca domínio público
      (`gmail.com`, `outlook.com`) em produção enterprise.
- [ ] `redirectUri` exato e https.
- [ ] `groupRoleMap` revisado por menor privilégio; `defaultRole` = `AGENT`,
      nunca `ADMIN`.
- [ ] Desativar a conexão (`enabled=false`) invalida novos logins; sessões
      existentes seguem o TTL do access token.

### 12.5 OAuth de marketplace (contexto)

Amazon/Meli/Shopee usam authorization code com `client_secret` server-side (sem
PKCE, pois são clientes confidenciais), `state` assinado/single-use com TTL de
10 min (`AccountService`) e tokens cifrados em repouso. O callback é público por
necessidade; a segurança vem do `state` + troca server-side. Não reutilizar o
`state` de marketplace para SSO e vice-versa.

---

## 13. Testes de segurança

### 13.1 Novos testes (sem rede, `app.inject`)

`packages/server/src/http/__tests__/security-hardening.test.ts` — 14 casos:

- headers de segurança na API (CSP `default-src 'none'`, XFO `DENY`, nosniff,
  referrer, COOP/CORP, Permissions-Policy);
- HSTS ausente fora de produção e presente com `NODE_ENV=production`;
- headers preservados em 401 + `no-store` em `/api`;
- CORS permite origem da allowlist e **não** emite `Access-Control-Allow-Origin`
  para origem desconhecida (simple e preflight);
- wildcard em `WEB_ORIGIN` é ignorado;
- body JSON > 1 MiB em `/api/v1/*` → **413**; 2 MiB em webhook continua aceito;
- webhook sem assinatura → **401** `{status:'REJECTED'}`;
- `RateLimitError` → **429** + `Retry-After`;
- JWT válido sem tenant → **403** (`requireTenantId`).

### 13.2 Cobertura existente

| Requisito | Teste existente |
|---|---|
| Rate limit 429 (login/2FA/reset) | `application/__tests__/AuthRateLimit.test.ts` (10 tentativas → 429 na 11ª; 5 → 429 na 6ª; fallback com Redis down), `TwoFactor.test.ts:739` |
| Webhook sem assinatura 401 (billing) | `http/__tests__/billing-routes.test.ts:197,209` |
| HMAC Amazon SES / Shopee | `adapters/amazon/__tests__/sesRelay.test.ts`, `adapters/shopee/__tests__/sign.test.ts` |
| JWT sem tenant / RBAC | `http/__tests__/invitation-routes.test.ts:114,175`, `tenant-routes.test.ts:102`, `platform-routes.test.ts:257` |
| Status público sem PII | `http/__tests__/status-routes.test.ts` |

### 13.3 Como rodar

```bash
npm test -- --run packages/server/src/http/__tests__/security-hardening.test.ts
npx tsc -p packages/server/tsconfig.json --noEmit
npm run build:shared
```

---

## 14. Gaps e roadmap priorizado

### P0 — antes de qualquer cliente enterprise

1. **Segredos default em produção.** `JWT_SECRET` e `ENCRYPTION_MASTER_KEY` têm
   fallback de desenvolvimento (`config/env.schema.ts`); a validação de
   produção só checa tamanho do JWT. Fazer o boot falhar se o valor default for
   detectado (`loadConfig`), com mensagem acionável. Enquanto isso, checklist de
   deploy obrigatório.
2. **Rate limit HTTP global.** Não há limite por IP/rota para webhooks e rotas
   públicas; um atacante pode inundar `/webhooks/*` e `/auth/*` (mesmo com 429
   de auth por e-mail, o custo de parsing/DB existe). Adotar
   `@fastify/rate-limit` com store Redis e limites distintos por prefixo
   (webhook mais generoso; auth mais rígido), retornando `Retry-After`.
3. **Cobertura da denylist de access token.** O logout já denylista o `jti` do
   token apresentado (ver 3.8). Faltam: (a) denylist por usuário no "logout
   everywhere"/reset de senha, para matar access tokens de outros devices; (b) o
   handshake do Socket.IO valida a assinatura mas não consulta a denylist.

### P1 — próximas 2 sprints

4. **Token no `localStorage`.** Migrar para cookie `HttpOnly`/`SameSite` + CSRF
   (ver 3.1) ou memória + refresh silencioso; enquanto isso, manter CSP estrita
   e revisar qualquer `dangerouslySetInnerHTML` (hoje zero).
5. **E-mail em log de falha de login.** `AgentService.ts:177` → usar
   `redactPiiForLogs`/hash. (Arquivo em edição pelo owner do SSO — coordenar.)
6. **Webhook Meli sem assinatura.** Avaliar segredo compartilhado no header
   (contrato já menciona “optional shared secret header”) ou validação de
   origem por IP do Meli; documentar risco aceito se não houver opção.
7. **`trustProxy: true` incondicional.** Garantir que a API só é alcançável
   pelo edge (Render/Vercel/Cloudflare) e que o edge sobrescreve
   `X-Forwarded-For`; caso contrário, rate limit por IP é burlável.
8. **SVG/HTML em upload.** `image/*` aceita SVG; bloquear `image/svg+xml` ou
   servir com `Content-Disposition: attachment` + CSP sandbox no bucket.
9. **CSP do SPA com hosts exatos.** Trocar `connect-src https: wss:` por
   `https://api.<domínio> wss://api.<domínio>`; adicionar
   `Content-Security-Policy-Report-Only` com coletor antes de bloquear.

### P2 — backlog de hardening

10. Migrar dependências com correção apenas em major (zod 4, nodemailer 10,
    prisma 7, react-router 7) — PRs separados e testados (seção 7).
11. Purge/rotação de chaves automatizado (keyring + re-cifragem) e teste de
    restore de backup.
12. Rate limit/CAPTCHA em `signup` para reduzir enumeração e abuso.
13. Cifrar colunas de PII do vault (pgcrypto) ou documentar dependência de
    criptografia de disco do provedor.
14. Alertas de segurança (falhas de login, 401 de webhook, 429, picos de 5xx) e
    retenção de logs definida.
15. DPO publicado, DPA/transferência internacional, RIPD e política de
    privacidade.
16. Pentest independente antes do go-live enterprise e plano de reteste.
17. WAF/edge rules (Vercel/Render/Cloudflare) para OWASP Top 10 e bots.
18. Guard de `Content-Type` nas rotas `/api/v1` (exigir `application/json`,
    exceto multipart/billing) para reduzir parser confusion e simplificar CORS.

---

## 15. Referências

- LGPD — Lei 13.709/2018, Arts. 7, 18, 19, 37, 38, 41, 46, 48.
- Resolução CD/ANPD nº 15/2024 (comunicação de incidentes, 3 dias úteis,
  registro por 5 anos).
- OWASP ASVS 4.x (L2), OWASP Top 10 2021, OWASP API Security Top 10 2023.
- OIDC Core 1.0 / RFC 6749 / RFC 7636 (PKCE) / RFC 8414 (discovery) /
  RFC 9700 (OAuth 2.0 Security BCP).
- Documentos internos: `docs/PHASE1_AUTH.md` (rate limits e sessões),
  `docs/PHASE4_BACKUP_RESTORE.md` (backups com PII), `docs/API_CONTRACT.md`
  (webhooks), `docs/SETUP_PRODUCTION.md` (variáveis e deploy).
