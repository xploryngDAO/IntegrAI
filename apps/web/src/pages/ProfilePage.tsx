import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, PageHeader } from '@xploryng/convergencia';
import { api, ApiClientError } from '../lib/api';
import { useWorkspace } from '../lib/store';
import { describeDevice } from '../lib/session';
import { accountErrorMessage, roleLabel } from '../lib/admin';
import { formatDateTime } from '../lib/labels';
import type { TenantProfile, UserSession } from '../lib/types';
import {
  Alert,
  Button,
  Card,
  ConfirmActionDialog,
  EmptyState,
  Input,
  Pill,
  Skeleton,
} from '../components/ui';
import { useEndSession } from '../components/layout/useEndSession';

/** Maximum accepted by the API for a display name (invitation schema uses 120). */
const NAME_MAX_LENGTH = 120;

/**
 * `/profile` — the operator's own account (Fase 1 identity, self-service).
 *
 * Sections:
 *  - editable display name (`PATCH /auth/me`), the only mutable field here;
 *  - read-only identity: e-mail, role, workspace (`GET /tenants/me` hint);
 *  - active refresh sessions (`GET /auth/sessions`) with per-device revoke;
 *  - "Sair de todos os dispositivos" (logout everywhere, double confirmation);
 *  - security shortcuts (password reset, 2FA in `/settings`).
 *
 * Every write is guarded by the API; the page never assumes success and always
 * shows the real error message. A 403/404 on the workspace read is treated as
 * "no tenant data" (a platform operator has none), not as a page failure.
 */
