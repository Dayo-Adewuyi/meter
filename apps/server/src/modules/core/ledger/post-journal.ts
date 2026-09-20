import { type Transaction, sql } from 'kysely';
import type { DB } from '../../../platform/database/types.ts';
import type { NormalBalance } from './account-taxonomy.ts';
import { projectionDeltas, validateJournal } from './journal.ts';
import { LedgerError } from './ledger.errors.ts';
import type {
  PostJournalCommand,
  PostedBalance,
  PostedJournal,
  PostedJournalEntry,
} from './ledger.types.ts';

/**
 * One fixed key for every financial command, so concurrent commands serialize
 * against projection rebuild rather than racing it. Shared mode lets commands
 * run together; rebuild takes the exclusive form (§10.5).
 */
const LEDGER_LOCK_KEY = 5065494552444745n;

export async function acquireLedgerLock(
  trx: Transaction<DB>,
  mode: 'shared' | 'exclusive' = 'shared',
): Promise<void> {
  const lock =
    mode === 'shared'
      ? sql`select pg_advisory_xact_lock_shared(${LEDGER_LOCK_KEY.toString()}::bigint)`
      : sql`select pg_advisory_xact_lock(${LEDGER_LOCK_KEY.toString()}::bigint)`;
  await lock.execute(trx);
}

/**
 * The only code that writes `ledger.transactions`, `ledger.entries` and
 * `ledger.balances` (§10.1).
 *
 * Deliberately knows nothing about idempotency: command services claim the key
 * and then call this inside the same SERIALIZABLE transaction, so journal,
 * projections and outbox event commit together or not at all.
 */
export async function postJournal(
  trx: Transaction<DB>,
  command: PostJournalCommand,
): Promise<PostedJournal> {
  validateJournal(command.entries);
  await acquireLedgerLock(trx);

  // Sorted so concurrent journals touching the same accounts always lock in the
  // same order and cannot deadlock against each other.
  const accountIds = [...new Set(command.entries.map((entry) => entry.accountId))].sort();
  const accounts = await trx
    .selectFrom('ledger.accounts')
    .select(['id', 'asset_code', 'normal_balance', 'purpose', 'status'])
    .where('id', 'in', accountIds)
    .orderBy('id')
    .forUpdate()
    .execute();

  if (accounts.length !== accountIds.length) {
    const found = new Set(accounts.map((account) => account.id));
    throw new LedgerError('ACCOUNT_NOT_FOUND', accountIds.find((id) => !found.has(id)));
  }

  const byId = new Map(accounts.map((account) => [account.id, account]));
  const normalBalances = new Map<string, NormalBalance>();
  for (const entry of command.entries) {
    const account = byId.get(entry.accountId);
    if (account === undefined) throw new LedgerError('ACCOUNT_NOT_FOUND', entry.accountId);
    if (account.status !== 'active') throw new LedgerError('ACCOUNT_INACTIVE', entry.accountId);
    if (account.asset_code !== entry.assetCode) {
      throw new LedgerError(
        'ASSET_MISMATCH',
        `account ${entry.accountId} holds ${account.asset_code}, not ${entry.assetCode}`,
      );
    }
    normalBalances.set(account.id, account.normal_balance);
  }

  const transaction = await trx
    .insertInto('ledger.transactions')
    .values({
      transaction_type: command.transactionType,
      correlation_id: command.correlationId,
      state: 'posted',
      reversal_of: command.reversalOf ?? null,
      metadata: JSON.stringify(command.metadata ?? {}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const entries: PostedJournalEntry[] = command.entries.map((entry, index) => ({
    sequence: index + 1,
    accountId: entry.accountId,
    assetCode: entry.assetCode,
    direction: entry.direction,
    amountAtomic: entry.amountAtomic.toString(),
  }));

  await trx
    .insertInto('ledger.entries')
    .values(
      entries.map((entry) => ({
        transaction_id: transaction.id,
        sequence: entry.sequence,
        account_id: entry.accountId,
        direction: entry.direction,
        amount_atomic: entry.amountAtomic,
        asset_code: entry.assetCode,
      })),
    )
    .execute();

  const balances: PostedBalance[] = [];
  const deltas = [...projectionDeltas(command.entries, normalBalances)].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [accountId, delta] of deltas) {
    const updated = await trx
      .insertInto('ledger.balances')
      .values({ account_id: accountId, posted_amount: delta.toString(), version: '1' })
      .onConflict((conflict) =>
        conflict.column('account_id').doUpdateSet({
          posted_amount: sql`balances.posted_amount + ${delta.toString()}::numeric`,
          version: sql`balances.version + 1`,
        }),
      )
      .returning('posted_amount')
      .executeTakeFirstOrThrow();

    // Checked here so callers get a stable code, and again by a trigger so a
    // direct writer cannot skip it.
    if (
      byId.get(accountId)?.purpose === 'customer_available' &&
      BigInt(updated.posted_amount) < 0n
    ) {
      throw new LedgerError('INSUFFICIENT_FUNDS', accountId);
    }
    balances.push(Object.freeze({ accountId, postedAmountAtomic: updated.posted_amount }));
  }

  await trx
    .insertInto('operations.outbox')
    .values({
      aggregate_type: 'ledger.transaction',
      aggregate_id: transaction.id,
      event_type: command.event.type,
      payload: JSON.stringify(command.event.payload),
      correlation_id: command.correlationId,
    })
    .execute();

  return Object.freeze({
    transactionId: transaction.id,
    correlationId: command.correlationId,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    balances: Object.freeze(balances),
  }) satisfies PostedJournal;
}
