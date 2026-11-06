# SSO corporativo (OpenID Connect) — Microsoft Entra ID, Google, Okta e OIDC genérico

> **Status:** implementado (Fase 5) · **Última revisão:** 2026-11-05
> **Código:** `application/TenantSsoService.ts`, `application/SsoAuthService.ts`,
> `application/sso/{OidcClient,validation,pkce}.ts`,
> `application/repositories/sso-{connections,agents}.ts`,
> `http/controllers/sso.controller.ts`, `http/schemas/sso.schema.ts`,
> `prisma/schema.prisma` (`TenantSsoConnection`).
> **Contrato de segurança:** `docs/SECURITY.md` §12 (pré-requisito de merge).

O login corporativo é um **authorization-code flow OIDC genérico com PKCE S256,
`nonce` e `state` assinado de uso único**. `MICROSOFT`, `GOOGLE`, `OKTA` e `OIDC`
são apenas presets de onboarding: o protocolo e as validações são os mesmos.
Cada workspace tem **uma** conexão (`tenant_sso_connections.tenant_id` é UNIQUE),
o que torna o roteamento por domínio de e-mail inequívoco.

---

## 1. Endpoints

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/v1/tenants/me/sso` | JWT **ADMIN** | Configuração do workspace **sem segredo** (`clientSecretConfigured`). `404 SSO_NOT_CONFIGURED` se não existir. |
| PUT | `/api/v1/tenants/me/sso` | JWT **ADMIN** | Upsert (`provider`, `issuerUrl`, `clientId`, `clientSecret?`, `redirectUri?`, `allowedDomains?`, `groupRoleMap?`, `autoProvision?`, `defaultRole?`, `enforceSso?`, `enabled?`). `200` com a config. |
| DELETE | `/api/v1/tenants/me/sso` | JWT **ADMIN** | Remove a conexão. `204`; `404 SSO_NOT_CONFIGURED` se não havia nada. |
| POST | `/api/v1/tenants/me/sso/test` | JWT **ADMIN** | Testa a conexão **salva** sem trocar tokens (só lê discovery + JWKS). `200 { ok, checks[], issuer?, authorizationEndpoint?, tokenEndpoint?, jwksKeys?, enabled }`; `404 SSO_NOT_CONFIGURED`; `429 RATE_LIMITED` (10/15 min por workspace + IP). |
| GET | `/api/v1/auth/sso/discover?email=` ou `?domain=` | pública | `{ enabled, provider, tenantSlug }` se houver conexão **habilitada** para o domínio; `404 SSO_NOT_CONFIGURED` caso contrário. |
| GET | `/api/v1/auth/sso/start?email=&provider=` | pública | `302` para o `authorization_endpoint` do IdP com `state`, `nonce` e `code_challenge` S256. |
| GET | `/api/v1/auth/sso/callback?code=&state=` | pública | Valida tudo, faz o JIT e responde `302 <WEB_ORIGIN>/auth/sso/callback?code=<código de uso único>`. Nunca devolve token na URL. |
| POST | `/api/v1/auth/sso/exchange { code }` | pública | `200 AuthResponse` (`token` + `refreshToken` + `agent`); consome o código **uma vez**. `401 INVALID_SSO_CODE`. |

As quatro rotas públicas estão na **allowlist exata** do guard JWT
(`http/middleware/auth.ts`). Não existe prefixo curinga: `/auth/sso/<qualquer
outra coisa>` continua exigindo JWT e responde `404`.

### Fluxo

```
SPA                         API                                   IdP (Entra ID)
 │  GET /auth/sso/discover   │                                        │
 │──────────────────────────►│ (enabled? provider? tenantSlug?)       │
 │  window.location = start  │                                        │
 │──────────────────────────►│ 302 authorize?client_id&state&nonce    │
 │◄──────────────────────────│     &code_challenge=…&method=S256      │
 │  (browser follows)        │                                        │
 │───────────────────────────────────────────────────────────────────►│
 │                           │                                        │ login + consent
 │  GET /callback?code&state │                                        │
 │──────────────────────────►│ assinatura do state + Redis single-use │
 │                           │ POST /token (code + verifier + secret) │
 │                           │◄───────────────────────────────────────│
 │                           │ valida ID token (RS256/JWKS, iss, aud, │
 │                           │ exp/nbf/iat, nonce, e-mail verificado, │
 │                           │ domínio permitido) + JIT provisioning  │
 │ 302 <WEB_ORIGIN>/auth/sso/callback?code=opaco                      │
 │◄──────────────────────────│                                        │
 │  POST /auth/sso/exchange  │                                        │
 │──────────────────────────►│ consome o código (60 s), emite JWT +   │
 │◄──────────────────────────│ refresh token (issueSession)           │