export function ProfilePage(): JSX.Element {
  const currentAgent = useWorkspace((state) => state.currentAgent);
  const pushToast = useWorkspace((state) => state.pushToast);
  const navigate = useNavigate();
  const { end: endEverywhere, pending: endingEverywhere } = useEndSession('everywhere');
  const { end: endCurrent, pending: endingCurrent } = useEndSession('current');

  const [tenant, setTenant] = useState<TenantProfile | null>(null);
  const [tenantLoading, setTenantLoading] = useState(true);
  const [tenantError, setTenantError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [name, setName] = useState(currentAgent?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<UserSession | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [confirmEverywhere, setConfirmEverywhere] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  const retry = useCallback((): void => {
    setReloadKey((key) => key + 1);
  }, []);

  // Keep the field in sync when the identity is (re)resolved by boot/login,
  // but never while the operator is typing (the dependency is the id).
  useEffect(() => {
    setName(currentAgent?.name ?? '');
    setSaveError(null);
  }, [currentAgent?.id]);

  useEffect(() => {
    let active = true;

    async function loadTenant(): Promise<void> {
      setTenantLoading(true);
      setTenantError(null);
      try {
        const profile = await api.tenantProfile();
        if (active) setTenant(profile);
      } catch (error) {
        if (!active) return;
        setTenant(null);
        // A platform operator has no tenant and sees 403/404 here — that is an
        // empty state, not a failure of the profile page.
        const status = error instanceof ApiClientError ? error.status : 0;
        if (status !== 403 && status !== 404) setTenantError(accountErrorMessage(error));
      } finally {
        if (active) setTenantLoading(false);
      }
    }

    void loadTenant();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    let active = true;

    async function loadSessions(): Promise<void> {
      setSessionsLoading(true);
      setSessionsError(null);
      try {
        const items = await api.sessions();
        if (active) setSessions(items);
      } catch (error) {
        if (!active) return;
        setSessions([]);
        setSessionsError(accountErrorMessage(error));
      } finally {
        if (active) setSessionsLoading(false);
      }
    }

    void loadSessions();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length === 0
      ? 'Informe o nome que deve aparecer para a equipe.'
      : trimmedName.length > NAME_MAX_LENGTH
        ? `Use no máximo ${NAME_MAX_LENGTH} caracteres.`
        : undefined;
  const dirty = currentAgent !== null && trimmedName !== currentAgent.name;

  async function handleSaveName(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!dirty || saving || nameError !== undefined || trimmedName.length === 0) return;

    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateProfile(trimmedName);
      // This form only edits the display name: keep the rest of the identity
      // from the store so a partial PATCH response cannot blank e-mail/role.
      const next = {
        ...currentAgent,
        id: updated.id,
        name: updated.name.length > 0 ? updated.name : trimmedName,
      };
      useWorkspace.setState({ currentAgent: next });
      setName(next.name);
      pushToast({
        tone: 'ok',
        title: 'Perfil atualizado',
        description: 'Seu nome de exibição foi alterado.',
      });
    } catch (error) {
      setSaveError(accountErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke(): Promise<void> {
    if (revokeTarget === null || revoking) return;
    const target = revokeTarget;
    setRevoking(true);
    try {
      await api.revokeSession(target.id);
      pushToast({
        tone: 'ok',
        title: 'Sessão revogada',
        description: `${describeDevice(target.userAgent)} precisará entrar novamente.`,
      });
      setRevokeTarget(null);
      setReloadKey((key) => key + 1);
    } catch (error) {
      const status = error instanceof ApiClientError ? error.status : 0;
      if (status === 404) {
        // Already gone on the server: drop the row instead of reporting failure.
        setSessions((current) => current.filter((entry) => entry.id !== target.id));
        setRevokeTarget(null);
        pushToast({
          tone: 'info',
          title: 'Sessão já encerrada',
          description: 'A sessão não existia mais na API e foi removida da lista.',
        });
      } else {
        pushToast({
          tone: 'danger',
          title: 'Não foi possível revogar a sessão',
          description: accountErrorMessage(error),
        });
      }
    } finally {
      setRevoking(false);
    }
  }

  if (currentAgent === null) {
    return (
      <div className="sac-page flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
        <PageHeader eyebrow="Conta" title="Meu perfil" description="Carregando seus dados…" />
        <Card>
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="sac-page flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <PageHeader
        eyebrow="Conta"
        title="Meu perfil"
        description="Seus dados de operador, as sessões abertas neste momento e os atalhos de segurança da conta."
        actions={
          <Button
            variant="secondary"
            icon="pulse"
            loading={sessionsLoading || tenantLoading}
            onClick={retry}
          >
            Atualizar
          </Button>
        }
      />

      <div className="sac-profile">
        <div className="sac-profile__main">
          <Card
            title="Dados pessoais"
            subtitle="O nome é o que a equipe vê na fila e nas conversas. E-mail e papel são definidos pelo workspace."
          >
            <form className="flex flex-col gap-3" onSubmit={(event) => void handleSaveName(event)}>
              <Input
                label="Nome de exibição"
                value={name}
                maxLength={NAME_MAX_LENGTH}
                autoComplete="name"
                disabled={saving}
                error={nameError}
                hint={`${trimmedName.length}/${NAME_MAX_LENGTH} caracteres`}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaveError(null);
                }}
              />

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  icon="check"
                  loading={saving}
                  disabled={!dirty || nameError !== undefined}
                >
                  Salvar nome
                </Button>
                {dirty ? (
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setName(currentAgent.name);
                      setSaveError(null);
                    }}
                  >
                    Descartar
                  </Button>
                ) : null}
                <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                  O novo nome passa a valer assim que você salvar.
                </span>
              </div>

              {saveError !== null ? (
                <Alert title="Não foi possível salvar o perfil" tone="danger">
                  {saveError}
                </Alert>
              ) : null}
            </form>

            <div className="sac-divider" />

            <dl className="m-0 flex flex-col gap-1.5" aria-label="Dados somente leitura">
              <div className="sac-kv">
                <dt>E-mail</dt>
                <dd className="truncate" title={currentAgent.email}>
                  {currentAgent.email.length > 0 ? currentAgent.email : '—'}
                </dd>
              </div>
              <div className="sac-kv">
                <dt>Papel</dt>
                <dd className="flex items-center">
                  <Pill tone="neutral">{roleLabel(currentAgent.role)}</Pill>
                </dd>
              </div>
              <div className="sac-kv">
                <dt>Workspace</dt>
                <dd>
                  {tenantLoading ? (
                    <span className="text-[var(--cv-color-text-muted)]">Carregando…</span>
                  ) : tenant !== null ? (
                    tenant.name
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              {tenant !== null ? (
                <div className="sac-kv">
                  <dt>Slug</dt>
                  <dd className="sac-num">{tenant.slug}</dd>
                </div>
              ) : null}
              <div className="sac-kv">
                <dt>ID do operador</dt>
                <dd className="sac-num truncate" title={currentAgent.id}>
                  {currentAgent.id}
                </dd>
              </div>
            </dl>

            {tenantError !== null ? (
              <div className="mt-2">
                <Alert title="Workspace indisponível" tone="warning">
                  {tenantError}
                </Alert>
              </div>
            ) : null}
          </Card>

          <Card
            title="Sessões ativas"
            subtitle="Cada entrada é um refresh token válido para este operador. Revogar um dispositivo encerra o acesso dele imediatamente."
            footer={
              <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                  Encerra esta e todas as outras sessões do operador.
                </span>
                <Button
                  variant="danger"
                  size="sm"
                  icon="close"
                  disabled={endingEverywhere || sessions.length === 0}
                  onClick={() => setConfirmEverywhere(true)}
                >
                  Sair de todos os dispositivos
                </Button>
              </div>
            }
          >
            {sessionsLoading ? (
              <div className="flex flex-col gap-3" aria-busy="true">
                {[0, 1].map((index) => (
                  <div className="flex items-center gap-3" key={index}>
                    <Skeleton className="h-9 w-9" />
                    <div className="flex w-full flex-col gap-2">
                      <Skeleton className="h-4 w-1/3" />
                      <Skeleton className="h-3 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : sessionsError !== null ? (
              <Alert title="Não foi possível carregar as sessões" tone="danger">
                <div className="flex flex-col gap-2">
                  <span>{sessionsError}</span>
                  <div>
                    <Button size="sm" icon="pulse" onClick={retry}>
                      Tentar novamente
                    </Button>
                  </div>
                </div>
              </Alert>
            ) : sessions.length === 0 ? (
              <EmptyState
                icon="devices"
                title="Nenhuma sessão ativa"
                description="Não há refresh tokens válidos para este operador. Entre novamente para abrir uma sessão."
              />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-0 p-0">
                {sessions.map((session) => (
                  <li className="sac-session" key={session.id}>
                    <span className="sac-session__icon" aria-hidden="true">
                      <Icon name="devices" size={18} />
                    </span>
                    <div className="sac-session__body">
                      <div className="sac-session__title">
                        <strong>{describeDevice(session.userAgent)}</strong>
                        {session.current ? <Pill tone="ok">Sessão atual</Pill> : null}
                      </div>
                      <span className="sac-session__meta">
                        Iniciada em {formatDateTime(session.createdAt)} · Último uso{' '}
                        {session.lastUsedAt !== null ? formatDateTime(session.lastUsedAt) : '—'} · IP{' '}
                        <span className="sac-num">{session.ip ?? '—'}</span>
                      </span>
                    </div>
                    {session.current ? (
                      <span className="sac-session__hint">
                        Encerre com <strong>Sair</strong> no menu da conta
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="close"
                        onClick={() => setRevokeTarget(session)}
                      >
                        Revogar
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <p className="m-0 mt-3 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
              Revogar encerra o acesso daquele dispositivo imediatamente. “Sair de todos os
              dispositivos” encerra também esta sessão.
            </p>
          </Card>
        </div>

        <aside className="sac-profile__aside" aria-label="Segurança e ajuda">
          <Card title="Segurança" subtitle="Ações que afetam o seu próximo login.">
            <div className="flex flex-col gap-3">
              <div className="sac-security-row">
                <div className="min-w-0">
                  <p className="m-0 text-[var(--cv-font-control)] font-medium">
                    Verificação em duas etapas
                  </p>
                  <p className="m-0 text-[var(--cv-font-meta)] leading-snug text-[var(--cv-color-text-muted)]">
                    TOTP com códigos de recuperação. Configuração e desativação ficam na área de
                    segurança do workspace.
                  </p>
                </div>
                <Button size="sm" variant="secondary" icon="lock" onClick={() => navigate('/settings')}>
                  Abrir em Configurações
                </Button>
              </div>

              <div className="sac-divider" />

              <div className="sac-security-row">
                <div className="min-w-0">
                  <p className="m-0 text-[var(--cv-font-control)] font-medium">Senha</p>
                  <p className="m-0 text-[var(--cv-font-meta)] leading-snug text-[var(--cv-color-text-muted)]">
                    O link de redefinição é enviado para o seu e-mail e revoga todas as sessões
                    antigas.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="file"
                  onClick={() => navigate('/forgot-password')}
                >
                  Redefinir senha
                </Button>
              </div>

              <div className="sac-divider" />

              <div className="sac-security-row">
                <div className="min-w-0">
                  <p className="m-0 text-[var(--cv-font-control)] font-medium">Sessão neste navegador</p>
                  <p className="m-0 text-[var(--cv-font-meta)] leading-snug text-[var(--cv-color-text-muted)]">
                    Encerra apenas este dispositivo. Para sair de todos, use o botão acima.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  loading={endingCurrent}
                  onClick={() => void endCurrent()}
                >
                  Sair deste navegador
                </Button>
              </div>
            </div>
          </Card>

          <Card title="Ajuda e transparência" subtitle="Caminhos públicos e política de dados.">
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="sac-quiet-link"
                onClick={() => navigate('/status')}
              >
                <Icon name="pulse" size={15} /> Status dos sistemas
              </button>
              <button type="button" className="sac-quiet-link" onClick={() => navigate('/settings')}>
                <Icon name="sliders" size={15} /> Privacidade e LGPD do workspace
              </button>
              <p className="m-0 mt-1 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
                A exportação e a eliminação de dados do workspace são executadas por um ADMIN em
                Configurações, com confirmação e registro de auditoria.
              </p>
            </div>
          </Card>
        </aside>
      </div>

      <ConfirmActionDialog
        open={revokeTarget !== null}
        title="Revogar esta sessão?"
        description={
          revokeTarget !== null
            ? `O dispositivo "${describeDevice(revokeTarget.userAgent)}" perderá o acesso e precisará entrar novamente.`
            : ''
        }
        confirmLabel="Revogar sessão"
        tone="danger"
        loading={revoking}
        onConfirm={() => void handleRevoke()}
        onClose={() => setRevokeTarget(null)}
      >
        <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
          A revogação encerra o acesso imediatamente; o restante do período de validade expira
          sozinho e o dispositivo precisará entrar novamente.
        </p>
      </ConfirmActionDialog>

      <ConfirmActionDialog
        open={confirmEverywhere}
        title="Sair de todos os dispositivos?"
        description="Encerra esta e todas as outras sessões do operador, inclusive a deste navegador."
        confirmLabel="Sair de todos"
        tone="danger"
        loading={endingEverywhere}
        onConfirm={() => {
          setConfirmEverywhere(false);
          void endEverywhere();
        }}
        onClose={() => setConfirmEverywhere(false)}
      >
        <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
          Você será levado para o login. Todos os dispositivos precisarão autenticar novamente,
          inclusive este navegador.
        </p>
      </ConfirmActionDialog>
    </div>
  );
}
