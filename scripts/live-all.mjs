/**
 * Orquestrador da bateria live contra a produção (ou um host candidato).
 *
 * Uso:
 *   node scripts/live-all.mjs [--api=<url>] [--web=<url>] [--only=validate,probe]
 *                             [--skip-ui] [--skip-a11y]
 *
 * Cada etapa roda o script real (sem mock); o resumo final informa o que passou.
 * Se aparecer 429 (rate limit de login dos testes), o resumo lembra de limpar
 * `sac:auth:login:attempts:*` no Redis e repetir.
 */
import { spawnSync } from 'node:child_process';

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=')];
  }),
);

const API = (args.get('api') ?? process.env.API_BASE_URL ?? 'https://growth-voters-independent-rca.trycloudflare.com').replace(/\/+$/, '');
const WEB = (args.get('web') ?? 'https://integrai-dev.vercel.app').replace(/\/+$/, '');
const EMAIL = args.get('email') ?? process.env.ADMIN_EMAIL ?? 'admin@integr-ai.local';
const PASSWORD = args.get('password') ?? process.env.ADMIN_PASSWORD ?? 'IntegrAI-Prod-2026!';
const ONLY = (args.get('only') ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const SKIP_UI = args.has('skip-ui');
const SKIP_A11Y = args.has('skip-a11y');
// The battery issues many logins for the same operator from one IP; the API's
// own lockout (correctly) answers 429 mid-run. In a local/dev setup we can clear
// the buckets between steps; against a remote Redis this flag is a no-op.
const RESET_LOGIN_LIMIT =
  args.has('reset-login-limit') || process.env.LIVE_ALL_RESET_LIMIT === '1';
const REDIS_CONTAINER = process.env.REDIS_CONTAINER ?? 'sac-redis';

function clearLoginAttempts() {
  if (!RESET_LOGIN_LIMIT) return;
  const run = spawnSync(
    'docker',
    [
      'exec',
      REDIS_CONTAINER,
      'sh',
      '-c',
      "redis-cli --scan --pattern 'sac:auth:*attempts*' | while read -r key; do [ -n \"$key\" ] && redis-cli DEL \"$key\" >/dev/null; done",
    ],
    { stdio: 'ignore' },
  );
  if (run.status !== 0) {
    console.log('[aviso] não foi possível limpar os buckets de rate limit (Redis remoto?)');
  }
}

const STEPS = [
  { key: 'verify', label: 'verify-live (SPA + sessão)', script: 'verify-live.mjs', args: [WEB, EMAIL, PASSWORD], ui: true },
  { key: 'validate', label: 'validate-live (11 cenários)', script: 'validate-live.mjs', args: [API, EMAIL, PASSWORD] },
  { key: 'isolation', label: 'isolation-test (multi-tenant)', script: 'isolation-test.mjs', args: [API, EMAIL, PASSWORD] },
  { key: 'probe', label: 'security-probe (18)', script: 'security-probe.mjs', args: [API, EMAIL, PASSWORD] },
  { key: '2fa-policy', label: '2FA policy (13)', script: 'live-2fa-policy-test.mjs', args: [API] },
  { key: 'socket', label: 'socket revoke (5)', script: 'live-socket-revoke-test.mjs', args: [API] },
  { key: '2fa', label: '2FA API (13)', script: 'live-2fa-test.mjs', args: [API] },
  { key: 'signup', label: 'signup + convite API (26)', script: 'live-signup-invite-test.mjs', args: [API] },
  { key: 'signup-ui', label: 'signup pela UI (10)', script: 'live-signup-ui-test.mjs', args: [WEB, API], ui: true },
  { key: 'invite-ui', label: 'convite pela UI (11)', script: 'live-invite-ui-test.mjs', args: [WEB, API], ui: true },
  { key: 'reset-ui', label: 'reset de senha pela UI (10)', script: 'live-reset-ui-test.mjs', args: [WEB, API], ui: true },
  { key: '2fa-ui', label: '2FA pela UI (9)', script: 'live-2fa-ui-test.mjs', args: [WEB, API], ui: true },
  { key: 'sso-ui', label: 'SSO pela UI (9)', script: 'live-sso-ui-test.mjs', args: [WEB, API], ui: true },
  { key: 'a11y', label: 'a11y 10 telas (light)', script: 'a11y-audit.mjs', args: [WEB, EMAIL, PASSWORD] },
];

const selected = STEPS.filter((step) => {
  if (ONLY.length > 0 && !ONLY.includes(step.key)) return false;
  if (SKIP_UI && step.ui) return false;
  if (SKIP_A11Y && step.key === 'a11y') return false;
  return true;
});

if (selected.length === 0) {
  console.error(`Nenhuma etapa selecionada. Chaves: ${STEPS.map((step) => step.key).join(', ')}`);
  process.exit(2);
}

const results = [];
const startedAt = Date.now();

for (const step of selected) {
  clearLoginAttempts();
  process.stdout.write(`\n=== ${step.label} ===\n`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [`scripts/${step.script}`, ...step.args], {
    stdio: 'inherit',
    env: process.env,
  });
  const ok = run.status === 0;
  results.push({ key: step.key, label: step.label, ok, ms: Date.now() - started });
  console.log(`--- ${ok ? 'OK' : 'FALHOU'} (${Math.round((Date.now() - started) / 1000)}s) ---`);
}

const failures = results.filter((result) => !result.ok);
console.log('\n================ RESUMO ================');
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}  (${Math.round(result.ms / 1000)}s)`);
}
console.log(`\n${results.length - failures.length}/${results.length} etapas OK em ${Math.round((Date.now() - startedAt) / 1000)}s.`);
if (failures.length > 0) {
  console.log('Se algum FAIL cita HTTP 429, limpe sac:auth:login:attempts:* no Redis (RUNBOOK) e repita a etapa.');
  process.exitCode = 1;
}