```

---

## 2. Microsoft Entra ID — passo a passo

### 2.1 App registration

1. **Entra ID → App registrations → New registration**
   - *Supported account types*: **Accounts in this organizational directory only
     (single tenant)** — salvo se você realmente precisa de multitenant.
   - *Redirect URI*: plataforma **Web** e o valor exato
     `https://<API_BASE_URL>/api/v1/auth/sso/callback`
     (ex.: `https://api.suaempresa.com.br/api/v1/auth/sso/callback`).
     O mesmo valor deve aparecer em `/settings → Autenticação corporativa`
     (a API devolve a URL efetiva em `GET /tenants/me/sso.redirectUri`).
2. **Certificates & secrets → Client secrets → New client secret**.
   Copie **o valor** (não o Secret ID) para o formulário do `/settings`; ele é
   cifrado pela API (AES-256-GCM, `SecretCipher`) e **nunca** é devolvido.
   Anote a data de expiração: a rotação é manual (ver §7).
3. **Overview**: copie **Application (client) ID** → campo *Client ID*.
4. **Issuer URL** (campo do formulário):
   `https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0`
   — **com** `/v2.0` e **sem** barra no final. A API deriva a discovery de
   `<issuer>/.well-known/openid-configuration` e exige que `issuer` do documento
   seja exatamente o configurado (documento v2 devolve `.../v2.0`; o endpoint sem
   versão devolve `https://sts.windows.net/<id>/` e seria rejeitado).
   Para a nuvem soberana, use o issuer correspondente (ex.:
   `https://login.microsoftonline.us/<id>/v2.0`).

### 2.2 Claims de e-mail e grupos

- **E-mail**: a API aceita, nesta ordem, `email`, `preferred_username` e `upn`,
  e exige `email_verified === true` **quando o claim existe**. O Entra ID
  costuma **não** enviar `email_verified` para contas de trabalho; nesse caso a
  garantia vem do domínio permitido + `preferred_username` do tenant. Se você
  precisa do claim `email` explícito: **Token configuration → Add optional claim
  → ID → email** (e aceite a permissão de Graph se solicitada).
- **Grupos**: **Token configuration → Add groups claim → Security groups**
  (ou *Groups assigned to the application* para reduzir o tamanho do token).
  A API lê `groups` (array ou string separada por espaço) **e** `roles`
  (App roles). Grupos aninhados não são expandidos pelo Entra; use *Groups
  assigned to the application* em implantações grandes (> 200 grupos, ver §8).
- **Group role map**: no `/settings`, informe `{"<object-id-do-grupo>": "ADMIN",
  "<outro-grupo>": "SUPERVISOR"}`. O papel de **maior privilégio** entre os
  grupos que casarem vence; `ADMIN > SUPERVISOR > AGENT`. Sem casamento:
  - na **criação** (JIT): `defaultRole`;
  - em um operador **existente**: o papel atual é **preservado** (um grupo não
    mapeado nunca rebaixa um ADMIN).
- `name` vira o nome do operador (fallback: parte local do e-mail).

### 2.3 Permitir os domínios

`allowedDomains` é obrigatório para o fluxo funcionar: a descoberta e o callback
casam o domínio do e-mail contra essa lista (comparação exata, lowercase, sem
`@`, sem ponto final). **Lista vazia = ninguém entra** (deny-by-default). O
`PUT /tenants/me/sso` recusa `enforceSso=true` com lista vazia.

O formulário normaliza `@Empresa.com.BR.` → `empresa.com.br` e remove duplicatas.

### 2.4 Google Workspace / Okta / OIDC genérico

| Provider | Issuer (`issuerUrl`) | Observações |
|---|---|---|
| `GOOGLE` | `https://accounts.google.com` | Redirect URI do tipo *Web application*; `email_verified` vem no ID token. Para Google Workspace, `hd` não é usado: a allowlist de domínio faz o papel. |
| `OKTA` | `https://<seu-dominio>.okta.com` (ou `/oauth2/<auth-server>`) | Grupos no claim `groups` (Groups claim filter). App do tipo *Web*. |
| `OIDC` | issuer do provedor | Qualquer provedor compatível com OIDC Discovery + RS256 + PKCE S256. |

