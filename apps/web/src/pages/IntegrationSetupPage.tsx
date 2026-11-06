import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AccountDiagnosis,
  DiagnosisCheck,
  DiagnosisStatus,
  Marketplace,
} from '@sac/shared';
import { Grid, Icon, PageHeader } from '@xploryng/convergencia';
import { Check, Copy } from 'lucide-react';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/store';
import type { AccountRow, IntegrationSetup, IntegrationSetupChannel } from '../lib/types';
import { formatDateTime } from '../lib/labels';
import {
  connectionTestErrorMessage,
  integrationChannelLabel,
  integrationSetupErrorMessage,
  isHttpUrl,
  sortIntegrationChannels,
  toMarketplace,
} from '../lib/integrations';
import { isForbiddenError } from '../lib/platform';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  IconButton,
  MarketplaceBadge,
  Pill,
  Skeleton,
  type PillTone,
} from '../components/ui';
import { DiagnosticsDialog } from '../components/accounts/DiagnosticsDialog';

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

type DiagnosticsTarget = { mode: 'system' } | { mode: 'account'; account: AccountRow };

function countChecks(checks: DiagnosisCheck[]): Record<DiagnosisStatus, number> {
  const counts: Record<DiagnosisStatus, number> = { ok: 0, warn: 0, fail: 0, skipped: 0 };
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

/** Prefer the live account, then the first one, exactly like the accounts page. */
function primaryAccountFor(accounts: AccountRow[], marketplace: Marketplace): AccountRow | null {
  const matches = accounts.filter((account) => account.marketplace === marketplace);
  if (matches.length === 0) return null;
  return matches.find((account) => account.status === 'ACTIVE') ?? matches[0] ?? null;
}

/**
 * `configured` comes from the API, but a channel that still lists missing env
 * variables is not ready: the pill never claims "Configurado" in that case.
 */
function channelStatus(channel: IntegrationSetupChannel): { label: string; tone: PillTone } {
  const complete = channel.configured && channel.missing.length === 0;
  return complete ? { label: 'Configurado', tone: 'ok' } : { label: 'Pendente', tone: 'warn' };
}

function CopyButton({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: (label: string, value: string) => void;
}): JSX.Element {
  return (
    <IconButton
      label={`Copiar ${label}`}
      icon={copied ? <Check size={14} /> : <Copy size={14} />}
      onClick={() => onCopy(label, value)}
      className="flex-none"
    />
  );
}

/** One exact value to paste in the marketplace portal. */
function SetupValueRow({
  label,
  value,
  emptyText = 'Não informado pela API',
  hint,
  onCopy,
  copiedValue,
}: {
  label: string;
  value: string | null;
  emptyText?: string;
  hint?: string;
  onCopy: (label: string, value: string) => void;
  copiedValue: string | null;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-2">
      <div className="min-w-0">
        <p className="sac-label m-0">{label}</p>
        {value ? (
          <p className="sac-num m-0 break-all text-[var(--cv-font-meta)] leading-relaxed">{value}</p>
        ) : (
          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            {emptyText}
          </p>
        )}
        {hint ? (
          <p className="m-0 mt-0.5 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            {hint}
          </p>
        ) : null}
      </div>
      {value ? (
        <CopyButton label={label} value={value} copied={copiedValue === value} onCopy={onCopy} />
      ) : null}
    </div>
  );
}

/** Topics/scopes as chips; the copy action joins them the way portals expect. */
function ScopesRow({
  values,
  onCopy,
  copied,
}: {
  values: string[];
  onCopy: (label: string, value: string) => void;
  copied: boolean;
}): JSX.Element {
  return (
    <div className="flex min-w-0 items-start justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-2">
      <div className="min-w-0">
        <p className="sac-label m-0">Escopos / tópicos</p>
        {values.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {values.map((value) => (
              <span
                key={value}
                className="sac-num rounded-[var(--cv-radius-pill)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface)] px-2 py-0.5 text-[var(--cv-font-micro)]"
              >
                {value}
              </span>
            ))}
          </div>
        ) : (
          <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Não informado pela API
          </p>
        )}
      </div>
      {values.length > 0 ? (
        <IconButton
          label="Copiar escopos/tópicos"
          icon={copied ? <Check size={14} /> : <Copy size={14} />}
          onClick={() => onCopy('Escopos / tópicos', values.join(', '))}
          className="flex-none"
        />
      ) : null}
    </div>
  );
}

