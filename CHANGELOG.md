# Changelog

All notable changes to IntegrAI. Dates in `YYYY-MM-DD`; versions follow SemVer.

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
