import { detectOptOut, evaluateOutboundPolicy } from '@sac/shared';
import type {
  OutboundPolicyResult,
  OutboundValidationInput,
  PolicyEvaluation,
  PolicyViolation,
} from '@sac/shared';
import { decideAmazonRoute } from './routeDecision';

/**
 * Thin wrapper over the shared policy engine, adding the Amazon-specific
 * routing guardrail (`NEED_PRIOR_INBOUND`) and the opt-out `[Important]` hint.
 */

export interface AmazonPolicyInput {
  text: string;
  html?: string | null;
  subject?: string | null;
  extraAllowedDomains?: readonly string[];
}

export function evaluateAmazonPolicy(input: AmazonPolicyInput): OutboundPolicyResult {
  return evaluateOutboundPolicy({
    text: input.text ?? '',
    html: input.html ?? null,
    subject: input.subject ?? null,
    marketplace: 'AMAZON',
    allowedLinkDomains: [...(input.extraAllowedDomains ?? [])],
  });
}

/**
 * Full `validateOutbound` evaluation: shared policy violations + route preview +
 * the missing-prior-inbound blocker when Amazon would force proactive SP-API
 * messaging but no action is allowed for the order.
 */
export function buildAmazonPolicyEvaluation(
  input: OutboundValidationInput,
  extraAllowedDomains: readonly string[],
): PolicyEvaluation {
  const policy = evaluateAmazonPolicy({
    text: input.bodyText ?? '',
    html: input.bodyHtml ?? null,
    subject: input.subject ?? null,
    extraAllowedDomains,
  });

  const routePreview = decideAmazonRoute(input);
  const violations: PolicyViolation[] = [...policy.violations];

  if (routePreview.route === 'AMAZON_SP_API_MESSAGING' && routePreview.blocked) {
    violations.push({
      code:
        routePreview.reason === 'need-prior-inbound'
          ? 'NEED_PRIOR_INBOUND'
          : 'PROACTIVE_ACTION_UNSUPPORTED',
      severity: 'BLOCK',
      field: 'body',
      message:
        routePreview.blockedReason ??
        'O comprador nunca enviou mensagem neste pedido e o Amazon não autoriza contato proativo por e-mail (Buyer-Seller Messaging Policy).',
    });
  }

  const optOut = input.buyerOptOut ?? detectOptOut(input.bodyText ?? '');
  if (optOut) {
    violations.push({
      code: 'IMPORTANT_PREFIX',
      severity: 'WARN',
      field: 'subject',
      message: input.forceImportant
        ? 'Opt-out do comprador detectado: o prefixo [Important] será aplicado ao assunto.'
        : 'Opt-out do comprador detectado: use [Important] (forceImportant) ao enviar mensagem crítica.',
    });
  }

  return {
    violations,
    blocked: violations.some((violation) => violation.severity === 'BLOCK'),
    sanitizedText: policy.sanitizedText,
    sanitizedHtml: policy.sanitizedHtml,
    notes: policy.notes,
    routePreview,
  };
}

/** Blocking violations shaped for `PolicyViolationError`. */
export function blockingViolations(
  evaluation: PolicyEvaluation,
): Array<{ code: string; message: string; match?: string }> {
  return evaluation.violations
    .filter((violation) => violation.severity === 'BLOCK')
    .map((violation) => ({
      code: violation.code,
      message: violation.message,
      ...(violation.match ? { match: violation.match } : {}),
    }));
}