Requisitos do provedor: discovery em `<issuer>/.well-known/openid-configuration`,
`authorization_endpoint`/`token_endpoint`/`jwks_uri` em **https**, ID token
assinado em **RS256** com `kid` no JWKS, suporte a **PKCE S256** e ao parâmetro
`nonce`.

---

## 3. Modelo de dados

`tenant_sso_connections` (uma linha por workspace, `ON DELETE CASCADE`):

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID **UNIQUE** FK `tenants` | um IdP por workspace |
| `provider` | `SsoProvider` | `MICROSOFT` \| `GOOGLE` \| `OKTA` \| `OIDC` |
| `issuer_url` | VARCHAR(512) | https, sem barra final |
| `client_id` | VARCHAR(255) | público |
| `client_secret_enc` | TEXT NULL | **cifrado** com `SecretCipher`; `NULL` = public client (PKCE) |
| `redirect_uri` | VARCHAR(512) | exato, registrado no IdP |
| `scopes` | VARCHAR(255) | default `openid profile email` |
| `allowed_domains` | TEXT[] | default `{}` (ninguém) |
| `group_role_map` | JSONB | default `{}` |
| `auto_provision` | boolean | default `true` |
| `default_role` | `AgentRole` | default `AGENT` |
| `enforce_sso` | boolean | default `false` |
| `enabled` | boolean | default `true` |
| `created_at` / `updated_at` | timestamptz | — |

Índices: UNIQUE(`tenant_id`), `enabled`, `provider` e **GIN**
(`allowed_domains`) para o `@>` da descoberta por domínio.

Operadores criados por JIT recebem:
`password_hash = bcrypt(<48 bytes aleatórios>)` (ninguém sabe a senha, então o
login por senha é impossível), `email_verified_at = now()`, `is_active = true`,
`must_reset_password = false`.

---

## 4. Controles de segurança

| Controle | Implementação |
|---|---|
| `state` | aleatório + **HMAC-SHA256** (chave derivada de `JWT_SECRET` com separação de domínio); registro server-side no Redis (TTL **10 min**); consumo **single-use** (`setNx` do marcador + `del`), então replay concorrente falha. `state` inválido/forjado/expirado/repetido → `400 SSO_STATE_INVALID`, **sem redirect** |
| `nonce` | 32 bytes aleatórios no authorize e conferência em tempo constante no ID token |
| PKCE | `S256` obrigatório; verifier de 32 bytes só no servidor (Redis, junto do state) |
| ID token | RS256 **somente** (rejeita `none`/HS256), JWKS do issuer com cache (Redis + memória, 1 h) e **um** refetch forçado em rotação de `kid`; valida `iss`, `aud` (string ou array) + `azp`, `exp`, `nbf`, `iat` e `nonce` com skew de 60 s |
| Discovery | `<issuer>/.well-known/openid-configuration`; endpoints precisam ser https; `issuer` do documento tem de ser **exatamente** o configurado |
| E-mail | `email` → `preferred_username` → `upn`; `email_verified` quando presente precisa ser `true`; domínio precisa estar em `allowed_domains` |
| Client secret | AES-256-GCM (`ENCRYPTION_MASTER_KEY`); write-only; a API expõe só `clientSecretConfigured`; falha de decifração → `409 SSO_NOT_CONFIGURED` |
| Tokens | nunca na URL nem no Redis: o callback guarda **apenas** `{ agentId, tenantId }` sob um código opaco (SHA-256 no Redis, TTL **60 s**); `exchange` chama `agents.issueSession` (mesmo JWT/refresh/presença do login por senha) |
| Redirect | o sucesso e os erros pós-state usam **sempre** `${primeira WEB_ORIGIN}/auth/sso/callback` (nunca um destino vindo da requisição); `state` inválido não redireciona |
| Rate limit | Redis + fallback em memória (`AuthRateLimiter`), por IP: `discover` 30/15 min; `start`, `callback` e `exchange` 20/15 min → `429 RATE_LIMITED` |
| Logs | `auth.sso.*` com `tenantId`, `connectionId`, `provider`, `domain`, `agentId`, `jit`, `roleMapped`; **nunca** token, code, nonce, verifier, secret ou e-mail completo |
| Erros estáveis | `SSO_NOT_CONFIGURED` (404/409), `SSO_STATE_INVALID` (400), `SSO_TOKEN_INVALID` (401), `SSO_EMAIL_UNVERIFIED` (403), `SSO_DOMAIN_NOT_ALLOWED` (403), `SSO_REQUIRED` (403), `SSO_PROVIDER_ERROR` (502), `SSO_ACCOUNT_CONFLICT` (409), `SSO_ACCOUNT_DISABLED` (403), `SSO_PROVISIONING_DISABLED` (403), `INVALID_SSO_CODE` (401), `SSO_CANCELLED` (redirect) |
| Anti-takeover | e-mail que já pertence a **outro** workspace → `409 SSO_ACCOUNT_CONFLICT` (nunca re-parente); operador desativado → `403 SSO_ACCOUNT_DISABLED` (SSO não reativa conta suspensa por um admin) |
| Enumeração | `discover`/`start` respondem o mesmo `404 SSO_NOT_CONFIGURED` para domínio inexistente, conexão desabilitada e provider divergente |

