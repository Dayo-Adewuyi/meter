import { describe, expect, it } from 'vitest';
import { entryDelta, projectionDeltas, validateJournal } from './journal.ts';
import type { JournalEntryInput } from './ledger.types.ts';

const cashNgn = '00000000-0000-7000-8000-000000000001';
const customerNgn = '0199a1b2-c3d4-7000-8000-00000000aaaa';

function entry(
  accountId: string,
  direction: 'debit' | 'credit',
  amountAtomic: bigint,
  assetCode: 'NGN' | 'USDC' = 'NGN',
): JournalEntryInput {
  return { accountId, direction, amountAtomic, assetCode };
}

describe('journal validation', () => {
  it('requires positive entries balanced independently by asset', () => {
    expect(() =>
      validateJournal([entry(cashNgn, 'debit', 100n), entry(customerNgn, 'credit', 99n)]),
    ).toThrowError(expect.objectContaining({ code: 'UNBALANCED_JOURNAL' }));
    expect(() => validateJournal([entry(cashNgn, 'debit', 0n)])).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENTRY_AMOUNT' }),
    );
    expect(() => validateJournal([entry(cashNgn, 'debit', -1n)])).toThrowError(
      expect.objectContaining({ code: 'INVALID_ENTRY_AMOUNT' }),
    );
    expect(() => validateJournal([])).toThrowError(
      expect.objectContaining({ code: 'UNBALANCED_JOURNAL' }),
    );
  });

  it('never lets one asset offset another', () => {
    expect(() =>
      validateJournal([
        entry(cashNgn, 'debit', 100n, 'NGN'),
        entry(customerNgn, 'credit', 100n, 'USDC'),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'UNBALANCED_JOURNAL' }));
  });

  it('returns the balanced total per asset', () => {
    const totals = validateJournal([
      entry(cashNgn, 'debit', 100n, 'NGN'),
      entry(customerNgn, 'credit', 100n, 'NGN'),
      entry(cashNgn, 'debit', 7n, 'USDC'),
      entry(customerNgn, 'credit', 7n, 'USDC'),
    ]);

    expect([...totals]).toEqual([
      ['NGN', 100n],
      ['USDC', 7n],
    ]);
  });

  it('stays exact past the range a double can represent', () => {
    const huge = 9_007_199_254_740_993n;
    const totals = validateJournal([
      entry(cashNgn, 'debit', huge),
      entry(customerNgn, 'credit', huge),
    ]);

    expect(totals.get('NGN')).toBe(huge);
  });

  it('nets multiple entries for the same account against its normal balance', () => {
    expect(entryDelta('debit', 'debit', 100n)).toBe(100n);
    expect(entryDelta('credit', 'debit', 100n)).toBe(-100n);
    expect(entryDelta('credit', 'credit', 100n)).toBe(100n);
    expect(entryDelta('debit', 'credit', 100n)).toBe(-100n);

    const deltas = projectionDeltas(
      [
        entry(cashNgn, 'debit', 100n),
        entry(customerNgn, 'credit', 100n),
        entry(customerNgn, 'debit', 30n),
      ],
      new Map([
        [cashNgn, 'debit' as const],
        [customerNgn, 'credit' as const],
      ]),
    );

    expect(deltas.get(cashNgn)).toBe(100n);
    expect(deltas.get(customerNgn)).toBe(70n);
  });

  it('refuses to project an account it was not given', () => {
    expect(() => projectionDeltas([entry(cashNgn, 'debit', 1n)], new Map())).toThrowError(
      expect.objectContaining({ code: 'ACCOUNT_NOT_FOUND' }),
    );
  });
});
