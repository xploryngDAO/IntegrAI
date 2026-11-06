# Contributing

## Setup

```bash
npm ci
npm run prisma:generate        # Prisma 7 client (generated, gitignored)
cp .env.example .env           # fill DATABASE_URL/REDIS_URL/S3_*/SMTP_*/JWT_SECRET
npm run dev                    # API + web
npm run db:seed                # tenant + ADMIN (ADMIN_EMAIL/ADMIN_PASSWORD)
```

## Required checks before a PR

```bash
npm run build:shared
npx tsc -p packages/server/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npx vitest run
npm run build:server
npm run build --workspace @sac/web
```

Security and UI changes:
- `npm run security:probe` and `node scripts/isolation-test.mjs` against a running API
- `node scripts/a11y-audit.mjs` (WCAG AA, 0 violations) for UI
- `npm run validate:live` for marketplace/account flows

CI runs build/tests, security probes (isolation + OWASP-style checks), gitleaks and the
accessibility audit — a red pipeline blocks the merge.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`).
- Architecture decisions go in `docs/adr/` (one decision per ADR, status + date).
- No secrets in code, fixtures, logs or screenshots; use dummy values in tests.
- Keep tenant scope explicit: every query/mutation uses the JWT tenant.
- Update the relevant doc (`SECURITY.md`, `RUNBOOK.md`, `PRODUCT_STATUS.md`, `GO_LIVE.md`).

## Reporting

Security issues: GitHub Security Advisories (see `.github/SECURITY.md`).
