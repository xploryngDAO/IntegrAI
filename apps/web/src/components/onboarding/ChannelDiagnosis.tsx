import { useMemo } from 'react';
import type { AccountDiagnosis, DiagnosisCheck, DiagnosisStatus } from '@sac/shared';
import { Icon } from '@xploryng/convergencia';
import { useWorkspace } from '../../lib/store';
import type { AccountRow } from '../../lib/types';
import { formatDateTime } from '../../lib/labels';
import { Alert, Button, Card, MarketplaceBadge, Pill, type PillTone } from '../ui';

/**
 * Status vocabulary kept aligned with `DiagnosticsDialog` — the onboarding step
 * is a summary, not a second diagnostics screen.
 */
const STATUS_LABEL: Record<DiagnosisStatus, string> = {
  ok: 'OK',
  warn: 'Atenção',
  fail: 'Falha',
  skipped: 'Não verificado',
};

const STATUS_TONE: Record<DiagnosisStatus, PillTone> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'danger',
  skipped: 'neutral',
};

const STATUS_ORDER: readonly DiagnosisStatus[] = ['ok', 'warn', 'fail', 'skipped'];

function emptyCounts(): Record<DiagnosisStatus, number> {
  return { ok: 0, warn: 0, fail: 0, skipped: 0 };
}