---

## 5. `enforce_sso` e break-glass (decisão)

Com `enforce_sso = true` **e** `enabled = true`, o login por senha do workspace
é bloqueado com `403 SSO_REQUIRED`. A checagem roda **depois** de:

1. validar a senha (bcrypt);
2. `is_active`;
3. `email_verified_at`;
4. o workspace estar `ACTIVE`.

Assim, senha errada continua `401` e o estado do workspace não vaza para quem
não provou a credencial. A checagem acontece **antes** do desafio de 2FA: quem
tem 2FA e workspace com SSO obrigatório recebe `403 SSO_REQUIRED` (não um
challenge que nunca poderá ser concluído).

**Break-glass: apenas `agents.is_platform_admin = true`.** Um ADMIN do tenant
**não** é isento. Racional:

- o ADMIN do tenant pode configurar o SSO errado (issuer/domínio/secret) e se
  trancar para fora; permitir que ele ignore a própria política esvaziaria o
  controle (o papel mais poderoso do tenant continuaria com senha para sempre);
- o operador da plataforma IntegrAI (seed `ADMIN_EMAIL`/`PLATFORM_ADMIN_EMAILS`)
  é o caminho de recuperação: entra com senha, corrige ou desabilita a conexão;
- alternativas de recuperação: `DELETE /tenants/me/sso` por um ADMIN **já
  autenticado** (sessão emitida antes do enforcement), ou ajuste direto no banco
  em último caso.

**Riscos aceitos/documentados**

- Um ADMIN que ativou `enforce_sso` sem ter uma identidade SSO válida (mesmo
  domínio do IdP) fica dependente do platform admin. Recomendação no runbook:
  validar o login SSO em uma janela anônima **antes** de ligar o enforcement, e
  manter um ADMIN de plataforma ativo.
- Desativar um operador no IntegrAI **não** o desprovisiona no IdP; o login SSO
  falha com `SSO_ACCOUNT_DISABLED` (a conta local é a fonte de verdade para
  acesso).
- O access JWT continua válido até expirar (`JWT_EXPIRES_IN`, default 12 h)
  depois de uma revogação local — mesma semântica do login por senha.

---

## 6. Passo a passo de ativação (rollout)

1. **Pré-requisito**: `APP_BASE_URL` público com HTTPS e a rota
   `/api/v1/auth/sso/callback` acessível; `WEB_ORIGIN` aponta para o SPA.
2. Crie o app registration (§2.1) e copie issuer/client id/secret.
3. No SPA, `/settings → Autenticação corporativa`: preencha issuer, client id,
   secret e os **domínios permitidos**; mantenha `enabled = true` e
   `enforceSso = false` no primeiro momento. Salve.
4. Abra uma janela anônima em `/login`, informe um e-mail do domínio e clique em
   **Entrar com Microsoft**. Confirme:
   - o operador aparece na equipe (JIT) com o papel esperado;
   - o `/settings` mostra `clientSecretConfigured = true` e a mesma redirect URI;
   - `audit`/logs mostram `auth.sso.callback.succeeded` com `jit: true`.
5. Só então ligue `enforceSso`. Teste novamente com um segundo operador.
6. Comunique a equipe: o botão de senha deixa de funcionar para os domínios
   cobertos.

---

## 7. Operação

- **Rotação do client secret**: crie o novo secret no Entra, salve no
  `/settings` (o campo em branco mantém o antigo; preenchido, substitui e
  re-cifra) e revogue o antigo no Entra depois de validar um login.
- **Mudança de issuer/client id**: salve o novo valor; fluxos em andamento
  falham com `SSO_STATE_INVALID`/`SSO_TOKEN_INVALID` e o usuário reinicia.
- **Desligar temporariamente**: `enabled = false` (bloqueia `discover`, `start` e
  `callback` imediatamente) sem apagar a configuração.
