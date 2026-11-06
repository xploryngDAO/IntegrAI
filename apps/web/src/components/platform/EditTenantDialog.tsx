import { useState } from 'react';
import { api } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import type { PlatformTenant, TenantPlan } from '../../lib/types';
import {
  ENTERPRISE_UNLIMITED,
  PLAN_DEFAULT_LIMITS,
  canonicalPlan,
  formatLimit,
  planLabel,
  planOptions,
  platformErrorMessage,
} from '../../lib/platform';
import { Alert, Button, FieldRow, Input, Modal, Select } from '../ui';

export interface EditTenantDialogProps {
  tenant: PlatformTenant;
  onClose: () => void;
  /** Called after a successful PATCH (payload may be empty on 204). */
  onSaved: (tenant: PlatformTenant | null) => void;
}

type ParsedLimit = number | 'invalid';

/** API contract: non-negative quota starting at 1, capped by ENTERPRISE. */
function parseLimit(value: string): ParsedLimit {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ENTERPRISE_UNLIMITED) return 'invalid';
  return parsed;
}

/**
 * Plan/limits editor of the platform console (`PATCH /platform/tenants/:id`).
 *
 * Errors keep the dialog open and render the real server message, so a 403, a
 * validation 422 or an infrastructure failure are all distinguishable.
 */
export function EditTenantDialog({
  tenant,
  onClose,
  onSaved,
}: EditTenantDialogProps): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);
  const [plan, setPlan] = useState<TenantPlan>(canonicalPlan(tenant.plan));
  const [maxAccounts, setMaxAccounts] = useState(String(tenant.limits.maxAccounts));
  const [maxAgents, setMaxAgents] = useState(String(tenant.limits.maxAgents));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave(): Promise<void> {
    if (saving) return;

    const accountsLimit = parseLimit(maxAccounts);
    if (accountsLimit === 'invalid') {
      setError('O limite de contas deve ser um inteiro entre 1 e 1.000.000.');
      return;
    }
    const agentsLimit = parseLimit(maxAgents);
    if (agentsLimit === 'invalid') {
      setError('O limite de agentes deve ser um inteiro entre 1 e 1.000.000.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updated = await api.updatePlatformTenant(tenant.id, {
        plan,
        maxAccounts: accountsLimit,
        maxAgents: agentsLimit,
      });
      pushToast({
        tone: 'ok',
        title: 'Plano atualizado',
        description: `${tenant.name} agora está no plano ${planLabel(plan)}.`,
      });
      onSaved(updated);
      onClose();
    } catch (updateError) {
      setError(platformErrorMessage(updateError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Editar plano e limites"
      description={`Ajuste o plano de "${tenant.name}". A alteração vale imediatamente para o tenant e é registrada no console.`}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void handleSave()}>
            Salvar alterações
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Select
          label="Plano"
          value={plan}
          options={planOptions(tenant.plan)}
          onChange={(event) => {
            const nextPlan = canonicalPlan(event.target.value);
            const defaults = PLAN_DEFAULT_LIMITS[nextPlan];
            setPlan(nextPlan);
            // Mirrors the API: a bare plan change realigns the quotas with the
            // plan defaults; the operator can still override them below.
            setMaxAccounts(String(defaults.maxAccounts));
            setMaxAgents(String(defaults.maxAgents));
          }}
          hint="Trocar o plano preenche as quotas padrão; ajuste os limites se precisar de exceção."
        />

        <FieldRow>
          <Input
            label="Limite de contas"
            type="number"
            min={1}
            max={ENTERPRISE_UNLIMITED}
            step={1}
            inputMode="numeric"
            value={maxAccounts}
            hint={`Atual: ${formatLimit(tenant.limits.maxAccounts)} · mínimo 1`}
            onChange={(event) => setMaxAccounts(event.target.value)}
          />
          <Input
            label="Limite de agentes"
            type="number"
            min={1}
            max={ENTERPRISE_UNLIMITED}
            step={1}
            inputMode="numeric"
            value={maxAgents}
            hint={`Atual: ${formatLimit(tenant.limits.maxAgents)} · mínimo 1`}
            onChange={(event) => setMaxAgents(event.target.value)}
          />
        </FieldRow>

        <p className="m-0 text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
          Chamada executada:{' '}
          <span className="sac-num">PATCH /api/v1/platform/tenants/{tenant.id}</span>
        </p>

        {error !== null ? (
          <Alert title="Não foi possível salvar" tone="danger">
            {error}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
