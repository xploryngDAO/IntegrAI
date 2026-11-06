# Changelog

All notable changes to IntegrAI. Dates in `YYYY-MM-DD`; versions follow SemVer.

## [Unreleased]

### Added

- **SSO**: `POST /tenants/me/sso/test` + botão “Testar conexão” em `/settings` (10 checks: discovery,
  issuer, endpoints, PKCE S256, RS256, JWKS com `kid`, domínios) e `scripts/sso-doctor.mjs`.
- **Provisionamento do Entra**: `scripts/entra-provision.mjs` cria App registration/service principal/
  secret via device code (`npm run entra:provision`), sem senha no script.
- **Console**: operações de backup (S3), backups recentes, exclusão lógica com confirmação por slug e
  purga explícita; backend `DELETE /platform/tenants/:id` (soft delete sem senha do workspace).
- **Deploy resiliente**: `runtime-config.json` público resolve API/WS no boot (troca de túnel sem
  redeploy), `npm run tunnel:sync` e `npm run deploy:vercel`; `HOST`/`TRUST_PROXY` configuráveis.
- **Ops**: modo de manutenção (`MAINTENANCE_MODE`) com 503, banner com contagem regressiva no SPA,
  perfil de observabilidade (Prometheus + Grafana provisionado), backup/restore do Postgres e
  baseline de performance em `docs/PERFORMANCE.md`.

### Changed

- **Imagens Docker**: runtime da API sem `npm`/`npx` (migrações via Prisma CLI direto) e web em
  `nginx:stable-alpine`; `trivy` 0 HIGH/CRITICAL, varredura obrigatória no CI.
- **CI**: actionlint nos workflows, gitleaks, auditoria WCAG AA em 8 telas, build + scan das imagens.
- **A11y/UX**: login com âncora de produto, jargão de endpoints removido de todas as telas.
- **Banco**: drill de backup/restore por workspace validado (backup → restore → soft delete → purge).

## [0.1.0] — 2026-11-06

### Added

- **Omnichannel**: Amazon SP-API/SES, Mercado Livre and Shopee Open Platform v2 adapters, unified
  SLA queue, 3-column workspace, real-time Socket.IO, BullMQ workers with backoff/DLQ.
- **Auth**: password + JWT/refresh rotation, 2FA (TOTP + recovery codes), password reset, email
  verification, invitations with resend, per-tenant SSO (Microsoft Entra/Google/Okta OIDC with
  PKCE/nonce/one-time code), `require2fa` policy with enrollment-on-login, admin 2FA reset,
  session revocation and “logout everywhere”, new-device and account-change email alerts.
- **Admin**: overview metrics, users (search/filter/pagination/CSV), invitations (list/revoke/resend),
  active sessions (revoke), audit logs with filters/CSV export (audited).
- **Security/LGPD**: AES-256-GCM secrets, RBAC, multi-tenant isolation tests, rate limits, CSP/HSTS/
  COOP/CORS hardening, upload allowlist, tenant export/deletion/purge, backup/restore with retention,
  audit trail, `security.txt`, security probe and gitleaks in CI.
- **Ops**: request-id correlation, `/health/ready`, Prometheus `/metrics`, Prisma 7 + pg adapter,
  Docker images (API + web/nginx same-origin), compose stack with optional Caddy TLS, DB backup/
  restore drill, runbooks, ADRs.
- **Quality**: 1019 automated tests, CI (build/test/security/a11y/images), WCAG 2.1 AA automated audit.

### Security

- `npm audit --omit=dev`: 0 vulnerabilities.
- gitleaks: no leaks in 127 commits (baseline reviewed).

### Known limitations

- SSO real tenant (Microsoft Entra App registration) and definitive API hosting pending external
  credentials; Vercel free deployment quota exhausted during the pilot.
