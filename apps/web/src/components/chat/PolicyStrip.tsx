import type { Marketplace, PolicyEvaluation } from '@sac/shared';
import { MARKETPLACE_LABEL } from '../../lib/labels';

interface PolicyStripProps {
  policy: PolicyEvaluation | null;
  marketplace: Marketplace;
}

/**
 * Real-time guardrail on `.sac-composer__policy` fed by the debounced
 * `POST /tickets/:id/policy-check` (350 ms). Danger disables Send; warnings are
 * advisory; success confirms the channel policy.
 */
export function PolicyStrip({ policy, marketplace }: PolicyStripProps): JSX.Element {
  const channel = MARKETPLACE_LABEL[marketplace];

  if (!policy) {
    return (
      <div className="sac-composer__policy" role="status" aria-live="polite">
        <strong>Verificando políticas do canal</strong>
        <span>O rascunho é validado antes de sair.</span>
      </div>
    );
  }

  const blocking = policy.violations.filter((violation) => violation.severity === 'BLOCK');
  const warnings = policy.violations.filter((violation) => violation.severity === 'WARN');

  if (policy.blocked || blocking.length > 0) {
    return (
      <div className="sac-composer__policy" data-tone="danger" role="status" aria-live="polite">
        <strong>Bloqueado pelas políticas · {channel}</strong>
        <ul>
          {blocking.map((violation, index) => (
            <li key={`${violation.code}-${index}`}>{violation.message}</li>
          ))}
        </ul>
        <span>Corrija as violações para reativar o envio.</span>
      </div>
    );
  }

  if (warnings.length > 0) {
    return (
      <div className="sac-composer__policy" data-tone="warning" role="status" aria-live="polite">
        <strong>Atenção antes de enviar · {channel}</strong>
        <ul>
          {warnings.map((violation, index) => (
            <li key={`${violation.code}-${index}`}>{violation.message}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      className="sac-composer__policy"
      data-tone="success"
      role="status"
      aria-live="polite"
      title={policy.notes.length > 0 ? policy.notes.join(' · ') : undefined}
    >
      <strong>✓ Dentro das políticas · {channel}</strong>
    </div>
  );
}
