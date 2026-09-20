import { describe, expect, it } from 'vitest';
import { canonicalJson, digestRequest } from './canonical-request.ts';

describe('canonical request digesting', () => {
  it('hashes semantic object equality identically and distinguishes bigint values', () => {
    expect(digestRequest({ b: 2n, a: 'x' })).toBe(digestRequest({ a: 'x', b: 2n }));
    expect(digestRequest({ amount: 2n })).not.toBe(digestRequest({ amount: 3n }));
  });

  it('sorts keys at every depth but never reorders arrays', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"b":{"c":2,"d":1}}');
    expect(digestRequest([1, 2])).not.toBe(digestRequest([2, 1]));
  });

  it('never conflates a bigint with its decimal string or number', () => {
    expect(canonicalJson(2n)).toBe('{"$bigint":"2"}');
    expect(digestRequest({ amount: 2n })).not.toBe(digestRequest({ amount: '2' }));
    expect(digestRequest({ amount: 2n })).not.toBe(digestRequest({ amount: 2 }));
  });

  it('keeps precision that a double would lose', () => {
    expect(canonicalJson(9_007_199_254_740_993n)).toBe('{"$bigint":"9007199254740993"}');
  });

  it('encodes dates as an exact instant rather than an empty object', () => {
    expect(canonicalJson({ at: new Date('2026-09-20T12:00:00.000Z') })).toBe(
      '{"at":"2026-09-20T12:00:00.000Z"}',
    );
  });

  it.each([
    ['undefined', { a: undefined }],
    ['a function', { a: () => 1 }],
    ['a symbol', { a: Symbol('a') }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
  ])('refuses to digest %s rather than dropping it', (_name, value) => {
    expect(() => digestRequest(value)).toThrow();
  });

  it('produces a lowercase 64-character digest', () => {
    expect(digestRequest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
