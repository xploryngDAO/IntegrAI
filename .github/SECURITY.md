# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Use GitHub Security Advisories: https://github.com/xploryngDAO/IntegrAI/security/advisories/new
- Include: affected version/commit, reproduction steps, impact, and any suggested fix.
- We acknowledge within **3 business days** and aim to ship a fix or mitigation within **30 days**
  (critical issues are handled faster).

## Scope

In scope: authentication/SSO, session and token handling, multi-tenant isolation, file uploads,
webhooks, admin endpoints, secrets handling, dependency vulnerabilities in production.

Out of scope: findings that require a compromised admin account, social engineering, or
denial-of-service on third-party infrastructure.

## Safe harbor

Good-faith research that respects this policy, avoids data exfiltration, and does not degrade
service is considered authorized. Do not access, modify, or retain third-party data.

## Reference

The full threat model, implemented controls, LGPD checklist, and incident response runbook are
in [docs/SECURITY.md](../docs/SECURITY.md). Operational steps are in
[docs/RUNBOOK.md](../docs/RUNBOOK.md). A machine-readable policy is served at
`/.well-known/security.txt`.
