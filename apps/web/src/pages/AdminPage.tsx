import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Tabs } from '@xploryng/convergencia';
import { useWorkspace } from '../lib/store';
import { isTenantAdmin } from '../lib/platform';
import { roleLabel } from '../lib/admin';
import { Button, Card, EmptyState, Skeleton } from '../components/ui';
import { AdminInvitationsTab } from '../components/admin/AdminInvitationsTab';
import { AdminLogsTab } from '../components/admin/AdminLogsTab';
import { AdminUsersTab } from '../components/admin/AdminUsersTab';

type AdminTab = 'users' | 'invitations' | 'logs';

const ADMIN_TABS: readonly AdminTab[] = ['users', 'invitations', 'logs'];

/** Keeps the tab value inside the union (Radix hands back a plain string). */
function asAdminTab(value: string): AdminTab {
  return ADMIN_TABS.includes(value as AdminTab) ? (value as AdminTab) : 'users';
}

/**
 * `/admin` — workspace administration for the tenant ADMIN.
 *
 * Three tabs share one page:
 *  - **Usuários**: the operator roster with server-side filters (name/e-mail,
 *    role, status), server-side pagination and the CSV export of the applied
 *    filters, plus the role/activation/session-revoke actions and the invitation
 *    CTA (`GET|PATCH /admin/users`, `POST /admin/users/:id/revoke-sessions`,
 *    `GET /admin/users/export.csv`, `POST /invitations`);
 *  - **Convites**: pending/accepted/expired invitations with revoke for PENDING
 *    rows and re-send for PENDING/EXPIRED rows, never ACCEPTED
 *    (`GET|DELETE /admin/invitations`, `POST /admin/invitations/:id/resend`);
 *  - **Logs**: the administrative audit trail with action/actor/period filters,
 *    server-side pagination and the CSV export of the applied filters
 *    (`GET /admin/audit-logs`, `GET /admin/audit-logs/export.csv`).
 *
 * Each tab owns its own reads: the page only coordinates the header refresh and
 * the access-restricted state. The API is the real guard. A 403 anywhere (or a
 * role that is not ADMIN) renders the access-restricted state instead of a
 * broken screen; the page never retries a forbidden call in a loop.
 */
export function AdminPage(): JSX.Element {
  const navigate = useNavigate();
  const currentAgent = useWorkspace((state) => state.currentAgent);

  const [tab, setTab] = useState<AdminTab>('users');
  const [reloadKey, setReloadKey] = useState(0);
  const [forbidden, setForbidden] = useState(false);
  const [usersBusy, setUsersBusy] = useState(false);

  const isAdmin = currentAgent !== null && isTenantAdmin(currentAgent);
  const restricted = forbidden || (currentAgent !== null && !isAdmin);

  const handleForbidden = useCallback((): void => {
    setForbidden(true);
  }, []);

  /** Header "Atualizar": every mounted tab reloads and keeps its own state. */
  const retry = useCallback((): void => {
    setReloadKey((key) => key + 1);
  }, []);

  if (currentAgent === null) {
    // The identity is still being resolved (fresh login): do not flash the
    // restricted state before the role is known.
    return (
      <div className="sac-page flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
        <PageHeader
          eyebrow="Administração"
          title="Equipe e auditoria"
          description="Carregando o seu acesso…"
        />
        <Card>
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        </Card>
      </div>
    );
  }

  if (restricted) {
    return (
      <div className="sac-page flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
        <PageHeader
          eyebrow="Administração"
          title="Equipe e auditoria"
          description="Gestão de usuários e trilha de auditoria do workspace."
        />
        <Card>
          <EmptyState
            icon="lock"
            title="Acesso restrito"
            description={
              forbidden
                ? 'A API recusou o acesso à administração (HTTP 403). Se isso não for esperado, peça a um ADMIN do workspace para revisar o seu papel.'
                : `Somente um ADMIN do workspace acessa esta área. Seu papel atual é ${roleLabel(
                    currentAgent?.role,
                  )}. Peça a um administrador para elevar o seu acesso.`
            }
            action={
              <Button variant="primary" icon="arrow" onClick={() => navigate('/', { replace: false })}>
                Voltar para a fila
              </Button>
            }
          />
        </Card>
        <p className="m-0 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          A API revalida o papel em cada chamada de <span className="sac-num">/admin/*</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="sac-page flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <PageHeader
        eyebrow="Administração"
        title="Equipe e auditoria"
        description="Gerencie quem acessa o workspace, o papel de cada operador e o registro das ações administrativas."
        actions={
          <Button variant="secondary" icon="pulse" loading={usersBusy} onClick={retry}>
            Atualizar
          </Button>
        }
      />

      <Tabs
        label="Seções da administração"
        value={tab}
        onValueChange={(value) => setTab(asAdminTab(value))}
        items={[
          {
            value: 'users',
            label: 'Usuários',
            content: (
              <AdminUsersTab
                currentAgentId={currentAgent?.id ?? null}
                refreshKey={reloadKey}
                onBusyChange={setUsersBusy}
                onForbidden={handleForbidden}
              />
            ),
          },
          {
            value: 'invitations',
            label: 'Convites',
            content: (
              <AdminInvitationsTab onForbidden={handleForbidden} refreshKey={reloadKey} />
            ),
          },
          {
            value: 'logs',
            label: 'Logs',
            content: <AdminLogsTab onForbidden={handleForbidden} refreshKey={reloadKey} />,
          },
        ]}
      />
    </div>
  );
}
