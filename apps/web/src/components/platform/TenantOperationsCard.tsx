/**
 * "Operações" of one tenant in the platform console.
 *
 * Everything here is a platform-admin action re-checked by the API:
 *
 *   POST   /platform/tenants/:id/backup   create a JSON artifact in S3
 *   GET    /platform/tenants/:id/backups  the 5 most recent artifacts
 *   DELETE /platform/tenants/:id          soft delete (revokes sessions, no password)
 *   POST   /platform/tenants/:id/purge    physical LGPD purge (only after DELETED)
 *
 * The delete confirmation asks for the workspace slug and the purge asks for
 * `PURGAR`; neither is a single click. Delete and purge are separate steps by
 * design — the delete dialog never purges. Feedback is rendered through the
 * Convergência `Alert` (role="alert" for danger, role="status" otherwise), and
 * every dialog keeps the server message visible instead of guessing.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { formatFileSize } from '../../lib/format';
import { formatDateTime } from '../../lib/labels';
import {
  backupCountSummary,
  backupErrorMessage,
  isForbiddenError,
  platformDeleteErrorMessage,
  purgeCountEntries,
  purgeErrorMessage,
  tenantBackupsErrorMessage,
  tenantStatusLabel,
  type PlatformCountEntry,
} from '../../lib/platform';
import type {
  PlatformTenantBackup,
  PlatformTenantDeleteResult,
  PlatformTenantPurgeResult,
} from '../../lib/types';
import { useWorkspace } from '../../lib/store';
import { Alert, Button, Card, Skeleton } from '../ui';
import { TenantDeleteDialog } from './TenantDeleteDialog';
import { TenantPurgeDialog } from './TenantPurgeDialog';

/** `GET …/backups` keeps the whole index; the drawer renders the latest ones. */
const RECENT_BACKUPS_LIMIT = 5;

/** Touch target token (44px) on top of the DS control height. */
const TOUCH_TARGET = 'min-h-[var(--cv-size-touch)]';

function backupSizeLabel(size: number | null): string {
  return size === null ? 'tamanho não informado' : formatFileSize(size);
}

function statusIsDeleted(status: string | null | undefined): boolean {
  return (status ?? '').trim().toUpperCase() === 'DELETED';
}

