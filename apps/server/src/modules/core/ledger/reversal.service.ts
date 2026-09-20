import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AssetCode } from '@meter/contracts';
import type { Kysely, Transaction } from 'kysely';
import { DATABASE } from '../../../platform/database/database.module.ts';
import {
  DEFAULT_RETRY_POLICY,
  RETRY_POLICY,
  type RetryPolicy,
  serializable,
} from '../../../platform/database/transaction.ts';
import type { DB } from '../../../platform/database/types.ts';
import { executeIdempotent } from './idempotency.ts';
import { LedgerError } from './ledger.errors.ts';
import type { JournalEntryInput, LedgerCommandResult, ReverseCommand } from './ledger.types.ts';
import { acquireLedgerLock, postJournal } from './post-journal.ts';

/**
 * These carry state beyond their journal — a reservation's captured and
 * released totals — so flipping the entries would leave that state lying about
 * what happened. They are compensated through their own commands instead.
 */
const NON_REVERSIBLE = new Set(['reserve', 'capture', 'release', 'refund', 'reverse']);

@Injectable()
export class ReversalService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Optional() @Inject(RETRY_POLICY) private readonly retry: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  /** Corrections never edit history: they add an exact opposite journal (§10.2). */
  async reverse(command: ReverseCommand): Promise<LedgerCommandResult> {
    return serializable(this.db, async (trx) => {
      await acquireLedgerLock(trx);
      const { result, replayed } = await executeIdempotent(
        trx,
        {
          scope: command.idempotencyScope,
          key: command.idempotencyKey,
          request: { kind: 'reverse', transactionId: command.transactionId },
        },
        () => this.postReversal(trx, command),
      );
      return { ...result, replayed };
    }, this.retry);
  }

  private async postReversal(
    trx: Transaction<DB>,
    command: ReverseCommand,
  ): Promise<Omit<LedgerCommandResult, 'replayed'>> {
    const original = await trx
      .selectFrom('ledger.transactions')
      .select(['id', 'transaction_type'])
      .where('id', '=', command.transactionId)
      .forUpdate()
      .executeTakeFirst();
    if (original === undefined) {
      throw new LedgerError('TRANSACTION_NOT_FOUND', command.transactionId);
    }
    if (NON_REVERSIBLE.has(original.transaction_type)) {
      throw new LedgerError('NON_REVERSIBLE_TRANSACTION', original.transaction_type);
    }

    const existing = await trx
      .selectFrom('ledger.transactions')
      .select('id')
      .where('reversal_of', '=', command.transactionId)
      .executeTakeFirst();
    if (existing !== undefined) throw new LedgerError('ALREADY_REVERSED', command.transactionId);

    const originalEntries = await trx
      .selectFrom('ledger.entries')
      .select(['account_id', 'direction', 'amount_atomic', 'asset_code'])
      .where('transaction_id', '=', command.transactionId)
      .orderBy('sequence')
      .execute();

    const entries: JournalEntryInput[] = originalEntries.map((entry) => ({
      accountId: entry.account_id,
      assetCode: entry.asset_code as AssetCode,
      direction: entry.direction === 'debit' ? 'credit' : 'debit',
      amountAtomic: BigInt(entry.amount_atomic),
    }));

    const posted = await postJournal(trx, {
      transactionType: 'reverse',
      correlationId: command.correlationId,
      entries,
      reversalOf: command.transactionId,
      metadata: { reason: command.reason, reversalOf: command.transactionId },
      event: {
        type: 'ledger.reversed',
        payload: { reversalOf: command.transactionId, reason: command.reason },
      },
    });

    // ponytail: single-asset journals are all this ledger posts today, so the
    // summary reports the first asset's debited total. Widen to a per-asset
    // result if a multi-asset journal ever appears.
    const first = entries[0];
    if (first === undefined) throw new LedgerError('UNBALANCED_JOURNAL', 'nothing to reverse');
    const total = entries
      .filter((entry) => entry.assetCode === first.assetCode && entry.direction === 'debit')
      .reduce((sum, entry) => sum + entry.amountAtomic, 0n);

    return {
      transactionId: posted.transactionId,
      correlationId: posted.correlationId,
      amountAtomic: total.toString(),
      assetCode: first.assetCode,
    };
  }
}
