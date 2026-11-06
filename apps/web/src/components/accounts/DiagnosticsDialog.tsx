import type {
  AccountDiagnosis,
  DiagnosisCheck,
  DiagnosisStatus,
  SystemDiagnosis,
} from '@sac/shared';
import { Icon, type IconName } from '@xploryng/convergencia';
import { formatDateTime } from '../../lib/labels';
import { Alert, Button, MarketplaceBadge, Modal, Pill, Spinner, type PillTone } from '../ui';

/* --------------------------------------------------------------------------
 * Status mapping shared by the account and system diagnostics dialogs.
 * ------------------------------------------------------------------------ */

const STATUS_LABEL: Record<DiagnosisStatus, string> = {
  ok: 'OK',
  warn: 'Atenção',
  fail: 'Falha',
  skipped: 'Ignorado',
};

const STATUS_TONE: Record<DiagnosisStatus, PillTone> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'danger',
  skipped: 'neutral',
};

const STATUS_ICON: Record<DiagnosisStatus, IconName> = {
  ok: 'check',
  warn: 'bell',
  fail: 'close',
  skipped: 'pause',
};

function StatusPill({ status }: { status: DiagnosisStatus }): JSX.Element {
  return (
    <Pill tone={STATUS_TONE[status]}>
      <span className="inline-flex items-center gap-1">
        <Icon name={STATUS_ICON[status]} size={11} />
        {STATUS_LABEL[status]}
      </span>
    </Pill>
  );
}

function CheckRow({ check }: { check: DiagnosisCheck }): JSX.Element {
  const needsAction = check.status === 'fail' || check.status === 'warn';
  return (
    <li className="flex flex-col gap-1 border-t border-[var(--cv-color-border)] py-2.5 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusPill status={check.status} />
        <strong className="min-w-0 truncate text-[var(--cv-font-meta)] font-medium">{check.label}</strong>
        <span className="ml-auto inline-flex flex-none items-center gap-2 text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          {typeof check.latencyMs === 'number' ? (
            <span className="sac-num" title="Latência da chamada">
              {Math.round(check.latencyMs)} ms
            </span>
          ) : null}
          <span className="sac-num" title="Identificador do check">
            {check.id}
          </span>
        </span>
      </div>
      <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
        {check.detail}
      </p>
      {needsAction && check.remediation ? (
        <p
          className="m-0 flex items-start gap-1.5 text-[var(--cv-font-micro)] leading-snug"
          style={{ color: 'var(--cv-color-warning)' }}
        >
          <Icon name="tool" size={12} style={{ marginTop: 1, flex: 'none' }} />
          {check.remediation}
        </p>
      ) : null}
    </li>
  );
}

function CheckList({ checks }: { checks: DiagnosisCheck[] }): JSX.Element {
  if (checks.length === 0) {
    return (
      <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
        Nenhum check executado para este alvo.
      </p>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {checks.map((check) => (
        <CheckRow key={check.id} check={check} />
      ))}
    </ul>
  );
}

function TestedAt({ iso }: { iso: string }): JSX.Element {
  return (
    <span className="text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
      Testado em <span className="sac-num">{formatDateTime(iso)}</span>
    </span>
  );
}

function AccountResult({ diagnosis }: { diagnosis: AccountDiagnosis }): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <MarketplaceBadge marketplace={diagnosis.marketplace} compact />
        <strong className="text-[var(--cv-font-meta)]">{diagnosis.displayName}</strong>
        <StatusPill status={diagnosis.overall} />
        <TestedAt iso={diagnosis.testedAt} />
      </div>

      {diagnosis.overall === 'fail' ? (
        <Alert tone="danger" title="Canal reprovado no diagnóstico">
          Corrija os checks com falha antes de operar este canal — envio e sincronização podem estar
          indisponíveis.
        </Alert>
      ) : null}
      {diagnosis.overall === 'warn' ? (
        <Alert tone="warning" title="Canal opera com avisos">
          Os checks abaixo passaram parcialmente; revise as remediações para evitar falhas de envio.
        </Alert>
      ) : null}

      <section className="flex flex-col gap-1.5" aria-label="Checks do canal">
        <h3 className="sac-label m-0">Checks · {diagnosis.checks.length}</h3>
        <CheckList checks={diagnosis.checks} />
      </section>
    </div>
  );
}

