import { describe, expect, it } from 'vitest';
import { loadConfig } from '../index';

/**
 * `loadConfig` refuses to boot a production deployment with forgeable or
 * development secrets. Shopee webhooks are signed with the partner key, so an
 * empty key would accept signatures anyone can compute.
 */
function productionEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: 'p'.repeat(48),
    ENCRYPTION_KEY_ID: 'prod-2026',
    ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    DATABASE_URL: 'postgresql://sac:secret@localhost:5432/sac_hub',
    REDIS_URL: 'redis://localhost:6379',
    APP_BASE_URL: 'https://api.integrai.example.com',
    WEB_ORIGIN: 'https://app.integrai.example.com',
    SHOPEE_PARTNER_KEY: 'shopee-partner-key-0123456789',
    S3_ACCESS_KEY_ID: 'prod-s3-access-key',
    S3_SECRET_ACCESS_KEY: 'prod-s3-secret-key',
    ...overrides,
  };
}

describe('production config safety', () => {
  it('boots with real production secrets', () => {
    const config = loadConfig(productionEnv());
    expect(config.nodeEnv).toBe('production');
    expect(config.shopee.partnerKey).toBe('shopee-partner-key-0123456789');
  });

  it('refuses an empty Shopee partner key (forgeable webhook signatures)', () => {
    expect(() => loadConfig(productionEnv({ SHOPEE_PARTNER_KEY: '' }))).toThrow(/SHOPEE_PARTNER_KEY/);
  });

  it('refuses the development JWT secret', () => {
    expect(() =>
      loadConfig(productionEnv({ JWT_SECRET: 'dev-only-change-me-please-32-chars-min' })),
    ).toThrow(/JWT_SECRET/);
  });

  it('refuses the minioadmin storage credentials', () => {
    expect(() =>
      loadConfig(productionEnv({ S3_ACCESS_KEY_ID: 'minioadmin', S3_SECRET_ACCESS_KEY: 'minioadmin' })),
    ).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it('refuses wildcard CORS origins', () => {
    expect(() =>
      loadConfig(productionEnv({ WEB_ORIGIN: 'https://app.integrai.example.com,*' })),
    ).toThrow(/WEB_ORIGIN/);
  });
});
