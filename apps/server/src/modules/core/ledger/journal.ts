import type { AssetCode } from '@meter/contracts';
import type { NormalBalance } from './account-taxonomy.ts';
import { LedgerError } from './ledger.errors.ts';
import type { EntryDirection, JournalEntryInput } from './ledger.types.ts';

/**
 * Pure double-entry validation (§10.1). Runs before any SQL so a malformed
 * journal never reaches a transaction, and so the rules are testable without a
 * database. The same invariant is enforced again by a deferred constraint
 * trigger, because the application is not the only possible writer.
 *
 * Returns the balanced total per asset — each asset balances independently;
 * a NGN debit never offsets a USDC credit.
 */
export function validateJournal(
  entries: readonly JournalEntryInput[],
): ReadonlyMap<AssetCode, bigint> {
  if (entries.length === 0) throw new LedgerError('UNBALANCED_JOURNAL', 'journal has no entries');

  const debits = new Map<AssetCode, bigint>();
  const credits = new Map<AssetCode, bigint>();

  for (const entry of entries) {
    if (entry.amountAtomic <= 0n) {
      throw new LedgerError('INVALID_ENTRY_AMOUNT', 'entry amounts must be positive');
    }
    const side = entry.direction === 'debit' ? debits : credits;
    side.set(entry.assetCode, (side.get(entry.assetCode) ?? 0n) + entry.amountAtomic);
  }

  const totals = new Map<AssetCode, bigint>();
  for (const asset of new Set([...debits.keys(), ...credits.keys()])) {
    const debited = debits.get(asset) ?? 0n;
    if (debited !== (credits.get(asset) ?? 0n)) {
      throw new LedgerError('UNBALANCED_JOURNAL', `asset ${asset} does not balance`);
    }
    totals.set(asset, debited);
  }
  return totals;
}

/** A debit raises a debit-normal account and lowers a credit-normal one. */
export function entryDelta(
  direction: EntryDirection,
  normalBalance: NormalBalance,
  amountAtomic: bigint,
): bigint {
  return direction === normalBalance ? amountAtomic : -amountAtomic;
}

/** Net projection change per account for one journal. */
export function projectionDeltas(
  entries: readonly JournalEntryInput[],
  normalBalances: ReadonlyMap<string, NormalBalance>,
): ReadonlyMap<string, bigint> {
  const deltas = new Map<string, bigint>();
  for (const entry of entries) {
    const normalBalance = normalBalances.get(entry.accountId);
    if (normalBalance === undefined) throw new LedgerError('ACCOUNT_NOT_FOUND', entry.accountId);
    deltas.set(
      entry.accountId,
      (deltas.get(entry.accountId) ?? 0n) + entryDelta(entry.direction, normalBalance, entry.amountAtomic),
    );
  }
  return deltas;
}
