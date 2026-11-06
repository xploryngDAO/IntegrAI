import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '@xploryng/convergencia';
import { api, ApiClientError } from '../lib/api';
import { useWorkspace } from '../lib/store';
import { clearOnboardingDismissal } from '../lib/onboarding';
import { isTenantAdmin } from '../lib/platform';
import type { TenantProfile } from '../lib/types';
import { formatDateTime } from '../lib/labels';
import { Alert, Button, Card, EmptyState, Skeleton } from '../components/ui';
import { DeleteWorkspaceDialog } from '../components/settings/DeleteWorkspaceDialog';
import { CorporateAuthCard } from '../components/settings/CorporateAuthCard';
import { RecoveryCodesCard } from '../components/settings/RecoveryCodesCard';
import { TwoFactorCard } from '../components/settings/TwoFactorCard';
import { TwoFactorPolicyCard } from '../components/settings/TwoFactorPolicyCard';

function settingsErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 403) {
      return 'Sua conta não tem permissão para ler os dados deste workspace.';
    }
    if (error.status === 0) return error.message;
    return `${error.message} (HTTP ${error.status})`;
  }
  return error instanceof Error && error.message
    ? error.message
    : 'Não foi possível falar com a API. Tente novamente.';
}

/**
 * Discreet footer of the settings surface. `/status` is a public page (outside
 * the session gate), so it stays reachable even when the workspace API fails.
 */
function StatusFooter(): JSX.Element {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--cv-color-border)] pt-4 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
      <span>SAC Hub · Central de atendimento omnichannel</span>
      <Link
        to="/status"
        className="underline-offset-2 hover:text-[var(--cv-color-text)] hover:underline"
      >
        Status dos sistemas
      </Link>
    </footer>
  );
}

/**
 * `/settings` — workspace administration for the tenant ADMIN (Fase 4).
 *
 * Sections: real tenant identity (`GET /tenants/me`), a re-runnable onboarding,
 * the LGPD export (`GET /tenants/me/export` → JSON download) and the danger zone
 * (`DELETE /tenants/me` with password + slug, then logout and `/login`).
 *
 * The API re-checks every privileged call; the page also hides destructive
 * controls from non-ADMIN operators.
 */
