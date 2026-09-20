import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AssetCode } from '@meter/contracts';
import { type Kysely, type Transaction, sql } from 'kysely';
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
import type { RefundCommand, RefundResult } from './ledger.types.ts';
import { acquireLedgerLock, lockAccounts, postJournal } from './post-journal.ts';

@Injectable()
export class RefundService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Optional() @Inject(RETRY_POLICY) private readonly retry: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  /**
   * Returns captured value to the customer it came from, never more than that
   * capture still holds (§10.4).
   */
  async refund(command: RefundCommand): Promise<RefundResult> {
    if (command.amountAtomic <= 0n) {
      throw new LedgerError('INVALID_ENTRY_AMOUNT', 'amount must be positive');
    }

    return serializable(this.db, async (trx) => {
      await acquireLedgerLock(trx);
      const { result, replayed } = await executeIdempotent(
        trx,
        {
          scope: command.idempotencyScope,
          key: command.idempotencyKey,
          request: {
            kind: 'refund',
            captureTransactionId: command.captureTransactionId,
            amountAtomic: command.amountAtomic,
          },
        },
        () => this.postRefund(trx, command),
      );
      return { ...result, replayed };
    }, this.retry);
  }

  private async postRefund(
    trx: Transaction<DB>,
    command: RefundCommand,
  ): Promise<Omit<RefundResult, 'replayed'>> {
    const capture = await trx
      .selectFrom('ledger.captures')
      .innerJoin('ledger.reservations', 'ledger.reservations.id', 'ledger.captures.reservation_id')
      .select([
        'ledger.captures.transaction_id as transaction_id',
        'ledger.captures.destination_account_id as destination_account_id',
        'ledger.captures.amount as amount',
        'ledger.reservations.available_account_id as available_account_id',
        'ledger.reservations.asset_code as asset_code',
      ])
      .where('ledger.captures.transaction_id', '=', command.captureTransactionId)
      .forUpdate()
      .executeTakeFirst();
    if (capture === undefined) {
      throw new LedgerError('CAPTURE_NOT_FOUND', command.captureTransactionId);
    }

    const prior = await trx
      .selectFrom('ledger.refunds')
      .select(sql<string>`coalesce(sum(amount), 0)`.as('total'))
      .where('capture_transaction_id', '=', command.captureTransactionId)
      .executeTakeFirstOrThrow();

    const ceiling = BigInt(capture.amount) - BigInt(prior.total);
    if (command.amountAtomic > ceiling) {
      throw new LedgerError(
        'REFUND_CEILING_EXCEEDED',
        `at most ${ceiling.toString()} remains refundable`,
      );
    }

    const assetCode = capture.asset_code as AssetCode;
    await lockAccounts(trx, [capture.destination_account_id, capture.available_account_id]);

    const posted = await postJournal(trx, {
      transactionType: 'refund',
      correlationId: command.correlationId,
      entries: [
        {
          accountId: capture.destination_account_id,
          assetCode,
          direction: 'debit',
          amountAtomic: command.amountAtomic,
        },
        {
          accountId: capture.available_account_id,
          assetCode,
          direction: 'credit',
          amountAtomic: command.amountAtomic,
        },
      ],
      ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
      event: {
        type: 'ledger.refunded',
        payload: {
          captureTransactionId: command.captureTransactionId,
          assetCode,
          amountAtomic: command.amountAtomic.toString(),
        },
      },
    });

    await trx
      .insertInto('ledger.refunds')
      .values({
        transaction_id: posted.transactionId,
        capture_transaction_id: command.captureTransactionId,
        amount: command.amountAtomic.toString(),
      })
      .execute();

    return {
      transactionId: posted.transactionId,
      correlationId: posted.correlationId,
      captureTransactionId: command.captureTransactionId,
      assetCode,
      refundedAmountAtomic: command.amountAtomic.toString(),
      remainingRefundableAtomic: (ceiling - command.amountAtomic).toString(),
    };
  }
}