function SystemResult({ diagnosis }: { diagnosis: SystemDiagnosis }): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={diagnosis.overall} />
        <TestedAt iso={diagnosis.testedAt} />
        <span className="sac-num text-[var(--cv-font-micro)] text-[var(--cv-color-text-muted)]">
          versão {diagnosis.version}
        </span>
      </div>

      {diagnosis.overall === 'fail' ? (
        <Alert tone="danger" title="Diagnóstico global com falhas">
          Há checks de infraestrutura ou de canal falhando; corrija antes de operar o atendimento.
        </Alert>
      ) : null}
      {diagnosis.overall === 'warn' ? (
        <Alert tone="warning" title="Diagnóstico global com avisos">
          O sistema responde, mas há checks em atenção. Veja as remediações por canal.
        </Alert>
      ) : null}

      <section className="flex flex-col gap-1.5" aria-label="Infraestrutura">
        <h3 className="sac-label m-0">Infraestrutura · {diagnosis.infrastructure.length}</h3>
        <CheckList checks={diagnosis.infrastructure} />
      </section>

      <section className="flex flex-col gap-2" aria-label="Canais">
        <h3 className="sac-label m-0">Canais · {diagnosis.channels.length}</h3>
        {diagnosis.channels.length === 0 ? (
          <p className="m-0 text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
            Nenhuma conta cadastrada neste workspace.
          </p>
        ) : (
          diagnosis.channels.map((channel) => (
            <div
              key={channel.accountId}
              className="rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] p-3"
            >
              <header className="mb-1.5 flex flex-wrap items-center gap-2">
                <MarketplaceBadge marketplace={channel.marketplace} compact />
                <strong className="min-w-0 truncate text-[var(--cv-font-meta)]">
                  {channel.displayName}
                </strong>
                <StatusPill status={channel.overall} />
                <span className="ml-auto">
                  <TestedAt iso={channel.testedAt} />
                </span>
              </header>
              <CheckList checks={channel.checks} />
            </div>
          ))
        )}
      </section>
    </div>
  );
}

type AccountDialogProps = {
  mode: 'account';
  data: AccountDiagnosis | null;
  accountId: string;
  accountName: string;
};

type SystemDialogProps = {
  mode: 'system';
  data: SystemDiagnosis | null;
};

export type DiagnosticsDialogProps = {
  open: boolean;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
} & (AccountDialogProps | SystemDialogProps);

/**
 * Real integration diagnostics (docs/API_CONTRACT.md §9). One dialog for both
 * entry points: a single channel (`POST /accounts/:id/diagnose`) or the whole
 * system (`GET /diagnostics`). Never sends anything to buyers.
 */
export function DiagnosticsDialog(props: DiagnosticsDialogProps): JSX.Element {
  const { open, loading, error, onClose, onRetry, mode, data } = props;

  const title =
    mode === 'account' ? `Diagnóstico · ${props.accountName}` : 'Diagnóstico dos canais';
  const description =
    mode === 'account'
      ? 'Teste real de conexão com o marketplace desta conta. Nada é enviado ao comprador.'
      : 'Teste real de infraestrutura e canais. Nada é enviado ao comprador.';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>
            Fechar
          </Button>
          <Button variant="secondary" icon="pulse" loading={loading} onClick={onRetry}>
            {mode === 'system' ? 'Diagnosticar novamente' : 'Testar novamente'}
          </Button>
        </>
      }
    >
      {loading ? (
        <div
          className="flex min-h-[180px] flex-col items-center justify-center gap-3 text-center"
          aria-busy="true"
        >
          <Spinner label="Executando diagnóstico" />
          <p className="m-0 max-w-[360px] text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            Executando chamadas reais de token e leitura nos canais. Isso pode levar alguns
            segundos.
          </p>
        </div>
      ) : error ? (
        <Alert tone="danger" title="Não foi possível concluir o diagnóstico">
          {error}
        </Alert>
      ) : mode === 'account' ? (
        data ? (
          <AccountResult diagnosis={data} />
        ) : (
          <Alert tone="warning" title="Sem resultado">
            O diagnóstico não retornou dados. Execute novamente.
          </Alert>
        )
      ) : data ? (
        <SystemResult diagnosis={data} />
      ) : (
        <Alert tone="warning" title="Sem resultado">
          O diagnóstico não retornou dados. Execute novamente.
        </Alert>
      )}
    </Modal>
  );
}