function PurgeCountsList({ entries }: { entries: PlatformCountEntry[] }): JSX.Element {
  if (entries.length === 0) {
    return (
      <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
        A API não devolveu as contagens da purga; consulte a lista de tenants para confirmar que o
        workspace não existe mais.
      </p>
    );
  }

  return (
    <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
      {entries.map((entry) => (
        <div
          key={entry.key}
          className="flex min-w-0 items-baseline justify-between gap-2 border-b border-[var(--cv-color-border)] pb-1"
        >
          <dt className="min-w-0 break-words text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            {entry.label}
          </dt>
          <dd className="sac-num m-0 flex-none text-[var(--cv-font-meta)] font-semibold">
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface TenantOperationsCardProps {
  tenantId: string;
  /** Display name used in the confirmations (`name (slug)` when available). */
  tenantName: string;
  /** Exact slug the operator must type to confirm the soft delete. */
  slug: string;
  /** Status of the open detail (local state updated after the soft delete). */
  status: string | null;
  /** Reports the status acknowledged by the API so the drawer/purge react. */
  onStatusChange: (status: string) => void;
  /** A destructive mutation succeeded: refresh the console list/counters. */
  onChanged: () => void;
  /** 403 anywhere: the page takes over with its own "sem permissão" state. */
  onForbidden: () => void;
}

export function TenantOperationsCard({
  tenantId,
  tenantName,
  slug,
  status,
  onStatusChange,
  onChanged,
  onForbidden,
}: TenantOperationsCardProps): JSX.Element {
  const pushToast = useWorkspace((store) => store.pushToast);

  const [backups, setBackups] = useState<PlatformTenantBackup[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [backupsError, setBackupsError] = useState<string | null>(null);
  const [backupsReloadKey, setBackupsReloadKey] = useState(0);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [backupResult, setBackupResult] = useState<PlatformTenantBackup | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteResult, setDeleteResult] = useState<PlatformTenantDeleteResult | null>(null);

  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeError, setPurgeError] = useState<string | null>(null);
  const [purgeResult, setPurgeResult] = useState<PlatformTenantPurgeResult | null>(null);

  const deleted = statusIsDeleted(status);
  const purged = purgeResult !== null;

  useEffect(() => {
    let active = true;

    async function loadBackups(): Promise<void> {
      setBackupsLoading(true);
      setBackupsError(null);
      try {
        const rows = await api.listPlatformTenantBackups(tenantId);
        if (active) setBackups(rows);
      } catch (error) {
        if (!active) return;
        if (isForbiddenError(error)) {
          onForbidden();
          return;
        }
        setBackups([]);
        setBackupsError(tenantBackupsErrorMessage(error));
      } finally {
        if (active) setBackupsLoading(false);
      }
    }

    void loadBackups();
    return () => {
      active = false;
    };
  }, [tenantId, backupsReloadKey, onForbidden]);

  async function handleCreateBackup(): Promise<void> {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    setBackupResult(null);
    try {
      const result = await api.createPlatformTenantBackup(tenantId);
      setBackupResult(result);
      // Re-read the index instead of prepending locally: the API is the source
      // of truth for the artifact id/key and the list stays newest-first.
      setBackupsReloadKey((key) => key + 1);
    } catch (error) {
      if (isForbiddenError(error)) {
        onForbidden();
        return;
      }
      setCreateError(backupErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await api.deletePlatformTenant(tenantId);
      const nextStatus = (result.status ?? 'DELETED').trim().toUpperCase() || 'DELETED';
      setDeleteResult(result);
      setDeleteOpen(false);
      onStatusChange(nextStatus);
      pushToast({
        tone: 'ok',
        title: 'Workspace excluído',
        description: `${tenantName} foi marcado como ${nextStatus}. A purga física é um passo separado.`,
      });
      onChanged();
    } catch (error) {
      if (isForbiddenError(error)) {
        onForbidden();
        return;
      }
      // 409 TENANT_ALREADY_DELETED keeps the dialog open with the real reason;
      // the operator then closes it and refreshes the list.
      setDeleteError(platformDeleteErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  async function handlePurge(): Promise<void> {
    if (purging) return;
    setPurging(true);
    setPurgeError(null);
    try {
      const result = await api.purgePlatformTenant(tenantId);
      setPurgeResult(result);
      setPurgeOpen(false);
      pushToast({
        tone: 'ok',
        title: 'Workspace purgado',
        description: `${tenantName} teve os dados físicos removidos.`,
      });
      onChanged();
    } catch (error) {
      if (isForbiddenError(error)) {
        onForbidden();
        return;
      }
      setPurgeError(purgeErrorMessage(error));
    } finally {
      setPurging(false);
    }
  }

  return (
    <Card
      title="Operações"
      subtitle="Backup, exclusão e purga deste workspace. Ações de platform admin: a API revalida a permissão em cada chamada."
    >
      <div className="mt-3 flex flex-col gap-4">
        {/* ------------------------------------------------------------ backup */}
        <section className="flex flex-col gap-2" aria-labelledby="tenant-backup-heading">
          <div className="flex flex-col gap-1">
            <h4
              id="tenant-backup-heading"
              className="m-0 text-[var(--cv-font-body)] font-semibold"
            >
              Backup do workspace
            </h4>
            <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
              Grava um JSON com os dados operacionais do workspace no storage da plataforma.
              Credenciais, tokens e dados restritos de comprador não entram no arquivo.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              icon="file"
              loading={creating}
              disabled={creating}
              className={TOUCH_TARGET}
              onClick={() => void handleCreateBackup()}
            >
              Criar backup
            </Button>
            {creating ? (
              <span
                role="status"
                className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]"
              >
                Coletando os dados e gravando o backup…
              </span>
            ) : null}
          </div>

          {createError !== null ? (
            <Alert title="Não foi possível criar o backup" tone="danger">
              {createError}
            </Alert>
          ) : null}

          {backupResult !== null ? (
            <Alert
              title={backupResult.backupKey !== null ? 'Backup criado' : 'Backup sem chave na resposta'}
              tone={backupResult.backupKey !== null ? 'success' : 'warning'}
            >
              <div className="flex flex-col gap-1">
                <span className="sac-num break-all text-[var(--cv-font-meta)]">
                  {backupResult.backupKey !== null
                    ? backupResult.backupKey
                    : 'A API confirmou a criação, mas não devolveu a backupKey. Confira a lista de backups recentes.'}
                </span>
                <span className="break-words text-[var(--cv-font-meta)]">
                  Tamanho: {backupSizeLabel(backupResult.sizeBytes)}
                  {backupResult.createdAt !== null
                    ? ` · Criado em ${formatDateTime(backupResult.createdAt)}`
                    : ''}
                </span>
                <span className="break-words text-[var(--cv-font-meta)]">
                  Contagens: {backupCountSummary(backupResult.counts)}
                </span>
              </div>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h5 className="m-0 text-[var(--cv-font-meta)] font-semibold">
                Backups recentes
              </h5>
              <Button
                variant="ghost"
                icon="pulse"
                loading={backupsLoading}
                className={TOUCH_TARGET}
                onClick={() => setBackupsReloadKey((key) => key + 1)}
              >
                Atualizar backups
              </Button>
            </div>

            {backupsLoading ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                {[0, 1].map((index) => (
                  <Skeleton key={index} className="h-3 w-full" />
                ))}
              </div>
            ) : backupsError !== null ? (
              <Alert title="Não foi possível carregar os backups" tone="danger">
                <div className="flex flex-col gap-2">
                  <span>{backupsError}</span>
                  <div>
                    <Button
                      variant="secondary"
                      icon="pulse"
                      className={TOUCH_TARGET}
                      onClick={() => setBackupsReloadKey((key) => key + 1)}
                    >
                      Tentar novamente
                    </Button>
                  </div>
                </div>
              </Alert>
            ) : backups.length === 0 ? (
              <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
                Nenhum backup registrado para este workspace. O primeiro backup criado aparece aqui.
              </p>
            ) : (
              <>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {backups.slice(0, RECENT_BACKUPS_LIMIT).map((backup, index) => (
                    <li
                      key={backup.id ?? backup.backupKey ?? `backup-${index}`}
                      className="flex min-w-0 flex-col gap-1 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-2 py-1.5"
                    >
                      <span className="sac-num break-all text-[var(--cv-font-meta)]">
                        {backup.backupKey ?? '—'}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                        <span className="sac-num">{formatDateTime(backup.createdAt)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{backupSizeLabel(backup.sizeBytes)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {backups.length > RECENT_BACKUPS_LIMIT ? (
                  <p className="m-0 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                    Mostrando os {RECENT_BACKUPS_LIMIT} backups mais recentes de {backups.length}.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </section>

        <hr className="m-0 border-0 border-t border-[var(--cv-color-border)]" />

        {/* ------------------------------------------------------------ delete */}
        <section className="flex flex-col gap-2" aria-labelledby="tenant-delete-heading">
          <div className="flex flex-col gap-1">
            <h4
              id="tenant-delete-heading"
              className="m-0 text-[var(--cv-font-body)] font-semibold"
            >
              Excluir workspace
            </h4>
            <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
              Exclusão lógica pela plataforma: encerra as sessões ativas, marca o workspace como
              DELETED e agenda a purga física. Não pede a senha do workspace — a confirmação é o
              slug exato.
            </p>
          </div>

          {deleteResult !== null ? (
            <Alert title="Exclusão lógica concluída" tone="success">
              <div className="flex flex-col gap-1">
                <span className="break-words text-[var(--cv-font-meta)]">
                  {deleteResult.slug ?? slug} está com status{' '}
                  <strong>{deleteResult.status ?? 'DELETED'}</strong>
                  {deleteResult.deletedAt !== null
                    ? ` desde ${formatDateTime(deleteResult.deletedAt)}`
                    : ''}
                  . Sessões ativas foram encerradas.
                </span>
                {deleteResult.purge.scheduled === true ? (
                  <span className="break-words text-[var(--cv-font-meta)]">
                    Purga automática agendada.
                  </span>
                ) : deleteResult.purge.scheduled === false ? (
                  <span className="break-words text-[var(--cv-font-meta)]">
                    A API não agendou a purga automática.
                  </span>
                ) : null}
                {deleteResult.purge.note !== null ? (
                  <span className="break-words text-[var(--cv-font-meta)]">
                    {deleteResult.purge.note}
                  </span>
                ) : null}
              </div>
            </Alert>
          ) : deleted ? (
            <Alert title="Workspace já excluído" tone="success">
              O status deste workspace é DELETED. A exclusão lógica já foi feita; a próxima etapa
              disponível é a purga física, abaixo.
            </Alert>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="danger"
                icon="close"
                className={TOUCH_TARGET}
                onClick={() => {
                  setDeleteError(null);
                  setDeleteOpen(true);
                }}
              >
                Excluir workspace
              </Button>
              <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                A confirmação exige digitar o slug do workspace.
              </span>
            </div>
          )}

          <p className="m-0 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
            Status atual: {tenantStatusLabel(status)}.
          </p>
        </section>

        <hr className="m-0 border-0 border-t border-[var(--cv-color-border)]" />

        {/* ------------------------------------------------------------- purge */}
        <section className="flex flex-col gap-2" aria-labelledby="tenant-purge-heading">
          <div className="flex flex-col gap-1">
            <h4
              id="tenant-purge-heading"
              className="m-0 text-[var(--cv-font-body)] font-semibold"
            >
              Purgar definitivamente
            </h4>
            <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
              Remove fisicamente as linhas do workspace e os objetos no storage. É irreversível e
              não tem relação com a exclusão lógica.
            </p>
          </div>

          {purged ? (
            <Alert title="Purga concluída" tone="success">
              <div className="flex flex-col gap-2">
                <span className="break-words text-[var(--cv-font-meta)]">
                  {purgeResult.slug ?? slug} foi purgado
                  {purgeResult.purgedAt !== null
                    ? ` em ${formatDateTime(purgeResult.purgedAt)}`
                    : ''}
                  . Objetos no storage removidos: {purgeResult.s3ObjectsDeleted ?? '—'}
                  {purgeResult.s3Failed !== null && purgeResult.s3Failed > 0
                    ? ` · falhas: ${purgeResult.s3Failed}`
                    : ''}
                  .
                </span>
                <PurgeCountsList entries={purgeCountEntries(purgeResult.counts)} />
              </div>
            </Alert>
          ) : deleted ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="danger"
                icon="tool"
                className={TOUCH_TARGET}
                onClick={() => {
                  setPurgeError(null);
                  setPurgeOpen(true);
                }}
              >
                Purgar definitivamente
              </Button>
              <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
                Confirmação extra: digitar PURGAR.
              </span>
            </div>
          ) : (
            <Alert title="Purga indisponível" tone="warning">
              A purga física só pode rodar depois da exclusão lógica. O status atual é{' '}
              <strong>{tenantStatusLabel(status)}</strong>; exclua o workspace primeiro e volte a
              este painel para purgar.
            </Alert>
          )}
        </section>
      </div>

      {deleteOpen ? (
        <TenantDeleteDialog
          tenantName={tenantName}
          slug={slug}
          error={deleteError}
          deleting={deleting}
          onCancel={() => {
            if (deleting) return;
            setDeleteOpen(false);
            setDeleteError(null);
          }}
          onConfirm={() => void handleDelete()}
        />
      ) : null}

      {purgeOpen ? (
        <TenantPurgeDialog
          tenantName={tenantName}
          error={purgeError}
          purging={purging}
          onCancel={() => {
            if (purging) return;
            setPurgeOpen(false);
            setPurgeError(null);
          }}
          onConfirm={() => void handlePurge()}
        />
      ) : null}
    </Card>
  );
}
