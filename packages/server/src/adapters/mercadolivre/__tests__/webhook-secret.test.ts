import { describe, expect, it } from 'vitest';
import { MercadoLivreChannelAdapter } from '../MercadoLivreChannelAdapter';
import { createFakeDeps } from './fakeDeps';

const body = Buffer.from(JSON.stringify({ user_id: 42, topic: 'messages', resource: '/messages/1' }));

function request(secret?: string): Parameters<MercadoLivreChannelAdapter['verifyInbound']>[0] {
  return {
    method: 'POST',
    url: 'https://api.example.com/webhooks/meli?secret=test-webhook-secret',
    headers: {},
    query: secret === undefined ? {} : { secret },
    rawBody: body,
    receivedAt: new Date('2026-11-06T12:00:00.000Z'),
  };
}

describe('Mercado Livre webhook shared secret', () => {
  it('rejects every push when the notification secret is not configured', async () => {
    const { deps } = createFakeDeps();
    deps.config.meli.webhookSecret = '';
    const adapter = new MercadoLivreChannelAdapter(deps);

    const verification = await adapter.verifyInbound(request('test-webhook-secret'));

    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe('WEBHOOK_SECRET_NOT_CONFIGURED');
  });

  it('rejects a wrong or missing secret', async () => {
    const { deps } = createFakeDeps();
    const adapter = new MercadoLivreChannelAdapter(deps);

    await expect(adapter.verifyInbound(request('wrong-secret'))).resolves.toMatchObject({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    });
    await expect(adapter.verifyInbound(request())).resolves.toMatchObject({
      valid: false,
      reason: 'INVALID_SIGNATURE',
    });
  });

  it('accepts the push when the URL secret matches', async () => {
    const { deps } = createFakeDeps();
    const adapter = new MercadoLivreChannelAdapter(deps);

    const verification = await adapter.verifyInbound(request('test-webhook-secret'));

    expect(verification.valid).toBe(true);
    expect(verification.reason).toBe('MELI_NO_SIGNATURE');
  });
});
