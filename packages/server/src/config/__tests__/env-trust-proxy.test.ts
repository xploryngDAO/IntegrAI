import { describe, expect, it } from 'vitest';

import { loadConfig } from '../index';

/**
 * `TRUST_PROXY` parsing.
 *
 * `loadConfig` receives an explicit environment map so the test never touches
 * the developer's `.env`; `NODE_ENV=test` skips the production-secret checks.
 */
describe('TRUST_PROXY configuration', () => {
  it('defaults to false (ignore X-Forwarded-For)', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.trustProxy).toBe(false);
  });

  it('accepts boolean-like values', () => {
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'TRUE' }).trustProxy).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '   ' }).trustProxy).toBe(false);
  });

  it('accepts a CSV list of trusted proxy IPs/CIDRs', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      TRUST_PROXY: ' 10.0.0.0/8 , 172.16.0.0/12,2001:db8::/32 ',
    });
    expect(config.trustProxy).toEqual(['10.0.0.0/8', '172.16.0.0/12', '2001:db8::/32']);
  });

  it('treats a list containing only separators as false', () => {
    expect(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: ' , ' }).trustProxy).toBe(false);
  });
});