- **Remover**: `DELETE /tenants/me/sso` apaga a linha (e o secret cifrado). O
  `password_hash` aleatório dos operadores JIT permanece; defina senhas via
  “esqueci minha senha” se precisar voltar ao login por senha.
- **Expiração do secret no Entra**: monitorar a data; a falha aparece como
  `401 SSO_TOKEN_INVALID` no callback e `auth.sso.provider.token_rejected` com
  `providerError=invalid_client`.
- **Chaves**: `JWT_SECRET` novo invalida `state` em andamento (aceitável);
  `ENCRYPTION_MASTER_KEY`/`ENCRYPTION_KEY_ID` exigem o keyring para decifrar
  segredos antigos (`SecretCipher`, `docs/SECURITY.md` §6.7).

### Testar a conexão antes de ativar `enforceSso`

`POST /api/v1/tenants/me/sso/test` valida a conexão **já salva** antes de ligar
`enforceSso`, para que um erro de App registration não bloqueie o workspace
inteiro. É um probe **somente leitura**: baixa o discovery
(`<issuer>/.well-known/openid-configuration`, timeout de 5 s, sem cache) e o
JWKS; **não** troca código por token, **não** usa o client secret (funciona para
public client/PKCE) e nunca devolve o segredo.

`checks[]` usa nomes estáveis: `discovery`, `issuer`, `authorization_endpoint`,
`token_endpoint`, `jwks_uri`, `response_types` (`code`), `code_challenge_methods`
(S256), `id_token_signing_alg` (RS256), `jwks` (chave RSA/sig com `kid`) e
`allowed_domains`. `ok` só é `true` quando todos passam; cada `detail` é livre de
segredo/PII (status HTTP, contagens, issuer esperado × encontrado). `jwksKeys` são
os **kids** das chaves RSA/sig utilizáveis (lista; `[]` quando nenhuma). O campo
`enabled` é apenas informativo: uma conexão desabilitada **pode** ser testada
(é exatamente o caso de configurar antes de ativar) e isso não torna `ok` falso.
Sem cache de resultado — o admin vê o efeito da correção imediatamente; o abuso é
contido pelo limite de 10 chamadas por 15 min por workspace + IP.

### Diagnóstico rápido

| Sintoma | Causa provável | Correção |
|---|---|---|
| `discover` 404 para um domínio válido | conexão desabilitada, domínio fora de `allowed_domains` ou workspace suspenso | revisar `/settings` e o status do workspace |
| `start` 404 com provider escolhido | provider do botão ≠ provider configurado | usar o provider correto (`microsoft`) |
| `SSO_PROVIDER_ERROR` (502) no start | discovery inacessível, issuer errado, endpoint não-https ou `issuer` do documento divergente | conferir `issuerUrl` (com `/v2.0`, sem barra final) e conectividade de saída |
| `SSO_TOKEN_INVALID` com `reason: audience` | client id do formulário ≠ app registration | corrigir o `clientId` |
| `SSO_TOKEN_INVALID` com `reason: nonce` | outro fluxo/aba, ou IdP reaproveitando autorização | reiniciar o login |
| `SSO_TOKEN_INVALID` com `reason: signature`/`unknown_kid` | JWKS rotacionado e cache antigo, ou issuer de outra nuvem | repetir (há refetch automático); conferir issuer |
| `SSO_DOMAIN_NOT_ALLOWED` | e-mail fora da allowlist (ex.: convidado `#EXT#`) | incluir o domínio ou bloquear convidados no Entra |
| `SSO_EMAIL_UNVERIFIED` | IdP marcou `email_verified=false` | verificar a conta no IdP |
| `SSO_ACCOUNT_CONFLICT` | e-mail já existe em outro workspace | usar o workspace correto; não re-parente |
| `SSO_PROVISIONING_DISABLED` | `autoProvision=false` e usuário sem convite | convidar o operador primeiro |
| `INVALID_SSO_CODE` | código expirado (>60 s), já usado ou SPA recarregado | refazer o login (o SPA evita duplo POST) |
| `SSO_REQUIRED` no login por senha | `enforce_sso` ligado | usar o botão de SSO ou o break-glass de platform admin |

---

## 8. Limitações conhecidas / próximos passos

- **Um IdP por workspace** (por design). Múltiplos IdPs exigiriam uma tabela
  filha e uma regra de precedência.
- **Sem IdP-initiated SSO** (SAML/OIDC): o fluxo sempre começa em
  `/auth/sso/start` (proteção contra login CSRF).
