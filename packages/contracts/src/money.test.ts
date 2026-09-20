import { describe, expect, it } from 'vitest';
import { ASSETS, fromAtomic, toAtomic } from './money.ts';

describe('money', () => {
  it('converts naira to kobo', () => {
    expect(toAtomic('1250.75', ASSETS.NGN)).toBe(125075n);
    expect(toAtomic('0.05', ASSETS.NGN)).toBe(5n);
    expect(toAtomic('-3', ASSETS.NGN)).toBe(-300n);
  });

  it('rejects precision it cannot represent instead of rounding', () => {
    expect(() => toAtomic('1.005', ASSETS.NGN)).toThrow(/precision/);
    expect(() => toAtomic('1,000', ASSETS.NGN)).toThrow();
    expect(() => toAtomic('', ASSETS.NGN)).toThrow();
  });

  it('emits one canonical form per amount, at the asset scale', () => {
    expect(fromAtomic(0n, ASSETS.NGN)).toBe('0.00');
    expect(fromAtomic(toAtomic('3', ASSETS.NGN), ASSETS.NGN)).toBe('3.00');
    expect(fromAtomic(1n, ASSETS.USDC)).toBe('0.000001');
  });

  it('round-trips exactly beyond Number.MAX_SAFE_INTEGER', () => {
    for (const value of ['0.00', '0.01', '-0.01', '99999999999999999999.99']) {
      expect(fromAtomic(toAtomic(value, ASSETS.NGN), ASSETS.NGN)).toBe(value);
    }
    // The float path silently loses this; the bigint path must not.
    expect(toAtomic('99999999999999999999.99', ASSETS.NGN)).toBe(9999999999999999999999n);
  });
});
