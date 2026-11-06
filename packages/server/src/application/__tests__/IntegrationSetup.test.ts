import { describe, expect, it } from 'vitest';
import type { ChannelRuntimeConfig, IntegrationSetupChannel, Marketplace } from '@sac/shared';

import { IntegrationSetupService } from '../IntegrationSetupService';
import { FrozenClock, testChannelConfig } from './accountFakes';

/**
 * Fase 2 onboarding - `GET /platform/integration-setup`.
 *
 * The guide is pure configuration introspection, so these tests pin:
 *  - the per-channel contract shape and the onboarding order;
 *  - `configured`/`missing` against the REAL runtime config fields (with and
 *    without credentials);
 *  - the exact redirect/webhook URLs derived from APP_BASE_URL / WEB_ORIGIN;
 *  - the hard rule that no secret VALUE ever leaves the service.
 */

const NOW = new Date('2026-11-05T12:00:00.000Z');
const API_BASE = 'https://api.integrai.test';
const WEB_ORIGIN = 'https://app.integrai.test, https://admin.integrai.test';

/** Secrets present in the fixture config; none of them may be serialized. */
const SECRET_VALUES = [
  'meli-secret',
  'shopee-key',
  'amzn1.oa2-cs.v1.test',
  'ses-secret',
];

function createService(
  overrides: {
    config?: ChannelRuntimeConfig;
    webOrigin?: string;
  } = {},
): IntegrationSetupService {
  return new IntegrationSetupService({
    clock: new FrozenClock(NOW),
    config: overrides.config ?? testChannelConfig(),
    webOrigin: overrides.webOrigin ?? WEB_ORIGIN,
  });
}

/** Config with every app credential absent (fresh deployment). */
function emptyConfig(): ChannelRuntimeConfig {
  const base = testChannelConfig({
    amazon: { appId: undefined, lwaClientId: '', lwaClientSecret: '' },
  });
  return {
    ...base,
    meli: { ...base.meli, clientId: '', clientSecret: '' },
    shopee: { ...base.shopee, partnerId: 0, partnerKey: '' },
  };
}

function channel(
  guide: { channels: IntegrationSetupChannel[] },
  marketplace: Marketplace,
): IntegrationSetupChannel {
  const found = guide.channels.find((entry) => entry.marketplace === marketplace);
  if (found === undefined) throw new Error(`Missing channel ${marketplace}`);
  return found;
}

