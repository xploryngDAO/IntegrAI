import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AccountDiagnosis, Marketplace } from '@sac/shared';
import { Grid, Icon, PageHeader } from '@xploryng/convergencia';
import { Check, Copy } from 'lucide-react';
import type { AccountRow } from '../lib/types';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/store';
import { MARKETPLACE_LABEL } from '../lib/labels';
import { Button, Card, ConfirmDialog, IconButton, Pill, Skeleton } from '../components/ui';
import { LinkedAccountsList } from '../components/accounts/LinkedAccountsList';
import { reloadAccounts } from '../components/accounts/ConnectorCard';
import { ConnectModal } from '../components/accounts/ConnectModal';
import { DiagnosticsDialog } from '../components/accounts/DiagnosticsDialog';

type DiagnosticsTarget = { mode: 'account'; account: AccountRow } | { mode: 'system' };

const MARKETPLACES: readonly Marketplace[] = ['AMAZON', 'MERCADO_LIVRE', 'SHOPEE'];

const WEBHOOKS: ReadonlyArray<{ marketplace: Marketplace; path: string }> = [
  { marketplace: 'AMAZON', path: '/webhooks/amazon/ses' },
  { marketplace: 'MERCADO_LIVRE', path: '/webhooks/mercadolivre' },
  { marketplace: 'SHOPEE', path: '/webhooks/shopee' },
];

const OAUTH_REDIRECTS: ReadonlyArray<{ marketplace: Marketplace; path: string }> = [
  { marketplace: 'MERCADO_LIVRE', path: '/api/v1/accounts/oauth/mercadolivre/callback' },
  { marketplace: 'SHOPEE', path: '/api/v1/accounts/oauth/shopee/callback' },
];

function labelFromOAuthSlug(slug: string): string {
  if (slug === 'mercadolivre') return 'Mercado Livre';
  if (slug === 'shopee') return 'Shopee';
  if (slug === 'amazon') return 'Amazon';
  return slug;
}

function absoluteUrl(path: string): string {
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
}

function CopyRow({ label, value }: { label: string; value: string }): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
      pushToast({ tone: 'ok', title: 'Copiado', description: label });
    } catch {
      pushToast({ tone: 'warn', title: 'Não foi possível copiar', description: label });
    }
  }

  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2.5 py-1.5">
      <div className="min-w-0">
        <p className="sac-label m-0">{label}</p>
        <p className="sac-num m-0 truncate text-[var(--cv-font-meta)]" title={value}>
          {value}
        </p>
      </div>
      <IconButton
        label={`Copiar ${label}`}
        icon={copied ? <Check size={14} /> : <Copy size={14} />}
        onClick={() => void copy()}
      />
    </div>
  );
}

