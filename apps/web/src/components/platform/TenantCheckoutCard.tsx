/**
 * Hosted checkout of one tenant — `POST /platform/tenants/:id/checkout`.
 *
 * The API does not call the gateway: it renders the provider checkout URL from
 * `BILLING_CHECKOUT_URL_TEMPLATE` and answers `503 BILLING_NOT_CONFIGURED`
 * while the deployment is missing it. The button therefore has three honest
 * outcomes: redirect (valid absolute http(s) URL), configuration pending
 * (503), or the real server error. Nothing is charged and no local state is
 * mutated here — the subscription status only changes on the gateway webhook.
 */
import { useState } from 'react';
import { api, ApiClientError } from '../../lib/api';
import type { TenantPlan } from '../../lib/types';
import { checkoutErrorMessage, isForbiddenError, planLabel } from '../../lib/platform';
import { Alert, Button, Card, Pill } from '../ui';

export interface TenantCheckoutCardProps {
  tenantId: string;
  /** Display name of the tenant (the dialog heading already includes the slug). */
  tenantName: string;
  plan?: TenantPlan;
  /** 403 anywhere in the drawer: the page takes over with its own state. */
  onForbidden: () => void;
}

interface CheckoutFailure {
  message: string;
  /** 503 is a deployment setting, not an outage: warn instead of alarm. */
  tone: 'warning' | 'danger';
}

/** Only absolute http(s) URLs may receive the browser (no `javascript:` etc.). */
function absoluteHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function TenantCheckoutCard({
  tenantId,
  tenantName,
  plan,
  onForbidden,
}: TenantCheckoutCardProps): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [failure, setFailure] = useState<CheckoutFailure | null>(null);

  async function startCheckout(): Promise<void> {
    if (loading || redirecting) return;
    setLoading(true);
    setFailure(null);
    try {
      const result = await api.platformTenantCheckout(tenantId);
      const url = absoluteHttpUrl(result.checkoutUrl);

      if (url === null) {
        setFailure({
          message:
            'A API respondeu sem uma URL de checkout válida, então o redirecionamento foi bloqueado. Nada foi cobrado; revise a configuração do template de checkout do provedor e tente novamente.',
          tone: 'warning',
        });
        return;
      }

      setRedirecting(true);
      window.location.assign(url);
    } catch (error) {
      if (isForbiddenError(error)) {
        onForbidden();
        return;
      }
      const notConfigured =
        error instanceof ApiClientError &&
        (error.status === 503 || error.code === 'BILLING_NOT_CONFIGURED');
      setFailure({
        message: checkoutErrorMessage(error),
        tone: notConfigured ? 'warning' : 'danger',
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card
      title="Assinatura"
      subtitle="Checkout hospedado do plano, gerado pela API a partir do template do provedor."
      actions={plan !== undefined ? <Pill tone="accent">{planLabel(plan)}</Pill> : undefined}
    >
      <div className="mt-3 flex flex-col gap-3">
        <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
          Abre o checkout do provedor de pagamento para {tenantName} e redireciona este navegador. A
          API não cobra nada por conta própria: o status da assinatura só muda quando o gateway
          envia o webhook autenticado.
        </p>

        {failure !== null ? (
          <Alert title="Checkout não iniciado" tone={failure.tone}>
            {failure.message}
          </Alert>
        ) : null}

        {redirecting ? (
          <Alert title="Redirecionando para o checkout" tone="success">
            Abrindo o provedor de pagamento nesta aba. Se nada acontecer, o redirecionamento pode ter
            sido bloqueado pelo navegador; gere o checkout novamente.
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 max-w-full break-all text-[var(--cv-font-micro)] leading-snug text-[var(--cv-color-text-muted)]">
            Redireciona para o provedor de pagamento.
          </p>
          <Button
            variant="primary"
            icon="wallet"
            loading={loading}
            disabled={loading || redirecting}
            onClick={() => void startCheckout()}
          >
            Assinar/Checkout
          </Button>
        </div>
      </div>
    </Card>
  );
}
