import { describe, expect, it } from 'vitest';
import {
  joinBaseUrl,
  queryToStringRecord,
  stripQuery,
} from '../utils/query';

/**
 * `queryToStringRecord` feeds the raw webhook signature inputs with Fastify's
 * parsed query object. The keys are attacker-controlled: the function must not
 * let `__proto__`/`constructor`/`prototype` reach the object graph.
 */
describe('queryToStringRecord', () => {
  it('flattens strings, numbers, booleans and arrays (first string wins)', () => {
    const result = queryToStringRecord({
      token: 'abc',
      page: 2,
      active: true,
      nested: { not: 'a string' },
      list: ['first', 'second'],
      mixed: [1, 'winner', 'other'],
    });

    expect(result).toEqual({
      token: 'abc',
      page: '2',
      active: 'true',
      list: 'first',
      mixed: 'winner',
    });
    expect(result.nested).toBeUndefined();
  });

  it('never lets prototype-pollution keys reach the object graph', () => {
    const result = queryToStringRecord({
      __proto__: 'polluted',
      constructor: 'polluted',
      prototype: 'polluted',
      safe: 'ok',
    });

    expect(result.safe).toBe('ok');
    expect(Object.keys(result)).toEqual(['safe']);
    expect(Object.getPrototypeOf(result)).toBe(null);
    // The global prototype is untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns an empty null-prototype record for non-objects', () => {
    for (const input of [null, undefined, 'string', 42, ['array']]) {
      const result = queryToStringRecord(input);
      expect(Object.keys(result)).toEqual([]);
      expect(Object.getPrototypeOf(result)).toBe(null);
    }
  });
});

describe('URL helpers', () => {
  it('stripQuery keeps only the path', () => {
    expect(stripQuery('/api/v1/webhooks?x=1')).toBe('/api/v1/webhooks');
    expect(stripQuery('/api/v1/webhooks')).toBe('/api/v1/webhooks');
  });

  it('joinBaseUrl normalizes slashes', () => {
    expect(joinBaseUrl('https://api.example.com/', '/webhook')).toBe(
      'https://api.example.com/webhook',
    );
    expect(joinBaseUrl('https://api.example.com', 'webhook')).toBe(
      'https://api.example.com/webhook',
    );
  });
});
