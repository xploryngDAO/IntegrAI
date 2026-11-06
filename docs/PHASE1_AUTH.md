# Fase 1 — Contas self-service (design)

> Pré-requisito: Fase 0 (multi-tenant). Todo usuário pertence a um `tenant`.
> Objetivo: cliente cria a própria conta, verifica e-mail, entra, convida a equipe
> e recupera a senha sem suporte.

## Modelo de dados (novas tabelas)

```
tenants            (já existe)  id, slug, name, status, created_at, updated_at
users              substitui agents → id, tenant_id, email(unique global), name,
                   password_hash, role, email_verified_at, is_active, created_at
invitations        id, tenant_id, email, role, token_hash, invited_by, expires_at, accepted_at
password_resets    id, user_id, token_hash, expires_at, used_at
email_verifications id, user_id, token_hash, expires_at, used_at
sessions           id, user_id, refresh_token_hash, user_agent, ip, expires_at, revoked_at,
                   last_used_at
audit_events       id, tenant_id, actor_id, actor_email, action, resource_type, resource_id,
                   ip, user_agent, metadata, created_at
```

Decisões:
- **E-mail único global** (login sem seletor de tenant); o tenant vem do usuário.
- Tokens de convite/reset/verificação: aleatórios (32 bytes), guardados como SHA-256,
  uso único, TTL 30 min (reset) / 7 dias (convite).
- Sessão: access JWT curto (15 min) + refresh token rotativo em `sessions`.
- Senha: bcrypt cost 12; política mínima 12 caracteres + bloqueio progressivo.
- 2FA TOTP opcional para ADMIN/SUPERVISOR (secret cifrado, códigos de recuperação).

## Endpoints

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| POST | `/auth/signup` | pública | cria tenant + ADMIN (nome da empresa, e-mail, senha) e envia verificação |
| POST | `/auth/verify-email` | pública | consome token e marca `email_verified_at` |
| POST | `/auth/resend-verification` | pública | reenvia verificação (rate limited) |
| POST | `/auth/login` | pública | exige e-mail verificado (ou retorna 403 `EMAIL_NOT_VERIFIED`) |
| POST | `/auth/refresh` | pública | rotaciona refresh token |
| POST | `/auth/logout` | JWT | revoga sessão atual (ou todas, sem `refreshToken`) |
| GET | `/auth/me` | JWT | identidade + carga do operador |
| PATCH | `/auth/me` | JWT | altera o nome; audita `auth.profile.updated` |
| GET | `/auth/sessions` | JWT | sessões do próprio operador (`current` via claim `sid`) |
| DELETE | `/auth/sessions/:id` | JWT | revoga uma sessão própria; a atual encerra o login |
| POST | `/auth/sessions/revoke-others` | JWT | revoga todas as sessões exceto a atual |
| POST | `/auth/forgot-password` | pública | envia link (sempre 202, sem enumeração) |
| POST | `/auth/reset-password` | pública | consome token, troca senha, revoga sessões |
| POST | `/invitations` | ADMIN | convida operador (papel); reenvio regenera o token |
| GET | `/invitations` | ADMIN | lista convites do tenant (pending/accepted/expired) |
| DELETE | `/invitations/:id` | ADMIN | revoga convite pendente |
| POST | `/auth/accept-invitation` | pública | consome o token, define a senha, cria usuário e abre sessão |
| GET | `/users` | ADMIN | lista equipe do tenant |
| PATCH | `/users/:id` | ADMIN | papel/ativo |
| GET | `/admin/users` | ADMIN | equipe do tenant com `sessionsCount`/`lastLoginAt` |
| PATCH | `/admin/users/:id` | ADMIN | papel/ativo; 409 para self e para o último ADMIN ativo; 404 cross-tenant |
| POST | `/admin/users/:id/revoke-sessions` | ADMIN | revoga refresh sessions + watermark de JWT; 409 para self |
| GET | `/admin/audit-logs` | ADMIN | trilha paginada/filtrada (tenant do JWT, `perPage` ≤ 100) |
| POST | `/auth/2fa/setup` \| `/auth/2fa/verify` \| `/auth/2fa/disable` | JWT | TOTP |
| POST | `/auth/2fa/recovery-codes/regenerate` | JWT | senha + TOTP/recovery code; substitui em transação e devolve 8 códigos uma única vez |
| GET | `/auth/2fa/recovery-codes/count` | JWT | `{ remaining }` (códigos ainda não usados) |
| GET | `/auth/2fa/status` | JWT | `{ enabled }` |
| POST | `/auth/2fa/challenge` | pública | troca o `challengeToken` (login) + código por `AuthResponse` |

