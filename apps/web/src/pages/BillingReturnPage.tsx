/**
 * Public return URLs of the hosted checkout (`/billing/success` and
 * `/billing/cancel`).
 *
 * The gateway redirects the buyer here after paying or abandoning the checkout.
 * These routes are session-free and skip the `/auth/me` probe: a return URL
 * opened from the payment provider must render even when the API session is
 * unreachable. Nothing is granted from the query string — the subscription only
 * changes on the authenticated webhook — so the page thanks/warns and sends the
 * operator to the console (`/platform`) when a session token exists, or to the
 * login gate otherwise.
 */
import { Link, useNavigate } from 'react-router-dom';
import { useWorkspace } from '../lib/store';
import { hasAuthToken } from '../lib/api';
import { AuthLayout } from '../components/auth/AuthLayout';
import { Alert, Button } from '../components/ui';

type BillingReturnVariant = 'success' | 'cancel';

function BillingReturnView({ variant }: { variant: BillingReturnVariant }): JSX.Element {
  const navigate = useNavigate();
  // No probe on these routes: a stored token is enough to offer the console and
  // the API keeps enforcing the platform-admin role on `/platform`.
  const currentAgent = useWorkspace((state) => state.currentAgent);
  const signedIn = currentAgent !== null || hasAuthToken();

  const isSuccess = variant === 'success';

  function goToNext(): void {
    navigate(signedIn ? '/platform' : '/login');
  }

  return (
    <AuthLayout
      title={isSuccess ? 'Pagamento concluído' : 'Checkout cancelado'}
      description={
        isSuccess
          ? 'O provedor de pagamento devolveu você ao SAC Hub.'
          : 'O checkout foi interrompido antes da confirmação.'
      }
    >
      <Alert
        title={isSuccess ? 'Obrigado pela assinatura' : 'Nenhuma cobrança foi feita'}
        tone={isSuccess ? 'success' : 'warning'}
      >
        {isSuccess
          ? 'Recebemos o retorno do provedor. A confirmação definitiva chega pelo webhook autenticado do gateway; até lá o status da assinatura e os limites do workspace permanecem como estavam.'
          : 'Você pode voltar quando quiser: o plano, os limites e o status de cobrança do workspace continuam exatamente como estavam antes do checkout.'}
      </Alert>

      <p className="m-0 text-[var(--cv-font-meta)] leading-relaxed text-[var(--cv-color-text-muted)]">
        {isSuccess
          ? 'Acompanhe o resultado no console da plataforma: o tenant mostra o status da cobrança e a lista “Últimos eventos de billing” registra o callback do gateway.'
          : 'Se o checkout foi cancelado por engano, gere um novo link na aba de detalhes do tenant, no console da plataforma.'}
      </p>

      <Button type="button" variant="primary" icon="arrow" fullWidth onClick={goToNext}>
        {signedIn ? 'Ir para o console da plataforma' : 'Entrar para acompanhar'}
      </Button>

      <p className="m-0 text-center text-[var(--cv-font-meta)] text-[var(--cv-color-text-muted)]">
        {signedIn ? (
          <Link to="/" className="cv-link inline-flex min-h-6 items-center underline">
            Voltar ao workspace
          </Link>
        ) : (
          <Link to="/login" className="cv-link inline-flex min-h-6 items-center underline">
            Voltar ao login
          </Link>
        )}
      </p>
    </AuthLayout>
  );
}

/** `/billing/success` — return URL of a completed hosted checkout (public). */
export function BillingSuccessPage(): JSX.Element {
  return <BillingReturnView variant="success" />;
}

/** `/billing/cancel` — return URL of an abandoned hosted checkout (public). */
export function BillingCancelPage(): JSX.Element {
  return <BillingReturnView variant="cancel" />;
}