function countChecks(checks: DiagnosisCheck[]): Record<DiagnosisStatus, number> {
  const counts = emptyCounts();
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

/** Actionable text only: `ok`/`skipped` checks have nothing to fix. */
function remediationLines(checks: DiagnosisCheck[]): string[] {
  const lines = checks
    .filter((check) => check.status === 'fail' || check.status === 'warn')
    .map((check) => (check.remediation ?? '').trim())
    .filter((line) => line.length > 0);
  return [...new Set(lines)];
}

function Remediation({ text }: { text: string }): JSX.Element {
  return (
    <li
      className="flex items-start gap-1.5 text-[var(--cv-font-micro)] leading-snug"
      style={{ color: 'var(--cv-color-warning)' }}
    >
      <Icon name="tool" size={12} style={{ marginTop: 1, flex: 'none' }} />
      <span>{text}</span>
    </li>
  );
}

interface DiagnosisRow {
  accountId: string;
  marketplace: AccountRow['marketplace'];
  displayName: string;
  diagnosis: AccountDiagnosis | null;
}

export interface ChannelDiagnosisProps {
  /** Store `accounts` (already hydrated by the page through `GET /accounts`). */
  accounts: AccountRow[];
}

/**
 * Step 3 — real channel diagnosis.
 *
 * `store.systemDiagnostics()` runs `GET /diagnostics` (infrastructure + every
 * account) and `store.diagnoseAccount()` re-tests a single channel. Results are
 * summarised per account with the checks counted by `ok/warn/fail/skipped` and
 * the remediations the API returned. Nothing is sent to a buyer.
 */
export function ChannelDiagnosis({ accounts }: ChannelDiagnosisProps): JSX.Element {
  const systemDiagnosis = useWorkspace((state) => state.systemDiagnosis);
  const accountDiagnoses = useWorkspace((state) => state.accountDiagnoses);
  const diagnosticsLoading = useWorkspace((state) => state.diagnosticsLoading);
  const diagnosticsError = useWorkspace((state) => state.diagnosticsError);
  const diagnosingAccountId = useWorkspace((state) => state.diagnosingAccountId);
  const systemDiagnostics = useWorkspace((state) => state.systemDiagnostics);
  const diagnoseAccount = useWorkspace((state) => state.diagnoseAccount);

  const channels = useMemo<AccountDiagnosis[]>(() => {
    const merged = new Map<string, AccountDiagnosis>();
    for (const channel of systemDiagnosis?.channels ?? []) merged.set(channel.accountId, channel);
    // A per-account re-test is newer than the last system run.
    for (const diagnosis of Object.values(accountDiagnoses)) {
      merged.set(diagnosis.accountId, diagnosis);
    }
    return [...merged.values()];
  }, [accountDiagnoses, systemDiagnosis]);

  const rows = useMemo<DiagnosisRow[]>(() => {
    if (accounts.length > 0) {
      const byAccount = new Map(channels.map((channel) => [channel.accountId, channel]));
      return accounts.map((account) => ({
        accountId: account.id,
        marketplace: account.marketplace,
        displayName: account.displayName,
        diagnosis: byAccount.get(account.id) ?? null,
      }));
    }
    // `GET /accounts` may be unavailable while `/diagnostics` still answers.
    return channels.map((channel) => ({
      accountId: channel.accountId,
      marketplace: channel.marketplace,
      displayName: channel.displayName,
      diagnosis: channel,
    }));
  }, [accounts, channels]);

  const infrastructureCounts = useMemo(
    () => countChecks(systemDiagnosis?.infrastructure ?? []),
    [systemDiagnosis],
  );
  const infrastructureRemediations = useMemo(
    () => remediationLines(systemDiagnosis?.infrastructure ?? []).slice(0, 2),
    [systemDiagnosis],
  );

  function runDiagnosis(): void {
    // The store owns loading/error and emits its own danger toast; the step
    // renders `diagnosticsError` inline, so the rejection is just swallowed.
    void systemDiagnostics().catch(() => undefined);
  }

  function retest(accountId: string): void {
    void diagnoseAccount(accountId).catch(() => undefined);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="pulse" loading={diagnosticsLoading} onClick={runDiagnosis}>
          {systemDiagnosis ? 'Diagnosticar novamente' : 'Diagnosticar canais'}
        </Button>
        <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          {systemDiagnosis
            ? `Último teste ${formatDateTime(systemDiagnosis.testedAt)}`
            : 'Chamadas reais de token e leitura em cada loja.'}
        </span>
      </div>

      {diagnosticsError !== null ? (
        <Alert title="Não foi possível concluir o diagnóstico" tone="danger">
          {diagnosticsError}
        </Alert>
      ) : null}

      {rows.length === 0 ? (
        <Alert title="Nenhuma loja para testar" tone="neutral">
          Conecte uma loja no passo anterior para executar o diagnóstico real. O teste lê tokens e
          perfil no marketplace; nada é enviado ao comprador.
        </Alert>
      ) : null}

      {systemDiagnosis ? (
        <Card title="Infraestrutura" subtitle={`Versão ${systemDiagnosis.version}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={STATUS_TONE[systemDiagnosis.overall]}>
              <span className="inline-flex items-center gap-1">
                <Icon
                  name={systemDiagnosis.overall === 'ok' ? 'check' : 'bell'}
                  size={11}
                />
                Sistema: {STATUS_LABEL[systemDiagnosis.overall]}
              </span>
            </Pill>
            <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
              {infrastructureCounts.ok} ok · {infrastructureCounts.warn} atenção ·{' '}
              {infrastructureCounts.fail} falha(s) · {infrastructureCounts.skipped} não verificado(s)
            </span>
          </div>
          {infrastructureRemediations.length > 0 ? (
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
              {infrastructureRemediations.map((text) => (
                <Remediation key={text} text={text} />
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {rows.length > 0 ? (
        <Card title="Resultado por conta" subtitle="Resumo dos checks executados em cada loja">
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((row) => {
              const diagnosis = row.diagnosis;
              const counts = countChecks(diagnosis?.checks ?? []);
              const remediations = remediationLines(diagnosis?.checks ?? []).slice(0, 3);
              return (
                <li
                  key={row.accountId}
                  className="flex flex-col gap-2 border-t border-[var(--cv-color-border)] py-3 first:border-t-0 first:pt-0"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <MarketplaceBadge marketplace={row.marketplace} compact />
                    <strong className="min-w-0 truncate text-[var(--cv-font-meta)] font-medium">
                      {row.displayName}
                    </strong>
                    {diagnosis ? (
                      <Pill tone={STATUS_TONE[diagnosis.overall]}>
                        {STATUS_LABEL[diagnosis.overall]}
                      </Pill>
                    ) : (
                      <Pill tone="neutral">Não testado</Pill>
                    )}
                    <span className="ml-auto text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                      {diagnosis ? formatDateTime(diagnosis.testedAt) : '—'}
                    </span>
                  </div>

                  {diagnosis ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {STATUS_ORDER.map((status) => (
                        <Pill key={status} tone={STATUS_TONE[status]}>
                          {STATUS_LABEL[status]} {counts[status]}
                        </Pill>
                      ))}
                    </div>
                  ) : (
                    <p className="m-0 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                      Execute o diagnóstico para validar token, perfil e permissões desta conta.
                    </p>
                  )}

                  {remediations.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {remediations.map((text) => (
                        <Remediation key={text} text={text} />
                      ))}
                    </ul>
                  ) : null}

                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="pulse"
                      loading={diagnosingAccountId === row.accountId}
                      disabled={diagnosticsLoading}
                      onClick={() => retest(row.accountId)}
                    >
                      Testar esta conta
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      <p className="m-0 flex items-start gap-1.5 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
        <Icon name="lock" size={12} style={{ marginTop: 1, flex: 'none' }} />
        O diagnóstico é somente leitura: valida credenciais e permissões, sem publicar ou responder
        nada no marketplace.
      </p>
    </div>
  );
}
