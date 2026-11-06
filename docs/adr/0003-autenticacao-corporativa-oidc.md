# ADR-0003 — Autenticação corporativa OIDC (Entra ID, Google, Okta)

## Status

Aceito

## Data

2026-11-06

## Contexto

Clientes enterprise exigem login corporativo e não aceitam depender apenas de
senha local. O produto já tinha senha com bcrypt, JWT, refresh rotativo, 2FA TOTP
e RBAC por workspace. O SSO precisava:

- funcionar com Microsoft Entra ID, Google Workspace, Okta e provedores OIDC
  genéricos sem manter quatro fluxos;
- não devolver token na URL do callback (histórico, logs, Referer);
- ligar o usuário do IdP a um operador do workspace certo, sem permitir que um
  e-mail sequestre outro tenant;
- permitir bloquear senha quando a organização exigir SSO, mantendo um caminho
  de recuperação se a configuração quebrar.

## Decisão

1. **Um fluxo OIDC genérico, presets de onboarding.** `MICROSOFT`, `GOOGLE`,
   `OKTA` e `OIDC` são apenas presets (`SsoProvider`); todos usam
   authorization-code com **PKCE S256 obrigatório**, `nonce` e `state` assinado
   de uso único. O issuer é normalizado (https, sem barra final) e a discovery
   (`<issuer>/.well-known/openid-configuration`) precisa devolver exatamente o
   issuer configurado. Requisitos: RS256 com `kid` no JWKS, PKCE S256 e `nonce`.
2. **Uma conexão por workspace.** `tenant_sso_connections.tenant_id` é UNIQUE
   (`ON DELETE CASCADE`), o que torna `discover?email=`/`?domain=` inequívoco.
   `allowedDomains` é obrigatório para autenticar; lista vazia = ninguém entra
   (deny-by-default). O `PUT /tenants/me/sso` recusa `enforceSso=true` com lista
   vazia.
3. **`state`, `nonce` e PKCE no servidor.** `state` = aleatório + HMAC-SHA256
   (chave derivada do `JWT_SECRET` com separação de domínio), registro no Redis
   com TTL de 10 min e consumo single-use; `nonce` de 32 bytes conferido em tempo
   constante; verifier PKCE de 32 bytes só no servidor (Redis, junto do state).
   `state` inválido/forjado/expirado/repetido → `400 SSO_STATE_INVALID`, sem
   redirect.
4. **Callback não devolve token.** O callback valida o ID token (RS256, JWKS com
   cache e um refetch em rotação de `kid`, `iss`, `aud`/`azp`, `exp`, `nbf`,
   `iat`, `nonce`, skew de 60 s), resolve e-mail (`email` → `preferred_username`
   → `upn`, exigindo `email_verified === true` quando o claim existe), confere o
   domínio, faz JIT provisioning e responde
   `302 <WEB_ORIGIN>/auth/sso/callback?code=<código opaco>`. Esse código é
   SHA-256 no Redis, TTL de **60 s** e guarda apenas `{ agentId, tenantId }`.
   O SPA troca por `POST /api/v1/auth/sso/exchange`, que chama
   `AgentService.issueSession` (mesmo JWT/refresh/presença do login por senha).
5. **JIT e grupos.** `groupRoleMap` mapeia grupos/App Roles para `AgentRole`
   (`ADMIN > SUPERVISOR > AGENT`; o maior privilégio vence). Sem casamento, o
   papel novo é `defaultRole`; num operador existente o papel atual é
   preservado. Conta de outro workspace → `409 SSO_ACCOUNT_CONFLICT` (nunca
   re-parente); conta desativada → `403 SSO_ACCOUNT_DISABLED` (SSO não reativa
   suspensão local). Operador JIT recebe `password_hash` aleatório (login por
   senha impossível), `email_verified_at = now()` e `is_active = true`.
6. **`enforceSso` com break-glass.** Com `enforce_sso=true` e `enabled=true`, o
   login por senha responde `403 SSO_REQUIRED`. A checagem ocorre **depois** de
   validar senha, `is_active`, `email_verified_at` e workspace `ACTIVE`, e
   **antes** do desafio de 2FA (quem tem 2FA não recebe um challenge impossível).
   A isenção é exclusiva de `agents.is_platform_admin = true`; ADMIN do tenant
   **não** é isento. Recuperação: platform admin corrige/desabilita a conexão, ou
   um ADMIN já autenticado faz `DELETE /tenants/me/sso`.
