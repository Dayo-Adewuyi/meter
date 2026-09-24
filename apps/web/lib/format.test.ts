import { describe, expect, it } from 'vitest';
import { naira, ratio, roman, span } from './format.ts';

describe('format', () => {
  it('groups naira from the decimal string without floats', () => {
    expect(naira('9000.00')).toBe('₦9,000.00');
    expect(naira('1234567.5')).toBe('₦1,234,567.50');
    expect(naira('0')).toBe('₦0.00');
    expect(naira('99999999999999999999.99')).toBe('₦99,999,999,999,999,999,999.99');
  });

  it('computes the used share, clamped', () => {
    expect(ratio('4500.00', '5000.00')).toBe(0.9);
    expect(ratio('0.00', '5000.00')).toBe(0);
    expect(ratio('6000.00', '5000.00')).toBe(1);
  });

  it('names windows and numbers articles', () => {
    expect(span(600)).toBe('10 minutes');
    expect(span(86_400)).toBe('one day');
    expect(roman(7)).toBe('VII');
  });
});
