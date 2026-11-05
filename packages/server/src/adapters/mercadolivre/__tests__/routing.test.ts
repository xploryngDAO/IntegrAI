import { describe, expect, it } from 'vitest';
import type { OutboundValidationInput } from '@sac/shared';
import { evaluateMeliOutbound, resolveMeliRoute } from '../outbound/policy';

function input(overrides: Partial<OutboundValidationInput> = {}): OutboundValidationInput {
  return {
    marketplace: 'MERCADO_LIVRE',
    ticketType: 'POST_SALE_ORDER',
    hasActiveClaim: false,
    bodyText: 'Olá, tudo bem?',
    recipient: 'BUYER',
    attachments: [],
    hasPriorInbound: true,
    ...overrides,
  };
}

const attachment: OutboundValidationInput['attachments'][number] = {
  fileName: 'nf.pdf',
  mimeType: 'application/pdf',
  s3Key: 'meli/evidence/nf.pdf',
  sizeBytes: 1024,
};

describe('resolveMeliRoute', () => {
  it('routes pre-sale questions to the Questions API and never uploads attachments', () => {
    const decision = resolveMeliRoute(
      input({ ticketType: 'PRE_SALE', attachments: [attachment] }),
    );
    expect(decision.route).toBe('MELI_QUESTIONS_API');
    expect(decision.blocked).toBe(false);
    expect(decision.requiresAttachmentUpload).toBe(false);
    expect(decision.reason).toContain('/answers');
  });

  it('routes normal post-sale messages to the Messages API', () => {
    const decision = resolveMeliRoute(input());
    expect(decision.route).toBe('MELI_MESSAGES_API');
    expect(decision.recipient).toBe('BUYER');
    expect(decision.requiresAttachmentUpload).toBe(false);
    expect(decision.blocked).toBe(false);
  });

  it('flags attachment upload for post-sale messages with evidence', () => {
    const decision = resolveMeliRoute(input({ attachments: [attachment] }));
    expect(decision.route).toBe('MELI_MESSAGES_API');
    expect(decision.requiresAttachmentUpload).toBe(true);
  });

  it('routes active claims to the Claims API and warns that the pack chat is blocked', () => {
    const decision = resolveMeliRoute(
      input({
        hasActiveClaim: true,
        attachments: [attachment],
        allowedActions: { available_actions: [{ action: 'send_message' }] },
      }),
    );
    expect(decision.route).toBe('MELI_CLAIMS_API');
    expect(decision.blocked).toBe(false);
    expect(decision.requiresAttachmentUpload).toBe(true);
    expect(decision.reason).toContain('Claims API');
  });

  it('routes CLAIM_DISPUTE tickets to the Claims API even without the flag', () => {
    const decision = resolveMeliRoute(input({ ticketType: 'CLAIM_DISPUTE' }));
    expect(decision.route).toBe('MELI_CLAIMS_API');
    expect(decision.recipient).toBe('BUYER');
  });

  it('keeps the mediator recipient on the claim route', () => {
    const decision = resolveMeliRoute(
      input({
        hasActiveClaim: true,
        recipient: 'MEDIATOR',
        allowedActions: { available_actions: [{ action: 'send_message' }] },
      }),
    );
    expect(decision.route).toBe('MELI_CLAIMS_API');
    expect(decision.recipient).toBe('MEDIATOR');
    expect(decision.blocked).toBe(false);
  });

  it('blocks a buyer message when the respondent has no send-message action', () => {
    const decision = resolveMeliRoute(
      input({
        hasActiveClaim: true,
        allowedActions: {
          available_actions: [{ action: 'allow_return' }, { action: 'refund' }],
        },
      }),
    );
    expect(decision.route).toBe('MELI_CLAIMS_API');
    expect(decision.blocked).toBe(true);
    expect(decision.blockedReason).toContain('Nenhuma ação de mensagem');
  });

  it('does not block when action information is unknown', () => {
    const decision = resolveMeliRoute(input({ hasActiveClaim: true }));
    expect(decision.route).toBe('MELI_CLAIMS_API');
    expect(decision.blocked).toBe(false);
  });

  it('treats an explicitly empty available_actions list as no message action', () => {
    const decision = resolveMeliRoute(
      input({ hasActiveClaim: true, allowedActions: { available_actions: [] } }),
    );
    expect(decision.blocked).toBe(true);
  });
});

describe('evaluateMeliOutbound', () => {
  it('adds CLAIM_CHAT_BLOCKED as a WARN (not a block) for active claims', () => {
    const evaluation = evaluateMeliOutbound(
      input({ hasActiveClaim: true, allowedActions: { claim_id: '555' } }),
    );
    const codes = evaluation.violations.map((violation) => violation.code);
    expect(codes).toContain('CLAIM_CHAT_BLOCKED');
    expect(evaluation.blocked).toBe(false);
    expect(evaluation.routePreview.route).toBe('MELI_CLAIMS_API');
  });

  it('blocks the claim route without a claim id (MISSING_CLAIM_ID)', () => {
    const evaluation = evaluateMeliOutbound(input({ hasActiveClaim: true }));
    const missing = evaluation.violations.find(
      (violation) => violation.code === 'MISSING_CLAIM_ID',
    );
    expect(missing?.severity).toBe('BLOCK');
    expect(evaluation.blocked).toBe(true);
  });

  it('accepts the claim id coming from channel_metadata', () => {
    const evaluation = evaluateMeliOutbound(
      input({ hasActiveClaim: true, channelMetadata: { claim_id: '987' } }),
    );
    expect(
      evaluation.violations.some((violation) => violation.code === 'MISSING_CLAIM_ID'),
    ).toBe(false);
    expect(evaluation.blocked).toBe(false);
  });

  it('warns on a blocked-chat action guide when there is no active claim', () => {
    const evaluation = evaluateMeliOutbound(
      input({
        channelMetadata: {
          action_guide: { blocked: true, options: [{ option_id: 'reason_1' }] },
        },
      }),
    );
    expect(
      evaluation.violations.some(
        (violation) => violation.code === 'CHAT_BLOCKED_ACTION_GUIDE',
      ),
    ).toBe(true);
    expect(evaluation.routePreview.route).toBe('MELI_MESSAGES_API');
    expect(evaluation.blocked).toBe(false);
  });

  it('merges per-store allowed link domains into the policy engine', () => {
    const allowed = evaluateMeliOutbound(
      input({
        bodyText: 'Consulte https://minhaloja.com/pedido/1',
        allowedLinkDomains: ['minhaloja.com'],
      }),
    );
    expect(allowed.blocked).toBe(false);

    const blocked = evaluateMeliOutbound(
      input({ bodyText: 'Consulte https://minhaloja.com/pedido/1' }),
    );
    expect(blocked.blocked).toBe(true);
    expect(blocked.violations.some((violation) => violation.code === 'EXTERNAL_LINK')).toBe(true);
  });

  it('keeps the shared MELI policy blocks (WhatsApp / e-mail in body)', () => {
    const whatsapp = evaluateMeliOutbound(input({ bodyText: 'Me chama no WhatsApp 11 99999-9999' }));
    expect(whatsapp.blocked).toBe(true);
    expect(
      whatsapp.violations.some((violation) => violation.code === 'OFF_PLATFORM_CONTACT'),
    ).toBe(true);

    const email = evaluateMeliOutbound(input({ bodyText: 'Envie para comprador@example.com' }));
    expect(email.blocked).toBe(true);
    expect(email.violations.some((violation) => violation.code === 'EMAIL_IN_BODY')).toBe(true);
  });
});