describe('IntegrationSetupService', () => {
  describe('guide envelope', () => {
    it('returns the timestamp, the API base and the first WEB_ORIGIN', () => {
      const guide = createService().guide();

      expect(guide.generatedAt).toBe(NOW.toISOString());
      expect(guide.apiBaseUrl).toBe(API_BASE);
      expect(guide.webOrigin).toBe('https://app.integrai.test');
    });

    it('falls back to the API base when WEB_ORIGIN is empty', () => {
      const guide = createService({ webOrigin: ' , ' }).guide();

      expect(guide.webOrigin).toBe(API_BASE);
    });

    it('lists the three channels in onboarding order', () => {
      const guide = createService().guide();

      expect(guide.channels.map((entry) => entry.marketplace)).toEqual([
        'MERCADO_LIVRE',
        'SHOPEE',
        'AMAZON',
      ]);
    });

    it('exposes every documented field for every channel', () => {
      const guide = createService().guide();
      const keys = [
        'marketplace',
        'configured',
        'missing',
        'appIdPublic',
        'redirectUri',
        'webhookUrl',
        'oauthScopesOrTopics',
        'portalUrl',
        'docsUrl',
        'steps',
        'webhookSecretEnv',
        'webhookSecretHint',
      ].sort();

      for (const entry of guide.channels) {
        // Exact key set: no extra (potentially secret) field can ride along.
        expect(Object.keys(entry).sort()).toEqual(keys);
        expect(entry.portalUrl).toMatch(/^https:\/\//);
        expect(entry.docsUrl).toMatch(/^https:\/\//);
        expect(entry.redirectUri).toMatch(/^https?:\/\//);
        expect(entry.webhookUrl).toMatch(/^https?:\/\//);
        expect(entry.steps.length).toBeGreaterThan(0);
        expect(entry.steps.every((step) => typeof step === 'string' && step.length > 0)).toBe(true);
      }
    });
  });

  describe('configured / missing', () => {
    it('reports every channel configured when the environment has the app credentials', () => {
      const guide = createService().guide();

      for (const entry of guide.channels) {
        expect(entry.configured).toBe(true);
        expect(entry.missing).toEqual([]);
      }
      expect(channel(guide, 'MERCADO_LIVRE').appIdPublic).toBe('meli-client');
      expect(channel(guide, 'SHOPEE').appIdPublic).toBe('1000000');
      expect(channel(guide, 'AMAZON').appIdPublic).toBe('amzn1.application-oa2-client.test');
    });

    it('lists the exact missing env var names on a fresh deployment', () => {
      const guide = createService({ config: emptyConfig() }).guide();

      for (const entry of guide.channels) {
        expect(entry.configured).toBe(false);
        expect(entry.appIdPublic).toBeNull();
      }

      expect(channel(guide, 'MERCADO_LIVRE').missing).toEqual([
        'MELI_CLIENT_ID',
        'MELI_CLIENT_SECRET',
      ]);
      expect(channel(guide, 'SHOPEE').missing).toEqual([
        'SHOPEE_PARTNER_ID',
        'SHOPEE_PARTNER_KEY',
      ]);
      // The public app does not exist yet: the OAuth flow is blocked by the app
      // id alone, so the LWA pair is not listed as a separate gap.
      expect(channel(guide, 'AMAZON').missing).toEqual(['AMAZON_APP_ID']);
    });

    it('names only the absent partner id on Shopee', () => {
      const config = testChannelConfig();
      const guide = createService({
        config: { ...config, shopee: { ...config.shopee, partnerId: 0 } },
      }).guide();

      const shopee = channel(guide, 'SHOPEE');
      expect(shopee.configured).toBe(false);
      expect(shopee.missing).toEqual(['SHOPEE_PARTNER_ID']);
      expect(shopee.steps.join(' ')).toContain('SHOPEE_PARTNER_ID');
    });

    it('treats a missing Amazon secret as a blocker once the public app exists', () => {
      const config = testChannelConfig({ amazon: { lwaClientSecret: '' } });
      const guide = createService({ config }).guide();

      const amazon = channel(guide, 'AMAZON');
      expect(amazon.configured).toBe(false);
      expect(amazon.missing).toEqual(['AMAZON_LWA_CLIENT_SECRET']);
      expect(amazon.appIdPublic).toBe('amzn1.application-oa2-client.test');
      expect(amazon.steps.join(' ')).toContain('AMAZON_LWA_CLIENT_SECRET');
    });

    it('explains the public app / DPP / security assessment when Amazon is unset', () => {
      const config = testChannelConfig({
        amazon: { appId: undefined, lwaClientId: '', lwaClientSecret: '' },
      });
      const amazon = channel(createService({ config }).guide(), 'AMAZON');

      const steps = amazon.steps.join('\n');
      expect(steps).toContain('Solution Provider Portal');
      expect(steps).toContain('Private seller application');
      expect(steps).toContain('DPP');
      expect(steps).toContain('security assessment');
      expect(steps).toContain('AMAZON_APP_ID');
      expect(steps).toContain('AMAZON_OAUTH_NOT_CONFIGURED');
    });
  });

  describe('exact URLs', () => {
    it('derives the webhook URLs from APP_BASE_URL on the root ingress paths', () => {
      const guide = createService().guide();

      expect(channel(guide, 'MERCADO_LIVRE').webhookUrl).toBe(
        `${API_BASE}/webhooks/mercadolivre?secret=meli-webhook-secret`,
      );
      expect(channel(guide, 'SHOPEE').webhookUrl).toBe(`${API_BASE}/webhooks/shopee`);
      expect(channel(guide, 'AMAZON').webhookUrl).toBe(`${API_BASE}/webhooks/amazon/ses`);
    });

    it('uses the configured OAuth callbacks and strips trailing slashes from the base', () => {
      const base = testChannelConfig();
      const config: ChannelRuntimeConfig = { ...base, appBaseUrl: `${API_BASE}/` };
      const guide = createService({ config }).guide();

      expect(guide.apiBaseUrl).toBe(API_BASE);
      expect(channel(guide, 'MERCADO_LIVRE').redirectUri).toBe(
        `${API_BASE}/api/v1/accounts/oauth/mercadolivre/callback`,
      );
      expect(channel(guide, 'SHOPEE').redirectUri).toBe(
        `${API_BASE}/api/v1/accounts/oauth/shopee/callback`,
      );
      expect(channel(guide, 'AMAZON').redirectUri).toBe(
        `${API_BASE}/api/v1/accounts/oauth/amazon/callback`,
      );
      expect(channel(guide, 'MERCADO_LIVRE').webhookUrl).toBe(
        `${API_BASE}/webhooks/mercadolivre?secret=meli-webhook-secret`,
      );
    });

    it('falls back to APP_BASE_URL when a redirect env is empty', () => {
      const base = testChannelConfig();
      const config: ChannelRuntimeConfig = {
        ...base,
        meli: { ...base.meli, redirectUri: '' },
        shopee: { ...base.shopee, redirectUri: '  ' },
        amazon: { ...base.amazon, appRedirectUri: undefined },
      };
      const guide = createService({ config }).guide();

      expect(channel(guide, 'MERCADO_LIVRE').redirectUri).toBe(
        `${API_BASE}/api/v1/accounts/oauth/mercadolivre/callback`,
      );
      expect(channel(guide, 'SHOPEE').redirectUri).toBe(
        `${API_BASE}/api/v1/accounts/oauth/shopee/callback`,
      );
      expect(channel(guide, 'AMAZON').redirectUri).toBe(
        `${API_BASE}/api/v1/accounts/oauth/amazon/callback`,
      );
    });

    it('warns when a redirect points outside APP_BASE_URL (staging default left behind)', () => {
      const base = testChannelConfig();
      const config: ChannelRuntimeConfig = {
        ...base,
        meli: {
          ...base.meli,
          redirectUri: 'http://localhost:4000/api/v1/accounts/oauth/mercadolivre/callback',
        },
      };
      const meli = channel(createService({ config }).guide(), 'MERCADO_LIVRE');

      expect(meli.redirectUri).toBe(
        'http://localhost:4000/api/v1/accounts/oauth/mercadolivre/callback',
      );
      expect(meli.steps.join(' ')).toContain('MELI_REDIRECT_URI aponta para');
      expect(meli.steps.join(' ')).toContain(API_BASE);
    });
  });

  describe('oauth scopes / topics / roles', () => {
    it('uses the configured Meli topics and the documented Shopee/Amazon lists', () => {
      const guide = createService().guide();

      expect(channel(guide, 'MERCADO_LIVRE').oauthScopesOrTopics).toEqual(['questions']);
      expect(channel(guide, 'SHOPEE').oauthScopesOrTopics).toEqual([
        '2 (order status)',
        '3 (tracking)',
        '4 (sellerchat)',
        '6 (return)',
        '7 (cancellation)',
        '10 (shipping document)',
      ]);
      expect(channel(guide, 'AMAZON').oauthScopesOrTopics).toContain('Orders');
      expect(channel(guide, 'AMAZON').oauthScopesOrTopics).toContain(
        'Buyer Communication (Messaging)',
      );
    });

    it('keeps the documented default topics when MELI_WEBHOOK_TOPICS is empty', () => {
      const base = testChannelConfig();
      const config: ChannelRuntimeConfig = { ...base, meli: { ...base.meli, webhookTopics: [] } };
      const meli = channel(createService({ config }).guide(), 'MERCADO_LIVRE');

      expect(meli.oauthScopesOrTopics).toContain('questions');
      expect(meli.oauthScopesOrTopics).toContain('shipments');
    });

    it('flags the Shopee sandbox base with a production hint', () => {
      const base = testChannelConfig();
      const config: ChannelRuntimeConfig = {
        ...base,
        shopee: {
          ...base.shopee,
          apiBase: 'https://partner.test-stable.shopeemobile.com',
        },
      };
      const shopee = channel(createService({ config }).guide(), 'SHOPEE');

      expect(shopee.steps.join(' ')).toContain('sandbox');
      expect(shopee.steps.join(' ')).toContain('https://partner.shopeemobile.com');
    });
  });

  describe('webhook secrets', () => {
    it('names the signing env var per channel without exposing the value', () => {
      const guide = createService().guide();

      expect(channel(guide, 'MERCADO_LIVRE').webhookSecretEnv).toBe('MELI_WEBHOOK_SECRET');
      expect(channel(guide, 'MERCADO_LIVRE').webhookSecretHint).toContain('MELI_WEBHOOK_SECRET');
      expect(channel(guide, 'SHOPEE').webhookSecretEnv).toBe('SHOPEE_PARTNER_KEY');
      expect(channel(guide, 'SHOPEE').webhookSecretHint).toContain('SHOPEE_PARTNER_KEY');
      expect(channel(guide, 'AMAZON').webhookSecretEnv).toBe(
        'AMAZON_SES_INBOUND_SHARED_SECRET',
      );
      expect(channel(guide, 'AMAZON').webhookSecretHint).toContain(
        'AMAZON_SES_INBOUND_SHARED_SECRET',
      );
    });

    it('never serializes a secret value (configured or missing environment)', () => {
      const payloads = [
        JSON.stringify(createService().guide()),
        JSON.stringify(createService({ config: emptyConfig() }).guide()),
      ];

      for (const payload of payloads) {
        for (const secret of SECRET_VALUES) {
          expect(payload).not.toContain(secret);
        }
      }
    });

    it('never echoes the encrypted/secret fields of the runtime config', () => {
      const guide = createService().guide();
      const serialized = JSON.stringify(guide);

      // The public ids are expected; everything secret is not even read.
      expect(serialized).toContain('meli-client');
      expect(serialized).toContain('1000000');
      expect(serialized).not.toContain('clientSecret');
      expect(serialized).not.toContain('partnerKey');
    });
  });

  describe('marketplace filter', () => {
    it('returns a single channel when filtered', () => {
      for (const marketplace of ['MERCADO_LIVRE', 'SHOPEE', 'AMAZON'] as const) {
        const guide = createService().guide(marketplace);

        expect(guide.channels).toHaveLength(1);
        expect(guide.channels[0]?.marketplace).toBe(marketplace);
        expect(guide.generatedAt).toBe(NOW.toISOString());
        expect(guide.apiBaseUrl).toBe(API_BASE);
      }
    });

    it('keeps the envelope stable and does not mutate the full guide', () => {
      const service = createService();
      const full = service.guide();
      const filtered = service.guide('AMAZON');

      expect(filtered.channels).toHaveLength(1);
      expect(service.guide().channels).toHaveLength(3);
      expect(full.channels.map((entry) => entry.marketplace)).toEqual([
        'MERCADO_LIVRE',
        'SHOPEE',
        'AMAZON',
      ]);
    });
  });
});