/** `/accounts` — connection status, onboarding wizard and webhook/redirect guide. */
export function AccountsPage(): JSX.Element {
  const accounts = useWorkspace((state) => state.accounts);
  const health = useWorkspace((state) => state.health);
  const boot = useWorkspace((state) => state.boot);
  const pushToast = useWorkspace((state) => state.pushToast);
  const accountDiagnoses = useWorkspace((state) => state.accountDiagnoses);
  const systemDiagnosis = useWorkspace((state) => state.systemDiagnosis);
  const diagnosticsLoading = useWorkspace((state) => state.diagnosticsLoading);
  const diagnosticsError = useWorkspace((state) => state.diagnosticsError);
  const diagnosingAccountId = useWorkspace((state) => state.diagnosingAccountId);
  const diagnoseAccount = useWorkspace((state) => state.diagnoseAccount);
  const systemDiagnostics = useWorkspace((state) => state.systemDiagnostics);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [hydrating, setHydrating] = useState(true);
  const [modalMarketplace, setModalMarketplace] = useState<Marketplace | null>(null);
  const [connectMenuOpen, setConnectMenuOpen] = useState(false);
  const [busyMarketplace, setBusyMarketplace] = useState<Marketplace | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<AccountRow | null>(null);
  const [diagnosticsTarget, setDiagnosticsTarget] = useState<DiagnosticsTarget | null>(null);
  const connectMenuRef = useRef<HTMLDivElement | null>(null);

  // Pills use the last per-account diagnosis; a system run also updates them.
  const diagnosesForPills = useMemo<Record<string, AccountDiagnosis>>(() => {
    const merged: Record<string, AccountDiagnosis> = { ...accountDiagnoses };
    for (const channel of systemDiagnosis?.channels ?? []) {
      merged[channel.accountId] = channel;
    }
    return merged;
  }, [accountDiagnoses, systemDiagnosis]);

  useEffect(() => {
    let active = true;
    void boot().finally(() => {
      if (active) setHydrating(false);
    });
    return () => {
      active = false;
    };
  }, [boot]);

  useEffect(() => {
    const connected = searchParams.get('connected');
    const error = searchParams.get('error');
    if (!connected && !error) return;
    if (connected) {
      pushToast({
        tone: 'ok',
        title: 'Conta conectada',
        description: `${labelFromOAuthSlug(connected)} autorizado com sucesso.`,
      });
    }
    if (error) {
      pushToast({
        tone: 'danger',
        title: 'Falha na conexão',
        description: `Código retornado: ${error}`,
      });
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, pushToast]);

  useEffect(() => {
    if (!connectMenuOpen) return;
    function handlePointerDown(event: MouseEvent): void {
      if (connectMenuRef.current && !connectMenuRef.current.contains(event.target as Node)) {
        setConnectMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setConnectMenuOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [connectMenuOpen]);

  const connectedCount = accounts.filter((account) => account.status === 'ACTIVE').length;
  const expiredCount = accounts.filter((account) => account.status === 'TOKEN_EXPIRED').length;

  async function handleRefreshToken(account: AccountRow): Promise<void> {
    setBusyMarketplace(account.marketplace);
    try {
      const result = await api.refreshAccount(account.id);
      pushToast({
        tone: result.ok ? 'ok' : 'warn',
        title: result.ok ? 'Token atualizado' : 'Token não atualizado',
        description: result.detail,
      });
      await reloadAccounts();
    } catch {
      pushToast({ tone: 'danger', title: 'Falha ao atualizar token', description: account.displayName });
    } finally {
      setBusyMarketplace(null);
    }
  }

  async function handleDisconnect(): Promise<void> {
    if (!confirmDisconnect) return;
    const account = confirmDisconnect;
    setConfirmDisconnect(null);
    setBusyMarketplace(account.marketplace);
    try {
      await api.disconnectAccount(account.id);
      pushToast({ tone: 'ok', title: 'Conta desconectada', description: account.displayName });
      await reloadAccounts();
    } catch {
      pushToast({ tone: 'danger', title: 'Falha ao desconectar', description: account.displayName });
    } finally {
      setBusyMarketplace(null);
    }
  }

  function openAccountDiagnostics(account: AccountRow): void {
    setDiagnosticsTarget({ mode: 'account', account });
    // The store owns loading/error state and rethrows on failure; the dialog
    // renders `diagnosticsError` and the store also emits a danger toast.
    void diagnoseAccount(account.id).catch(() => undefined);
  }

  function openSystemDiagnostics(): void {
    setDiagnosticsTarget({ mode: 'system' });
    void systemDiagnostics().catch(() => undefined);
  }

  function retryDiagnostics(): void {
    if (!diagnosticsTarget) return;
    if (diagnosticsTarget.mode === 'account') {
      void diagnoseAccount(diagnosticsTarget.account.id).catch(() => undefined);
      return;
    }
    void systemDiagnostics().catch(() => undefined);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <PageHeader
        eyebrow="Omnichannel"
        title="Canais conectados"
        description="Autorize as lojas de cada marketplace para centralizar mensagens, pedidos e ações de pós-venda no SAC Hub. Tokens são cifrados em repouso e renovados automaticamente."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" icon="spark" onClick={() => navigate('/onboarding')}>
              Primeiros passos
            </Button>
            <Button
              variant="secondary"
              icon="pulse"
              loading={diagnosticsLoading}
              onClick={openSystemDiagnostics}
            >
              Diagnosticar canais
            </Button>
            <div className="relative" ref={connectMenuRef}>
              <Button
                variant="primary"
                icon="plus"
                onClick={() => setConnectMenuOpen((open) => !open)}
              >
                Conectar loja
              </Button>
              {connectMenuOpen ? (
                <div
                  role="menu"
                  aria-label="Escolher marketplace"
                  className="absolute right-0 top-full z-30 mt-1.5 w-56 rounded-[var(--cv-radius-control)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface)] p-1"
                  style={{ boxShadow: 'var(--cv-shadow-floating)' }}
                >
                  {MARKETPLACES.map((marketplace) => (
                    <button
                      key={marketplace}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setModalMarketplace(marketplace);
                        setConnectMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-[var(--cv-radius-small)] px-2.5 py-2 text-left text-[var(--cv-font-meta)] hover:bg-[var(--cv-color-surface-subtle)] focus-visible:outline-none"
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{
                          background:
                            marketplace === 'AMAZON'
                              ? 'var(--cv-color-warning)'
                              : marketplace === 'MERCADO_LIVRE'
                                ? 'var(--cv-color-accent)'
                                : 'var(--cv-color-rose)',
                        }}
                        aria-hidden="true"
                      />
                      {MARKETPLACE_LABEL[marketplace]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="ok">
          <Icon name="check" size={12} /> {connectedCount} conectada(s)
        </Pill>
        {expiredCount > 0 ? <Pill tone="warn">{expiredCount} token(s) expirado(s)</Pill> : null}
        <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
          {accounts.length} loja(s) neste workspace
        </span>
      </div>

      <Card>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="m-0 text-[var(--cv-font-control)] font-medium">Ainda não tem o app?</p>
            <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
              Crie o app no portal do marketplace antes de autorizar a loja. A tela de integrações
              mostra a redirect URI, a URL de webhook, os escopos/tópicos e o App ID exatos.
            </p>
          </div>
          <Button
            variant="secondary"
            icon="rocket"
            className="w-full flex-none sm:w-auto"
            onClick={() => navigate('/setup')}
          >
            Configure as integrações
          </Button>
        </div>
      </Card>

      {hydrating && accounts.length === 0 ? (
        <Grid min={300} aria-busy="true">
          {[0, 1, 2].map((index) => (
            <Card key={index}>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-10 w-full" />
              </div>
            </Card>
          ))}
        </Grid>
      ) : (
        <LinkedAccountsList
          accounts={accounts}
          health={health}
          diagnoses={diagnosesForPills}
          diagnosingAccountId={diagnosingAccountId}
          busyMarketplace={busyMarketplace}
          onReconnect={(marketplace) => setModalMarketplace(marketplace)}
          onDiagnose={openAccountDiagnostics}
          onRefreshToken={(account) => void handleRefreshToken(account)}
          onDisconnect={(account) => setConfirmDisconnect(account)}
        />
      )}

      <Card title="Como conectar">
        <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
          <div>
            <p className="sac-label m-0">Passos</p>
            <ol className="m-0 mt-1.5 list-decimal space-y-1 pl-4 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
              <li>
                Clique em <span className="font-medium text-[var(--cv-color-text)]">Conectar loja</span> e escolha o
                marketplace.
              </li>
              <li>
                Cadastre a <span className="font-medium text-[var(--cv-color-text)]">Redirect URI</span> e a URL de{' '}
                <span className="font-medium text-[var(--cv-color-text)]">Webhook</span> no portal do parceiro.
              </li>
              <li>Autorize a loja — para Mercado Livre e Shopee o retorno é automático.</li>
              <li>
                Confirme o status <span className="text-[var(--cv-color-success)]">Conectado</span> e o prazo do token
                neste painel.
              </li>
            </ol>
            <p className="m-0 mt-2 flex items-start gap-1.5 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
              <Icon name="lock" size={12} />
              Os webhooks exigem HTTPS público e validação de assinatura (SES HMAC, Shopee HMAC e Meli idempotente) no
              servidor.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <p className="sac-label m-0">Webhooks por canal</p>
            {WEBHOOKS.map((webhook) => (
              <CopyRow
                key={webhook.path}
                label={MARKETPLACE_LABEL[webhook.marketplace]}
                value={absoluteUrl(webhook.path)}
              />
            ))}
            <p className="sac-label m-0 pt-1">Redirect URIs OAuth</p>
            {OAUTH_REDIRECTS.map((redirect) => (
              <CopyRow
                key={redirect.path}
                label={MARKETPLACE_LABEL[redirect.marketplace]}
                value={absoluteUrl(redirect.path)}
              />
            ))}
          </div>
        </div>
      </Card>

      {modalMarketplace ? (
        <ConnectModal
          open
          marketplace={modalMarketplace}
          onClose={() => setModalMarketplace(null)}
        />
      ) : null}

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
          onRetry={retryDiagnostics}
        />
      ) : diagnosticsTarget?.mode === 'system' ? (
        <DiagnosticsDialog
          open
          mode="system"
          data={systemDiagnosis}
          loading={diagnosticsLoading}
          error={diagnosticsError}
          onClose={() => setDiagnosticsTarget(null)}
          onRetry={retryDiagnostics}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDisconnect !== null}
        title="Desconectar loja?"
        description={
          confirmDisconnect
            ? `A conta "${confirmDisconnect.displayName}" deixará de sincronizar mensagens e pedidos. Chamada executada: DELETE /api/v1/accounts/${confirmDisconnect.id}.`
            : ''
        }
        confirmLabel="Desconectar"
        tone="danger"
        onConfirm={() => void handleDisconnect()}
        onClose={() => setConfirmDisconnect(null)}
      />
    </div>
  );
}
