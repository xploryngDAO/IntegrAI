/**
 * "Segurança do workspace" — the tenant-wide TOTP policy (`require2fa`).
 *
 * The switch is not a local preference: every change is sent to
 * `PATCH /tenants/me { require2fa }` (ADMIN) and the page keeps the state the
 * API confirmed. A deployment that does not publish the field on
 * `GET /tenants/me` is rendered as "indisponível nesta API" — never as an
 * invented "policy off".
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useWorkspace } from '../../lib/store';
import { twoFactorPolicyErrorMessage } from '../../lib/twoFactor';
import type { TenantProfile } from '../../lib/types';
import { Alert, Button, Card, Pill, Skeleton, Toggle } from '../ui';

export function TwoFactorPolicyCard(): JSX.Element {
  const pushToast = useWorkspace((state) => state.pushToast);

  const [profile, setProfile] = useState<TenantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

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
        if (!active) return;
        setProfile(result);
        setSaveError(null);
        setSavedNotice(null);
      } catch (error) {
        if (!active) return;
        setProfile(null);
        setLoadError(twoFactorPolicyErrorMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadProfile();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  function confirmPolicy(next: boolean): void {
    const description = next
      ? 'Operadores sem TOTP são levados à ativação no próximo login e só entram depois de confirmar o app autenticador.'
      : 'O login por senha volta a pedir apenas e-mail e senha; o TOTP de quem já ativou continua valendo.';
    setSavedNotice(description);
    pushToast({
      tone: 'ok',
      title: next ? 'Política de 2FA ativada' : 'Política de 2FA desativada',
      description,
    });
  }

  async function applyPolicy(next: boolean): Promise<void> {
    if (saving || loading || profile === null) return;

    setSaving(true);
    setSaveError(null);
    setSavedNotice(null);
    try {
      // The PATCH may echo the policy, answer 204 or omit the field. When there
      // is no confirmed value the GET is re-read; the switch never moves ahead
      // of what the API actually stored.
      const acknowledged = await api.updateTenantSettings({ require2fa: next });
      if (acknowledged !== null) {
        if (acknowledged !== next) {
          setSaveError(
            'A API respondeu com um valor diferente do solicitado. O estado foi recarregado; confira antes de tentar novamente.',
          );
          retry();
          return;
        }
        setProfile((current) =>
          current === null ? current : { ...current, require2fa: acknowledged },
        );
        confirmPolicy(next);
        return;
      }

      // 204 / omitted field: the API is the authority, so the profile is
      // re-read instead of assuming the requested value was stored. A failure
      // here is reported as "could not confirm", never as "not saved".
      let fresh: TenantProfile;
      try {
        fresh = await api.tenantProfile();
      } catch (refreshError) {
        setSaveError(
          `A API aceitou o pedido, mas não foi possível reler o estado do workspace. ${twoFactorPolicyErrorMessage(refreshError)}`,
        );
        retry();
        return;
      }
      setProfile(fresh);
      if (fresh.require2fa === null) {
        setSaveError(
          'A API aceitou a alteração, mas não publica o campo require2fa em GET /tenants/me. Confirme o estado pela API antes de considerar a política ativa.',
        );
        return;
      }
      if (fresh.require2fa !== next) {
        setSaveError('A alteração não foi aplicada pela API. O estado abaixo foi recarregado.');
        return;
      }
      confirmPolicy(next);
    } catch (error) {
      // No optimistic toggle: on failure the switch keeps showing the stored
      // value, and the real status/message of the API is shown above it.
      setSaveError(twoFactorPolicyErrorMessage(error));
      setSavedNotice(null);
    } finally {
      setSaving(false);
    }
  }

  const policyValue = profile?.require2fa ?? null;

  return (
    <Card
      title="Verificação em duas etapas obrigatória"
      subtitle="Política do workspace aplicada pela API a todos os operadores · GET/PATCH /tenants/me."
      actions={
        loading || policyValue === null ? undefined : (
          <Pill tone={policyValue ? 'ok' : 'neutral'}>{policyValue ? 'Exigida' : 'Opcional'}</Pill>
        )
      }
    >
      {loading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : loadError !== null ? (
        <Alert title="Não foi possível ler a política do workspace" tone="danger">
          <div className="flex flex-col gap-2">
            <span>{loadError}</span>
            <div>
              <Button size="sm" icon="pulse" onClick={retry}>
                Tentar novamente
              </Button>
            </div>
          </div>
        </Alert>
      ) : profile === null ? null : policyValue === null ? (
        <div className="flex flex-col gap-3">
          <Alert title="Indisponível nesta API" tone="warning">
            Esta implantação de <span className="sac-num">GET /tenants/me</span> não publica o campo{' '}
            <span className="sac-num">require2fa</span>. O painel não assume que a política está
            desligada: atualize a API para gerenciá-la por aqui.
          </Alert>
          <div>
            <Button size="sm" icon="pulse" onClick={retry}>
              Verificar novamente
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2.5 rounded-[var(--cv-radius-small)] border border-[var(--cv-color-border)] bg-[var(--cv-color-surface-subtle)] px-3 py-2.5">
            <Toggle
              label="Exigir verificação em duas etapas para todos os operadores"
              checked={policyValue === true}
              disabled={saving}
              onChange={(checked) => void applyPolicy(checked)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]"
                aria-live="polite"
              >
                {saving ? 'Salvando…' : 'A alteração é aplicada pela API no próximo login.'}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-1.5 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
            <p className="m-0">
              <strong className="font-medium text-[var(--cv-color-text)]">Impacto:</strong> com a
              política ativa, o operador sem TOTP fica bloqueado no login por senha até configurar um
              app autenticador. A API devolve o passo de ativação no próprio login e a sessão só é
              emitida depois da confirmação.
            </p>
            <p className="m-0">
              Operadores que entram pelo <strong>SSO corporativo (Microsoft)</strong> ficam isentos:
              o segundo fator é responsabilidade do provedor de identidade.
            </p>
            <p className="m-0">
              Desligar a política não desativa o TOTP de quem já o configurou: esses operadores
              continuam entrando com o código do app.
            </p>
          </div>

          {saveError !== null ? (
            <Alert title="Não foi possível atualizar a política" tone="danger">
              {saveError}
            </Alert>
          ) : null}

          {savedNotice !== null ? (
            <Alert title="Política atualizada" tone="success">
              {savedNotice}
            </Alert>
          ) : null}
        </div>
      )}
    </Card>
  );
}