## Fluxos

1. **Signup**: valida e-mail/senha → cria `tenants(slug gerado)` + `users(ADMIN)` →
   envia verificação → resposta 201 (sem token até verificar).
2. **Verificação**: token → `email_verified_at` → login liberado.
3. **Convite**: ADMIN informa e-mail/papel → e-mail com link → aceite cria usuário no
   mesmo tenant com papel definido (sem acesso a outros tenants).
4. **Reset**: sempre 202; token por e-mail; ao usar, revoga todas as sessões.
5. **2FA**: setup gera secret + QR; verificação confirma; login passa a exigir código.

## E-mail transacional

- Provider: SES (já previsto para Amazon) ou SMTP (`SMTP_*` já configurado).
- Templates: verificação, convite, reset, alerta de novo dispositivo.
- Fila BullMQ `email` com retry/backoff e DLQ; nada de envio síncrono no request.

## Segurança / LGPD

- Rate limit por IP + e-mail em signup/login/reset; lockout progressivo.
- **Rate limit implementado (Redis + fallback em memória)**, via
  `application/auth/rate-limit.ts` (janela fixa: `INCR` + TTL atômico no Redis,
  chave por e-mail/IP; se o Redis falhar, uma janela in-process equivalente
  assume e o evento é logado como degradado):

  | Endpoint | Limite | Chave | Resposta |
  |---|---|---|---|
  | `POST /auth/login` | 10 tentativas / 15 min | e-mail + IP | `429 RATE_LIMITED` |
  | `POST /auth/2fa/challenge` | 5 tentativas / 15 min | `jti` do challenge **e** IP | `429 RATE_LIMITED` |
  | `POST /auth/2fa/recovery-codes/regenerate` | 5 tentativas / 15 min | usuário (JWT) | `429 RATE_LIMITED` |
  | `POST /auth/forgot-password` | 3 / 15 min | e-mail | `429 RATE_LIMITED` |
  | `POST /auth/resend-verification` | 3 / 15 min | e-mail | `429 RATE_LIMITED` |

  A tentativa é contada **antes** do lookup da conta e da verificação de
  credencial: o `429` depende apenas do e-mail/IP, então não há enumeração (conta
  existente e inexistente respondem igual). No 2FA, ao esgotar a janela o
  challenge é queimado — nem o código correto o resgata depois.
- Sem enumeração de contas (mensagens idênticas, tempos constantes).
- Tokens de uso único, hash em repouso, TTL curto.
- Auditoria de login, troca de senha, convite e 2FA.
- **Trilha `audit_events`** (append-only): `AuditService.record` é *best effort*
  (nunca lança, grava em background) e `AuditService.list` é paginado/filtrado
  por tenant. Ações emitidas: `auth.login.success|failure`, `auth.logout`,
  `auth.password.reset_completed`, `auth.2fa.enabled|disabled`,
  `auth.profile.updated`, `invitation.created|accepted`,
  `admin.user.role_changed|activated|deactivated|sessions_revoked`,
  `tenant.sso.updated|deleted` e `billing.webhook.processed`.
  `metadata` é higienizado antes do insert (chaves de senha/token/segredo e
  códigos descartadas; e-mail/telefone redigidos). O e-mail do ator fica apenas
  na coluna dedicada `actor_email`; nada de senha, token ou corpo de mensagem.
- Exportação/eliminação de dados do tenant (Fase 4).

## Migração

1. Renomear `agents` → `users` (ou manter tabela e adicionar colunas).
2. Backfill `email_verified_at = now()` para usuários existentes (bootstrap).
3. Criar tabelas novas + índices.
4. `ADMIN_EMAIL/ADMIN_PASSWORD` passam a criar tenant+usuário verificado **apenas**
   em bootstrap de desenvolvimento; em produção o fluxo é signup.
5. `20251116000000_audit_events`: cria `audit_events` (FK `tenant_id` →
   `tenants.id` `ON DELETE SET NULL`, índices por tenant/data, action e actor) e
   adiciona `sessions.last_used_at` (marcador de rotação exibido em
   `/auth/sessions`).
