import { describe, expect, it } from 'vitest';
import type { OutboundValidationInput } from '@sac/shared';
import { buildAmazonPolicyEvaluation } from '../outbound/sanitizer';
import { decideAmazonRoute } from '../outbound/routeDecision';

function makeInput(overrides: Partial<OutboundValidationInput> = {}): OutboundValidationInput {
  return {
    marketplace: 'AMAZON',
    ticketType: 'POST_SALE_ORDER',
    hasActiveClaim: false,
    bodyText: 'Olá! Seu pedido foi enviado e chegará em breve.',
    bodyHtml: null,
    subject: 'Atualização do pedido',
    recipient: 'BUYER',
    attachments: [],
    forceImportant: false,
    hasPriorInbound: true,
    allowedActions: { actions: [] },
    ...overrides,
  };
}

describe('Amazon outbound policy', () => {
  it('bloqueia contato externo (WhatsApp) e e-mail no corpo', () => {
    const evaluation = buildAmazonPolicyEvaluation(
      makeInput({
        bodyText: 'Me chama no WhatsApp 11 99999-9999 ou envie para comprador@exemplo.com',
      }),
      ['amazon.com', 'amazon.com.br'],
    );
    expect(evaluation.blocked).toBe(true);
    expect(evaluation.violations.some((v) => v.code === 'OFF_PLATFORM_CONTACT')).toBe(true);
    expect(evaluation.violations.some((v) => v.code === 'EMAIL_IN_BODY')).toBe(true);
  });

  it('exige inbound prévio quando não há ação proativa permitida (NEED_PRIOR_INBOUND)', () => {
    const evaluation = buildAmazonPolicyEvaluation(
      makeInput({ hasPriorInbound: false, allowedActions: { actions: [] } }),
      ['amazon.com'],
    );
    expect(evaluation.routePreview.route).toBe('AMAZON_SP_API_MESSAGING');
    expect(evaluation.routePreview.blocked).toBe(true);
    const violation = evaluation.violations.find((v) => v.code === 'NEED_PRIOR_INBOUND');
    expect(violation?.severity).toBe('BLOCK');
    expect(evaluation.blocked).toBe(true);
  });

  it('prioriza a rota SMTP quando existe mensagem prévia do comprador', () => {
    const route = decideAmazonRoute(makeInput({ hasPriorInbound: true }));
    expect(route.route).toBe('AMAZON_EMAIL_RELAY');
    expect(route.reason).toBe('receptive-reply');
    expect(route.blocked).toBe(false);
  });

  it('escolhe a ação proativa na ordem de preferência do contrato', () => {
    const route = decideAmazonRoute(
      makeInput({
        hasPriorInbound: false,
        allowedActions: { actions: ['warranty', 'confirmDeliveryDetails'] },
      }),
    );
    expect(route.route).toBe('AMAZON_SP_API_MESSAGING');
    expect(route.actionName).toBe('confirmDeliveryDetails');
    expect(route.blocked).toBe(false);
  });

  it('marca opt-out com WARN IMPORTANT_PREFIX e permite envio', () => {
    const evaluation = buildAmazonPolicyEvaluation(
      makeInput({ bodyText: 'Não me envie mais mensagens, por favor.' }),
      ['amazon.com'],
    );
    const warn = evaluation.violations.find((v) => v.code === 'IMPORTANT_PREFIX');
    expect(warn?.severity).toBe('WARN');
    expect(evaluation.blocked).toBe(false);
  });

  it('closeWithoutResponse resolve para a rota de relay sem envio', () => {
    const route = decideAmazonRoute(makeInput({ closeWithoutResponse: true }));
    expect(route.route).toBe('AMAZON_EMAIL_RELAY');
    expect(route.reason).toBe('silent-close');
    expect(route.actionName).toBe('AMAZON_NO_RESPONSE_NEEDED');
  });
});