7. **2FA e reset.** A política `tenants.require_2fa` (exposta como `require2fa`)
   bloqueia apenas o login **por senha** de quem não tem TOTP ativo: resposta
   `403 TWO_FACTOR_SETUP_REQUIRED` com `setupToken` de 15 min, uso único
   (`jti` queimado no Redis); `POST /auth/2fa/enroll/setup` + `/verify` habilitam
   o fator, devolvem 8 recovery codes e só então emitem a sessão. **SSO é
   isento**: o segundo fator é delegado ao IdP. Reset de fator perdido é feito
   por `POST /admin/users/:id/reset-2fa` (409 `CANNOT_RESET_OWN_2FA` /
   `TWO_FACTOR_NOT_ENABLED`); reset de senha revoga sessões e grava o watermark
   de revogação de access tokens.
8. **Proteções operacionais.** Rate limit por IP: `discover` 30/15 min;
   `start`, `callback` e `exchange` 20/15 min. Redirects de sucesso e de erro
   pós-state usam sempre a primeira `WEB_ORIGIN` (nunca destino da requisição).
   Segredo do client cifrado com AES-256-GCM e write-only; a API expõe apenas
   `clientSecretConfigured`.

## Alternativas consideradas

- **SAML 2.0.** Cobertura forte em enterprise, mas exigiria mais um stack de
  protocolo, metadata XML e assinaturas; OIDC cobre Entra/Google/Okta com um só
  fluxo. Rejeitado.
- **IdP hospedado (Auth0/WorkOS/Clerk).** Reduziria código, mas adicionaria
  custo por usuário, dependência externa no caminho de login e um novo
  processador de dados pessoais. Rejeitado para manter o SSO dentro do produto.
- **Token no fragmento da URL do SPA.** Menos uma chamada, mas expõe o token a
  histórico/extensões e contraria a regra de nunca devolver token na URL.
  Rejeitado.
- **Múltiplos IdPs por workspace.** Exigiria tabela filha e precedência de
  descoberta; um IdP por workspace foi considerado suficiente. Adiado.
- **Isentar o ADMIN do tenant no `enforceSso`.** Evitaria lockout, mas esvaziaria
  o controle (o papel mais poderoso manteria senha para sempre). Rejeitado em
  favor do break-glass de platform admin.

## Consequências

**Positivas**

- Um único fluxo testado cobre Entra ID, Google, Okta e OIDC genérico; o
  onboarding muda só por preset.
- Nenhum token ou secret trafega na URL; o callback entrega apenas um código
  opaco de 60 s e o exchange emite a sessão normal, sem token em histórico,
  Referer ou log.
- `enforceSso` é aplicável por workspace com caminho de recuperação explícito e
  documentado; a política de 2FA não entra em conflito com SSO.
- JIT com grupo→papel reduz trabalho de onboarding, e as travas de
  conflito/desativação evitam sequestro de conta e reativação indevida.

**Negativas**

- **Um IdP por workspace** (por design). Múltiplos provedores exigiriam nova
  modelagem.
- Sem IdP-initiated SSO, sem Single Logout (SLO) e sem SCIM: desativar no IdP
  não desativa no IntegrAI, e o logout local não encerra a sessão no Entra/Okta.
- Group overage do Entra (`_claim_names`) não é resolvido via Graph; é preciso
  usar *Groups assigned to the application* ou App Roles.
- `enforceSso` vale para o workspace inteiro, não por domínio; uma allowlist mal
  planejada tranca usuários fora.
- A rotação do client secret é manual e a expiração no Entra precisa ser
  monitorada; o ADMIN do tenant depende do platform admin se configurar o SSO
  errado.
- O access JWT existente continua válido até expirar após uma revogação local.

## Referências

- [`docs/ENTERPRISE_SSO.md`](../ENTERPRISE_SSO.md) — fluxo, endpoints, controles,
  operação e limitações.
- [`docs/SECURITY.md`](../SECURITY.md) §12 (requisitos OAuth/OIDC) e §3.9.
- [`docs/PHASE1_AUTH.md`](../PHASE1_AUTH.md) — política `require_2fa`, enroll e
  sessões.
- [`prisma/schema.prisma`](../../prisma/schema.prisma) — `TenantSsoConnection`.
- [`packages/server/src/application/SsoAuthService.ts`](../../packages/server/src/application/SsoAuthService.ts),
  [`OidcClient.ts`](../../packages/server/src/application/sso/OidcClient.ts) e
  [`pkce.ts`](../../packages/server/src/application/sso/pkce.ts).
- [`packages/server/src/http/controllers/sso.controller.ts`](../../packages/server/src/http/controllers/sso.controller.ts)
  e [`packages/server/src/application/__tests__/Sso.test.ts`](../../packages/server/src/application/__tests__/Sso.test.ts).