function DiagnosisSummary({
  diagnosis,
  onDetails,
}: {
  diagnosis: AccountDiagnosis;
  onDetails: () => void;
}): JSX.Element {
  const counts = countChecks(diagnosis.checks);
  const remediations = remediationLines(diagnosis.checks).slice(0, 2);

  return (
    <div className="flex flex-col gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={STATUS_TONE[diagnosis.overall]}>
          <span className="inline-flex items-center gap-1">
            <Icon name={diagnosis.overall === 'ok' ? 'check' : 'bell'} size={11} />
            {STATUS_LABEL[diagnosis.overall]}
          </span>
        </Pill>
        <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          Testado {formatDateTime(diagnosis.testedAt)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_ORDER.map((status) => (
          <Pill key={status} tone={STATUS_TONE[status]}>
            {STATUS_LABEL[status]} {counts[status]}
          </Pill>
        ))}
      </div>

      {remediations.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {remediations.map((text) => (
            <li
              key={text}
              className="flex items-start gap-1.5 text-[var(--cv-font-micro)] leading-snug"
              style={{ color: 'var(--cv-color-warning)' }}
            >
              <Icon name="tool" size={12} style={{ marginTop: 1, flex: 'none' }} />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" icon="list" onClick={onDetails}>
          Ver checks
        </Button>
        <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          {diagnosis.checks.length} verificação(ões) executada(s)
        </span>
      </div>
    </div>
  );
}

/**
 * `/setup` — criar os apps de integração nos portais dos marketplaces.
 *
 * Platform-admin only: the API is the guard and a `403` renders the "Acesso
 * restrito" state. Every value on screen comes from
 * `GET /platform/integration-setup`; missing credentials are shown as the env
 * variables the deployment still needs. "Testar conexão" reuses the existing
 * diagnostics (`POST /accounts/:id/diagnose` when a store exists,
 * `GET /diagnostics` otherwise) — nothing is sent to a buyer.
 */
export function IntegrationSetupPage(): JSX.Element {
  const navigate = useNavigate();
  const accounts = useWorkspace((state) => state.accounts);
  const systemDiagnosis = useWorkspace((state) => state.systemDiagnosis);
  const accountDiagnoses = useWorkspace((state) => state.accountDiagnoses);
  const diagnosticsLoading = useWorkspace((state) => state.diagnosticsLoading);
  const diagnosticsError = useWorkspace((state) => state.diagnosticsError);
  const diagnosingAccountId = useWorkspace((state) => state.diagnosingAccountId);
  const systemDiagnostics = useWorkspace((state) => state.systemDiagnostics);
  const diagnoseAccount = useWorkspace((state) => state.diagnoseAccount);
  const pushToast = useWorkspace((state) => state.pushToast);

  const [setup, setSetup] = useState<IntegrationSetup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [testing, setTesting] = useState<string | null>(null);
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [diagnosticsTarget, setDiagnosticsTarget] = useState<DiagnosticsTarget | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    void api
      .integrationSetup()
      .then((result) => {
        if (!active) return;
        setSetup(result);
        setForbidden(false);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        setSetup(null);
        if (isForbiddenError(failure)) {
          setForbidden(true);
          return;
        }
        setError(integrationSetupErrorMessage(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  const channels = useMemo(
    () => (setup ? sortIntegrationChannels(setup.channels) : []),
    [setup],
  );
  const configuredCount = channels.filter((channel) => channelStatus(channel).tone === 'ok').length;
  const pendingCount = channels.length - configuredCount;

  function retry(): void {
    setReloadKey((key) => key + 1);
  }

  async function copy(label: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      window.setTimeout(
        () => setCopiedValue((current) => (current === value ? null : current)),
        1_500,
      );
      pushToast({ tone: 'ok', title: 'Copiado', description: label });
    } catch {
      pushToast({ tone: 'warn', title: 'Não foi possível copiar', description: label });
    }
  }

  function diagnosisFor(channel: IntegrationSetupChannel): AccountDiagnosis | null {
    const marketplace = toMarketplace(channel.marketplace);
    if (marketplace === null) return null;
    const account = primaryAccountFor(accounts, marketplace);
    // A per-account re-test is newer than the last system run.
    if (account && accountDiagnoses[account.id]) return accountDiagnoses[account.id];
    return systemDiagnosis?.channels.find((entry) => entry.marketplace === marketplace) ?? null;
  }

  function openSystemDiagnostics(): void {
    setDiagnosticsTarget({ mode: 'system' });
    // The store owns loading/error and emits its own danger toast; the dialog
    // renders `diagnosticsError`, so the rejection is just swallowed here.
    void systemDiagnostics().catch(() => undefined);
  }

  function openAccountDiagnostics(account: AccountRow): void {
    setDiagnosticsTarget({ mode: 'account', account });
    void diagnoseAccount(account.id).catch(() => undefined);
  }

  async function testConnection(channel: IntegrationSetupChannel): Promise<void> {
    if (testing !== null) return;
    const key = channel.marketplace;
    setTestErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setTesting(key);

    try {
      const marketplace = toMarketplace(channel.marketplace);
      if (marketplace === null) {
        setTestErrors((current) => ({
          ...current,
          [key]:
            'A UI não reconhece o identificador deste canal, então não é possível casá-lo com uma loja conectada.',
        }));
        return;
      }

      const account = primaryAccountFor(accounts, marketplace);
      if (account) {
        await diagnoseAccount(account.id);
        return;
      }

      const result = await systemDiagnostics();
      const tested = result.channels.some((entry) => entry.marketplace === marketplace);
      if (!tested) {
        setTestErrors((current) => ({
          ...current,
          [key]:
            'Nenhuma loja deste canal está conectada neste workspace. Conecte uma loja em Canais para testar as credenciais do app.',
        }));
      }
    } catch (failure) {
      setTestErrors((current) => ({ ...current, [key]: connectionTestErrorMessage(failure) }));
    } finally {
      setTesting(null);
    }
  }

  const pageDescription =
    'Crie um app por marketplace e cole os valores abaixo no portal do parceiro. Todo valor vem da API: o que ainda não foi publicado aparece como pendente, e nenhum segredo é exposto.';

  if (forbidden) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
        <PageHeader
          eyebrow="Integrações"
          title="Criar apps de integração"
          description="Área restrita à equipe da plataforma. Os valores de configuração são servidos apenas para contas autorizadas."
        />
        <Card>
          <EmptyState
            icon="lock"
            title="Acesso restrito"
            description="Sua conta não tem acesso à configuração de integrações (HTTP 403). Apenas um platform admin pode ver os valores de app, webhook e escopos. Se isso não for esperado, peça a um administrador para revisar o seu papel de acesso."
            action={
              <Button variant="primary" icon="arrow" onClick={() => navigate('/')}>
                Voltar para a fila
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <PageHeader
        eyebrow="Integrações"
        title="Criar apps de integração"
        description={pageDescription}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon="orbit"
              className="whitespace-nowrap"
              onClick={retry}
              disabled={loading}
            >
              Atualizar
            </Button>
            <Button
              variant="secondary"
              icon="pulse"
              className="whitespace-nowrap"
              loading={diagnosticsLoading}
              onClick={openSystemDiagnostics}
            >
              Diagnosticar canais
            </Button>
          </div>
        }
      />

      {loading ? (
        <Grid min={300} aria-busy="true">
          {[0, 1, 2].map((index) => (
            <Card key={index}>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-7 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            </Card>
          ))}
        </Grid>
      ) : error !== null ? (
        <Alert title="Não foi possível carregar a configuração das integrações" tone="danger">
          <div className="flex flex-col gap-2">
            <span>{error}</span>
            <div>
              <Button size="sm" icon="pulse" onClick={retry}>
                Tentar novamente
              </Button>
            </div>
          </div>
        </Alert>
      ) : setup === null || channels.length === 0 ? (
        <Card>
          <EmptyState
            icon="network"
            title="Nenhum canal publicado"
            description="A API respondeu sem canais de integração. Isso pode significar que o catálogo ainda não foi publicado neste ambiente; atualize para consultar novamente."
            action={
              <Button variant="secondary" icon="orbit" onClick={retry}>
                Atualizar
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={pendingCount === 0 ? 'ok' : 'warn'}>
              <span className="inline-flex items-center gap-1">
                <Icon name={pendingCount === 0 ? 'check' : 'bell'} size={11} />
                {configuredCount} de {channels.length} configurado(s)
              </span>
            </Pill>
            {pendingCount > 0 ? <Pill tone="warn">{pendingCount} pendente(s)</Pill> : null}
            <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
              Leitura {formatDateTime(setup.generatedAt)}
            </span>
          </div>

          <Grid min={300}>
            {channels.map((channel) => {
              const marketplace = toMarketplace(channel.marketplace);
              const label = integrationChannelLabel(channel.marketplace);
              const status = channelStatus(channel);
              const diagnosis = diagnosisFor(channel);
              const testError = testErrors[channel.marketplace] ?? null;
              const account = marketplace ? primaryAccountFor(accounts, marketplace) : null;
              const isTesting = testing === channel.marketplace;

              return (
                <Card
                  key={channel.marketplace}
                  title={
                    <span className="flex min-w-0 items-center gap-2">
                      {marketplace ? <MarketplaceBadge marketplace={marketplace} compact /> : null}
                      <span className="min-w-0 truncate">{label}</span>
                    </span>
                  }
                  subtitle={
                    channel.appIdPublic
                      ? `App ID ${channel.appIdPublic}`
                      : 'App ainda não configurado neste ambiente'
                  }
                  actions={<Pill tone={status.tone}>{status.label}</Pill>}
                  footer={
                    <>
                      <span className="min-w-0 truncate text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                        {account
                          ? `Conta ${account.displayName}`
                          : marketplace
                            ? 'Sem loja conectada neste workspace'
                            : 'Canal não reconhecido pela UI'}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="pulse"
                        loading={isTesting}
                        disabled={testing !== null && !isTesting}
                        className="flex-none whitespace-nowrap"
                        onClick={() => void testConnection(channel)}
                        aria-label={`Testar conexão de ${label}`}
                      >
                        Testar conexão
                      </Button>
                    </>
                  }
                >
                  <div className="flex flex-col gap-3">
                    {channel.missing.length > 0 ? (
                      <Alert title="Faltam variáveis de ambiente" tone="warning">
                        <div className="flex flex-col gap-1.5">
                          <span>Defina no ambiente da API e atualize esta página:</span>
                          <div className="flex flex-wrap gap-1">
                            {channel.missing.map((env) => (
                              <span
                                key={env}
                                className="sac-num break-all rounded-[var(--cv-radius-pill)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface)] px-2 py-0.5 text-[var(--cv-font-micro)]"
                              >
                                {env}
                              </span>
                            ))}
                          </div>
                        </div>
                      </Alert>
                    ) : !channel.configured ? (
                      <Alert title="Canal pendente" tone="warning">
                        A API não informou quais variáveis faltam para este canal. Confira o ambiente
                        da API antes de criar o app no portal.
                      </Alert>
                    ) : null}

                    <div className="flex flex-col gap-2">
                      <SetupValueRow
                        label="App ID / Client ID público"
                        value={channel.appIdPublic}
                        emptyText="Não configurado neste ambiente"
                        onCopy={(name, value) => void copy(name, value)}
                        copiedValue={copiedValue}
                      />
                      <SetupValueRow
                        label="Redirect URI"
                        value={channel.redirectUri}
                        onCopy={(name, value) => void copy(name, value)}
                        copiedValue={copiedValue}
                      />
                      <SetupValueRow
                        label="Webhook URL"
                        value={channel.webhookUrl}
                        onCopy={(name, value) => void copy(name, value)}
                        copiedValue={copiedValue}
                      />
                      <ScopesRow
                        values={channel.oauthScopesOrTopics}
                        onCopy={(name, value) => void copy(name, value)}
                        copied={copiedValue === channel.oauthScopesOrTopics.join(', ')}
                      />
                      <SetupValueRow
                        label="Segredo do webhook (variável)"
                        value={channel.webhookSecretEnv}
                        hint="O valor do segredo não é exposto: fica apenas nas variáveis de ambiente da API."
                        onCopy={(name, value) => void copy(name, value)}
                        copiedValue={copiedValue}
                      />
                    </div>

                    <div className="sac-divider" />

                    <div>
                      <p className="sac-label m-0">Passos no portal</p>
                      {channel.steps.length > 0 ? (
                        <ol className="m-0 mt-1.5 flex list-decimal flex-col gap-1 pl-4 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
                          {channel.steps.map((step, index) => (
                            <li key={`${index}-${step}`}>{step}</li>
                          ))}
                        </ol>
                      ) : (
                        <p className="m-0 mt-1.5 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
                          A API não publicou passos para este canal.
                        </p>
                      )}
                    </div>

                    {isHttpUrl(channel.portalUrl) || isHttpUrl(channel.docsUrl) ? (
                      <div className="flex flex-wrap items-center gap-3">
                        {isHttpUrl(channel.portalUrl) ? (
                          <a
                            href={channel.portalUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1.5 text-[var(--cv-font-meta)] font-medium text-[var(--cv-color-accent-text)] underline-offset-2 hover:underline"
                          >
                            <Icon name="rocket" size={13} />
                            Abrir portal do {label}
                          </a>
                        ) : null}
                        {isHttpUrl(channel.docsUrl) ? (
                          <a
                            href={channel.docsUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1.5 text-[var(--cv-font-meta)] font-medium text-[var(--cv-color-accent-text)] underline-offset-2 hover:underline"
                          >
                            <Icon name="book" size={13} />
                            Documentação de {label}
                          </a>
                        ) : null}
                      </div>
                    ) : (
                      <p className="m-0 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                        A API não publicou links de portal/documentação para este canal.
                      </p>
                    )}

                    {testError !== null ? (
                      <Alert title="Teste não concluído" tone="danger">
                        {testError}
                      </Alert>
                    ) : diagnosis ? (
                      <DiagnosisSummary
                        diagnosis={diagnosis}
                        onDetails={() => {
                          if (account) openAccountDiagnostics(account);
                          else openSystemDiagnostics();
                        }}
                      />
                    ) : null}

                    {!account && marketplace ? (
                      <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
                        Sem loja conectada: “Testar conexão” executa o diagnóstico do sistema
                        (GET /diagnostics) e mostra os checks deste marketplace. Para testar uma loja
                        específica, conecte-a em Canais.
                      </p>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </Grid>

          <Card title="Ambiente da API" subtitle="Origem dos valores públicos usados nos portais">
            <div className="flex flex-col gap-2">
              <SetupValueRow
                label="Base da API"
                value={setup.apiBaseUrl || null}
                onCopy={(name, value) => void copy(name, value)}
                copiedValue={copiedValue}
              />
              <SetupValueRow
                label="Origem web"
                value={setup.webOrigin || null}
                onCopy={(name, value) => void copy(name, value)}
                copiedValue={copiedValue}
              />
              <p className="m-0 flex items-start gap-1.5 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
                <Icon name="lock" size={12} style={{ marginTop: 1, flex: 'none' }} />
                Segredos de app e de webhook nunca saem do servidor. O teste de conexão usa o
                diagnóstico real do workspace e exige papel ADMIN nele; nada é enviado ao comprador.
              </p>
            </div>
          </Card>
        </>
      )}

      {diagnosticsTarget?.mode === 'account' ? (
        <DiagnosticsDialog
          open
          mode="account"
          accountId={diagnosticsTarget.account.id}
          accountName={diagnosticsTarget.account.displayName}
          data={accountDiagnoses[diagnosticsTarget.account.id] ?? null}
          loading={diagnosingAccountId === diagnosticsTarget.account.id}
          error={diagnosticsError}
          onClose={() => setDiagnosticsTarget(null)}
          onRetry={() => {
            if (diagnosticsTarget.mode === 'account') {
              void diagnoseAccount(diagnosticsTarget.account.id).catch(() => undefined);
            }
          }}
        />
      ) : diagnosticsTarget?.mode === 'system' ? (
        <DiagnosticsDialog
          open
          mode="system"
          data={systemDiagnosis}
          loading={diagnosticsLoading}
          error={diagnosticsError}
          onClose={() => setDiagnosticsTarget(null)}
          onRetry={() => void systemDiagnostics().catch(() => undefined)}
        />
      ) : null}
    </div>
  );
}