export function SettingsPage(): JSX.Element {
  const navigate = useNavigate();
  const currentAgent = useWorkspace((state) => state.currentAgent);
  const pushToast = useWorkspace((state) => state.pushToast);

  const [profile, setProfile] = useState<TenantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const retry = useCallback((): void => {
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let active = true;

    async function loadProfile(): Promise<void> {
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.tenantProfile();
        if (active) setProfile(result);
      } catch (error) {
        if (!active) return;
        setProfile(null);
        setLoadError(settingsErrorMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadProfile();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const restricted = currentAgent !== null && !isTenantAdmin(currentAgent);

  const rerunOnboarding = useCallback((): void => {
    if (currentAgent) clearOnboardingDismissal(currentAgent);
    pushToast({
      tone: 'info',
      title: 'Onboarding reaberto',
      description: 'Refaça o guia sem alterar os dados do workspace.',
    });
    navigate('/onboarding');
  }, [currentAgent, navigate, pushToast]);

  async function handleExport(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const data = await api.exportTenantData();
      if (data === null || data === undefined) {
        throw new Error('A API respondeu sem os dados da exportação.');
      }
      const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      const blob = new Blob([serialized], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const slug = (profile?.slug ?? 'workspace').replace(/[^a-z0-9-]+/gi, '-');
      anchor.href = url;
      anchor.download = `${slug}-dados-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      pushToast({
        tone: 'ok',
        title: 'Exportação concluída',
        description: 'O download do JSON com os dados do workspace começou.',
      });
    } catch (error) {
      setExportError(settingsErrorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  if (restricted) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
        <PageHeader
          eyebrow="Workspace"
          title="Configurações"
          description="Dados do workspace, portabilidade e eliminação de dados."
        />
        <Card>
          <EmptyState
            icon="lock"
            title="Acesso restrito"
            description="Somente um ADMIN do workspace pode alterar configurações, exportar ou excluir os dados do tenant. Peça a um administrador para elevar o seu papel."
            action={
              <Button variant="primary" icon="arrow" onClick={() => navigate('/', { replace: false })}>
                Voltar para a fila
              </Button>
            }
          />
        </Card>
        <StatusFooter />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <PageHeader
        eyebrow="Workspace"
        title="Configurações"
        description="Identidade do workspace, segurança do login e as ações de privacidade previstas na LGPD."
        actions={
          <Button variant="secondary" icon="pulse" loading={loading} onClick={retry}>
            Atualizar
          </Button>
        }
      />

      <Card
        title="Dados do workspace"
        subtitle="Identidade do workspace autenticado: nome, slug e ID do tenant."
      >
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : loadError !== null ? (
          <Alert title="Não foi possível carregar o workspace" tone="danger">
            <div className="flex flex-col gap-2">
              <span>{loadError}</span>
              <div>
                <Button size="sm" icon="pulse" onClick={retry}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </Alert>
        ) : profile !== null ? (
          <div className="flex flex-col gap-3">
            <dl className="m-0 flex flex-col gap-1.5">
              <div className="sac-kv">
                <dt>Nome</dt>
                <dd>{profile.name}</dd>
              </div>
              <div className="sac-kv">
                <dt>Slug</dt>
                <dd className="sac-num">{profile.slug}</dd>
              </div>
              <div className="sac-kv">
                <dt>ID do tenant</dt>
                <dd className="sac-num truncate" title={profile.id}>
                  {profile.id}
                </dd>
              </div>
              <div className="sac-kv">
                <dt>Onboarding</dt>
                <dd>
                  {profile.onboardingCompletedAt
                    ? `Concluído em ${formatDateTime(profile.onboardingCompletedAt)}`
                    : 'Pendente'}
                </dd>
              </div>
            </dl>

            <div className="sac-divider" />

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="m-0 text-[var(--cv-font-control)] font-medium">Onboarding guiado</p>
                <p className="m-0 text-[var(--cv-font-meta)] leading-snug text-[var(--cv-color-text-muted)]">
                  Reabra o guia de conexão de canais e primeiro atendimento. Nenhum dado é apagado.
                </p>
              </div>
              <Button variant="secondary" icon="spark" onClick={rerunOnboarding}>
                Reexecutar onboarding
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="workspace-security-heading">
        <div>
          <h2
            id="workspace-security-heading"
            className="m-0 text-[var(--cv-font-section)] font-semibold leading-[var(--cv-font-line-heading)]"
          >
            Segurança do workspace
          </h2>
          <p className="m-0 mt-1 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Política aplicada pela API a todos os operadores deste tenant. Só um ADMIN do workspace
            pode ler ou alterar; o login corporativo (SSO) fica isento.
          </p>
        </div>

        {/* The whole page is ADMIN-only (early return above); the API re-checks
            the role on GET/PATCH /tenants/me. */}
        <TwoFactorPolicyCard />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="security-heading">
        <div>
          <h2
            id="security-heading"
            className="m-0 text-[var(--cv-font-section)] font-semibold leading-[var(--cv-font-line-heading)]"
          >
            Segurança
          </h2>
          <p className="m-0 mt-1 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Segundo fator do login do operador autenticado. A configuração vale para os próximos
            acessos, em qualquer navegador, e é aplicada pela API a cada login.
          </p>
        </div>

        <TwoFactorCard />
        <RecoveryCodesCard />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="corporate-auth-heading">
        <div>
          <h2
            id="corporate-auth-heading"
            className="m-0 text-[var(--cv-font-section)] font-semibold leading-[var(--cv-font-line-heading)]"
          >
            Autenticação corporativa
          </h2>
          <p className="m-0 mt-1 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Login com Microsoft Entra ID (OIDC) para toda a equipe do workspace. A configuração é
            aplicada pela API a cada tentativa de login e vale apenas para este tenant.
          </p>
        </div>

        <CorporateAuthCard />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="lgpd-heading">
        <div>
          <h2
            id="lgpd-heading"
            className="m-0 text-[var(--cv-font-section)] font-semibold leading-[var(--cv-font-line-heading)]"
          >
            Privacidade e LGPD
          </h2>
          <p className="m-0 mt-1 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Direitos do titular: acesso e portabilidade dos dados do workspace e eliminação
            definitiva. As duas ações abaixo falam com a API real e são restritas a ADMIN.
          </p>
        </div>

        <Card
          title="Exportar dados"
          subtitle="Baixe um JSON com os dados mantidos para este workspace."
        >
          <div className="flex flex-col gap-3">
            <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
              O arquivo é gerado pela API no momento do pedido e inclui os registros do tenant
              autenticado. Guarde-o em local seguro: o conteúdo pode conter dados de operadores e
              histórico de atendimento.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                icon="file"
                loading={exporting}
                onClick={() => void handleExport()}
              >
                Exportar dados
              </Button>
              <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                Download imediato do JSON
              </span>
            </div>
            {exportError !== null ? (
              <Alert title="Não foi possível exportar os dados" tone="danger">
                {exportError}
              </Alert>
            ) : null}
          </div>
        </Card>

        <Card
          title="Zona de perigo"
          subtitle="Exclusão definitiva do workspace e dos dados associados."
          className="sac-card--danger"
        >
          <div className="flex flex-col gap-3">
            <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
              Excluir o workspace desativa o acesso imediatamente e agenda a eliminação de contas
              conectadas, agentes, tickets e mensagens. A operação exige a sua senha e o slug exato
              do tenant, encerra a sessão atual e não pode ser desfeita.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="danger"
                icon="close"
                disabled={profile === null}
                onClick={() => setDeleteOpen(true)}
              >
                Excluir workspace
              </Button>
              {profile === null ? (
                <span className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                  Carregue os dados do workspace para liberar a exclusão.
                </span>
              ) : null}
            </div>
          </div>
        </Card>
      </section>

      <StatusFooter />

      {deleteOpen && profile !== null ? (
        <DeleteWorkspaceDialog tenant={profile} onClose={() => setDeleteOpen(false)} />
      ) : null}
    </div>
  );
}
