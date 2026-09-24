import { describe, expect, it } from 'vitest';
import { maskPhone, normalizeNigerianMobile, parseAirtimeAmount } from './airtime-request.ts';

describe('airtime request validation', () => {
  it('normalizes every common Nigerian mobile spelling to E.164', () => {
    for (const input of ['08030000000', '0803 000 0000', '+2348030000000', '2348030000000', '0803-000-0000']) {
      expect(normalizeNigerianMobile(input)).toBe('+2348030000000');
    }
    for (const input of ['0803000000', '080300000000', '05030000000', '+14155550100', 'abc', '']) {
      expect(normalizeNigerianMobile(input)).toBeNull();
    }
  });

  it('accepts whole naira from 50 to 50,000 only', () => {
    expect(parseAirtimeAmount('500.00')).toBe(50_000n);
    expect(parseAirtimeAmount('50')).toBe(5_000n);
    expect(parseAirtimeAmount('50000')).toBe(5_000_000n);
    for (const input of ['49', '50000.01', '500.50', '0', '-500', '1e3', '']) {
      expect(parseAirtimeAmount(input)).toBeNull();
    }
  });

  it('masks the middle of a number', () => {
    expect(maskPhone('+2348030000123')).toBe('+234803****123');
  });
});