- **Sem Single Logout (SLO)**: `POST /auth/logout` revoga refresh tokens locais,
  mas não encerra a sessão no Entra/Okta.
- **Sem SCIM/provisionamento reverso**: desativar no IdP não desativa no
  IntegrAI (o inverso é verdadeiro: conta local inativa bloqueia o SSO).
- **Group overage** do Entra (`_claim_names`/`_claim_sources` quando o token
  passa do limite de grupos): não é resolvido via Graph. Use *Groups assigned to
  the application* ou App Roles para manter o claim `groups` pequeno.
- **`refresh_token` do IdP** não é solicitado/armazenado: não há chamada a APIs
  do provedor em nome do usuário.
- **Enforcement por domínio**: `enforce_sso` vale para o workspace inteiro (não
  por domínio). Operadores fora de `allowed_domains` não conseguem entrar por
  SSO nem por senha enquanto o enforcement estiver ligado — planeje a allowlist
  antes de ativar.

---

## 9. Testes

`packages/server/src/application/__tests__/Sso.test.ts` (44 testes) e
`packages/server/src/http/__tests__/sso-routes.test.ts` (22 testes) cobrem, sem
rede real:

- CRUD/RBAC da configuração, segredo cifrado e nunca devolvido, rotação/omissão
  do secret, normalização de domínios, rejeição de http/enforce sem domínio;
- `discover` por e-mail/domínio, 404 para conexão desabilitada/suspensa;
- `start` com `state` assinado, `nonce`, PKCE S256 e verifier fora da URL;
- callback com ID token **real RS256** (par de chaves gerado no teste) e JWKS
  stubado: JIT, papel por grupo, atualização sem rebaixar ADMIN, nonce inválido,
  `aud` inválida, assinatura de outra chave, `alg: none`, expirado, domínio
  bloqueado, `email_verified=false`, replay de state, state forjado/expirado,
  conflito de workspace, conta desativada, provisionamento desligado;
- `exchange` de uso único (60 s), replay e código desconhecido;
- `enforce_sso` → `403 SSO_REQUIRED` após senha válida, `401` para senha errada,
  isenção de platform admin;
- HTTP: allowlist exata, RBAC ADMIN, envelope sem segredo, `422` para
  `tenantId` no corpo, `302` de start/callback, redirect de erro pós-state e
  `400` para state inválido.

---

## 10. Isenção da política `require_2fa`

A política de 2FA por workspace (`tenants.require_2fa`, exposta como `require2fa`
em `GET/PATCH /tenants/me`) bloqueia apenas o login **por senha** de operadores
sem TOTP ativo. O fluxo SSO é **isento**: o segundo fator é delegado ao IdP
(Microsoft Entra ID, Google, Okta ou OIDC genérico) e o `SsoAuthService` prova a
identidade no provedor e chama `AgentService.issueSession` diretamente, nunca
`AgentService.login`.

Consequência operacional: um workspace pode exigir 2FA para senha e, ao mesmo
tempo, manter SSO para os membros que entram pelo IdP — não há dupla exigência
nem bloqueio do callback. Se o IdP não oferece MFA, a garantia de segundo fator
é do IdP, não do IntegrAI; nesse caso o ADMIN deve manter `require_2fa` ligado
apenas se todos os membros também tiverem TOTP local ou se o IdP aplicar MFA.

## Diagnostico previo (sso:doctor)

Antes de salvar a conexao, rode:

`ash
node scripts/sso-doctor.mjs --issuer=https://login.microsoftonline.com/<tid>/v2.0 \\
  --client-id=<app-id> --secret=<...> --redirect-uri=<api>/api/v1/auth/sso/callback --domains=suaempresa.com
` 

Ele valida discovery, issuer canonico, endpoints, PKCE S256, RS256, JWKS e o formato do redirect/issuer do Entra, e imprime o proximo passo. Tambem funciona contra o provedor local (scripts/oidc-stub.mjs).

## Provisionar o App registration (device code, opcional)

Se voce prefere nao criar o app no portal Azure, rode:

`ash
node scripts/entra-provision.mjs --redirect=<api>/api/v1/auth/sso/callback
` 

Um codigo de dispositivo e exibido; autentique com um usuario que possa criar aplicacoes no tenant (15 min). O script cria o application, o service principal e um client secret, e grava .entra-app.json (gitignored) com issuer/client id/secret/redirect. Depois use esses valores em /settings e clique em **Testar conexao**. Nenhuma senha passa pelo script.
