/**
 * `npm run doctor`
 *
 * Live operational diagnostics for the SAC Hub backend. This CLI is deliberately
 * thin: every check is produced by the real services (`DiagnosticsService` ->
 * infrastructure probes + channel adapters), so the report reflects the same
 * code path used by `GET /diagnostics`.
 *
 * Usage:
 *   npm run doctor                 # infrastructure + every connected account
 *   npm run doctor -- --account=<uuid>
 *
 * Exit code: 0 when no check failed, 1 when any check failed (or on a fatal
 * configuration error). Reports are actionable; no stack traces are printed.
 */

import { MARKETPLACE_LABEL, redactPiiForLogs } from '@sac/shared';
import type {
  AccountDiagnosis,
  DiagnosisCheck,
  DiagnosisStatus,
  IRealtimePublisher,
  SystemDiagnosis,
} from '@sac/shared';

import { loadConfig, type AppConfig } from '../packages/server/src/config';
import {
  createInfrastructure,
  disposeInfrastructure,
  type InfrastructureBundle,
} from '../packages/server/src/infrastructure';
import { createContainer, disposeContainer } from '../packages/server/src/container';

/* ---------------------------------------------------------------------- */
/* Terminal presentation                                                  */
/* ---------------------------------------------------------------------- */

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
const paint = (code: string) => (text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const dim = paint('2');
const bold = paint('1');
const cyan = paint('36');

const STATUS_STYLE: Record<DiagnosisStatus, { symbol: string; paint: (text: string) => string }> = {
  ok: { symbol: '✓', paint: green },
  warn: { symbol: '!', paint: yellow },
  fail: { symbol: '✕', paint: red },
  skipped: { symbol: '–', paint: dim },
};

function statusSymbol(status: DiagnosisStatus): string {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.warn;
  return style.paint(style.symbol);
}

function statusLabel(status: DiagnosisStatus): string {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.warn;
  return style.paint(status.toUpperCase());
}

function padRight(value: string, length: number): string {
  if (value.length >= length) return value;
  return value + ' '.repeat(length - value.length);
}

function formatLatency(latencyMs: number | undefined): string {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) return dim('   —   ');
  return dim(`${String(Math.max(0, Math.round(latencyMs))).padStart(5)}ms`);
}

function printCheck(check: DiagnosisCheck, indent: string): void {
  const label = padRight(check.label, 34);
  console.log(`${indent}${statusSymbol(check.status)} ${label} ${formatLatency(check.latencyMs)}  ${check.detail}`);
  if (check.status !== 'ok' && check.remediation) {
    console.log(`${indent}  ${dim(`↳ ${check.remediation}`)}`);
  }
}

function printSection(title: string): void {
  console.log(`\n${bold(title)}`);
  console.log(dim('─'.repeat(Math.max(20, title.length + 6))));
}

function printAccount(account: AccountDiagnosis): void {
  console.log(
    `\n${cyan(bold(MARKETPLACE_LABEL[account.marketplace] ?? account.marketplace))} — ${account.displayName} ${dim(`(${account.accountId})`)}  →  ${statusLabel(account.overall)}`,
  );
  for (const check of account.checks) printCheck(check, '  ');
}

