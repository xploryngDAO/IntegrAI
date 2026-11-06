## Summary

<!-- What changed and why. Link the issue/ADR when applicable. -->

## Checklist

- [ ] `npm run prisma:generate` (client Prisma 7) before typecheck/build
- [ ] `npm run build:shared` + `tsc` server/web
- [ ] `npx vitest run` (1019+ tests, no skips)
- [ ] `npm run build:server` + `npm run build --workspace @sac/web`
- [ ] Security: no new secret in code; `npm audit --omit=dev` unchanged/zero high
- [ ] Live probes when touching auth/admin/infra: `validate:live`, `isolation-test`, `security:probe`
- [ ] A11y when touching UI: `node scripts/a11y-audit.mjs` (0 violations)
- [ ] Docs updated (`docs/`, ADR for architectural decisions)

## Risk / rollback

<!-- Data migrations? Rollback steps? Feature flags? -->