function countStatuses(checks: DiagnosisCheck[]): Record<DiagnosisStatus, number> {
  const counts: Record<DiagnosisStatus, number> = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

/* ---------------------------------------------------------------------- */
/* Main                                                                   */
/* ---------------------------------------------------------------------- */

function noopRealtimePublisher(): IRealtimePublisher {
  return {
    ticketUpdated: () => undefined,
    messageCreated: () => undefined,
    queueChanged: () => undefined,
    channelHealth: () => undefined,
    agentPresence: () => undefined,
  };
}

function parseAccountArg(argv: string[]): string | null {
  for (const argument of argv) {
    if (argument.startsWith('--account=')) {
      const value = argument.slice('--account='.length).trim();
      if (value !== '') return value;
      throw new Error('--account requires a UUID, e.g. --account=3f1c...');
    }
    if (argument === '--account') {
      throw new Error('--account requires a value, e.g. --account=<uuid>');
    }
    if (argument === '--help' || argument === '-h') {
      console.log('Uso: npm run doctor [-- --account=<uuid>]');
      process.exit(0);
    }
  }
  return null;
}

async function main(): Promise<number> {
  const accountId = parseAccountArg(process.argv.slice(2));
  const config: AppConfig = loadConfig();

  // Keep stdout machine-readable: infrastructure logs are noisy in development.
  // Operators can opt into them with DOCTOR_VERBOSE=1.
  if (process.env.DOCTOR_VERBOSE !== '1') {
    config.logLevel = 'silent';
  }

  let infra: InfrastructureBundle | null = null;
  try {
    infra = createInfrastructure(config);
    const services = createContainer({
      config,
      infra,
      realtime: noopRealtimePublisher(),
    });

    console.log(bold('\nSAC Hub — doctor (diagnóstico ao vivo)'));
    console.log(dim('━'.repeat(64)));
    console.log(`${dim('ambiente  :')} ${config.nodeEnv}`);
    console.log(`${dim('API base  :')} ${config.appBaseUrl}`);
    console.log(`${dim('executado :')} ${new Date().toISOString()}`);

    if (accountId) {
      const diagnosis = await services.diagnostics.account(accountId);
      console.log(`${dim('versão    :')} ${diagnosis.displayName}`);
      printSection('CANAL');
      printAccount(diagnosis);
      printSummary([...diagnosis.checks], diagnosis.overall);
      return diagnosis.overall === 'fail' ? 1 : 0;
    }

    const diagnosis: SystemDiagnosis = await services.diagnostics.system();
    console.log(`${dim('versão    :')} ${diagnosis.version}`);
    console.log(`${dim('testado em:')} ${diagnosis.testedAt}`);

    printSection('INFRAESTRUTURA');
    for (const check of diagnosis.infrastructure) printCheck(check, '  ');

    printSection('CANAIS');
    if (diagnosis.channels.length === 0) {
      console.log(`  ${yellow('!')} Nenhuma conta conectada. Abra a tela Contas e conecte uma loja.`);
    } else {
      for (const channel of diagnosis.channels) printAccount(channel);
    }

    const allChecks = [
      ...diagnosis.infrastructure,
      ...diagnosis.channels.flatMap((channel) => channel.checks),
    ];
    printSummary(allChecks, diagnosis.overall);
    return diagnosis.overall === 'fail' ? 1 : 0;
  } finally {
    await disposeContainer().catch(() => undefined);
    if (infra) await disposeInfrastructure(infra).catch(() => undefined);
  }
}

function printSummary(checks: DiagnosisCheck[], overall: DiagnosisStatus): void {
  const counts = countStatuses(checks);
  printSection('RESUMO');
  console.log(
    `  ${green(`${counts.ok} ok`)}  ${yellow(`${counts.warn} warn`)}  ${red(`${counts.fail} fail`)}  ${dim(`${counts.skipped} skipped`)}   →  ${statusLabel(overall)}`,
  );
  const failures = checks.filter((check) => check.status === 'fail');
  if (failures.length > 0) {
    console.log(`\n  ${red('Ações necessárias:')}`);
    for (const failure of failures) {
      console.log(`   ${red('•')} ${failure.label}: ${failure.remediation ?? failure.detail}`);
    }
  }
  console.log('');
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = redactPiiForLogs(error instanceof Error ? error.message : String(error));
    console.error(`\n${red('✕ doctor falhou:')} ${message}`);
    if (error instanceof Error && error.name === 'ConfigError') {
      console.error(dim('  Revise o arquivo .env (copie de .env.example) e tente novamente.'));
    }
    process.exitCode = 1;
  });
