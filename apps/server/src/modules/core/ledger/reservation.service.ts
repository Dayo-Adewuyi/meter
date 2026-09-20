import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { DATABASE } from '../../../platform/database/database.module.ts';
import { serializable } from '../../../platform/database/transaction.ts';
import type { DB } from '../../../platform/database/types.ts';
import { postedAmount } from './credit-debit.service.ts';
import { executeIdempotent } from './idempotency.ts';
import { LedgerError } from './ledger.errors.ts';
import type {
  LockedAccount,
  ReservationResult,
  ReserveCommand,
} from './ledger.types.ts';
import { acquireLedgerLock, lockAccounts, postJournal } from './post-journal.ts';

function find(accounts: readonly LockedAccount[], id: string): LockedAccount {
  const account = accounts.find((candidate) => candidate.id === id);
  if (account === undefined) throw new LedgerError('ACCOUNT_NOT_FOUND', id);
  return account;
}

/**
 * The available and reserved accounts must be the same customer's, in the same
 * asset. Without this, a reservation could move one customer's money into
 * another's reserved account and still balance.
 */
function assertReservationPair(
  available: LockedAccount,
  reserved: LockedAccount,
  assetCode: string,
): void {
  if (available.purpose !== 'customer_available' || reserved.purpose !== 'customer_reserved') {
    throw new LedgerError('INVALID_ACCOUNT_ROLE', 'expected a customer available/reserved pair');
  }
  if (available.customer_id === null || available.customer_id !== reserved.customer_id) {
    throw new LedgerError('INVALID_ACCOUNT_ROLE', 'accounts belong to different customers');
  }
  if (available.asset_code !== assetCode || reserved.asset_code !== assetCode) {
    throw new LedgerError('ASSET_MISMATCH', assetCode);
  }
}

@Injectable()
export class ReservationService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  /** Holds value without spending it: debit available, credit reserved. */
  async reserve(command: ReserveCommand): Promise<ReservationResult> {
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
            kind: 'reserve',
            availableAccountId: command.availableAccountId,
            reservedAccountId: command.reservedAccountId,
            assetCode: command.assetCode,
            amountAtomic: command.amountAtomic,
          },
        },
        () => this.postReserve(trx, command),
      );
      return { ...result, replayed };
    });
  }

  private async postReserve(
    trx: Transaction<DB>,
    command: ReserveCommand,
  ): Promise<Omit<ReservationResult, 'replayed'>> {
    const accounts = await lockAccounts(trx, [
      command.availableAccountId,
      command.reservedAccountId,
    ]);
    assertReservationPair(
      find(accounts, command.availableAccountId),
      find(accounts, command.reservedAccountId),
      command.assetCode,
    );

    const balance = await postedAmount(trx, command.availableAccountId);
    if (balance < command.amountAtomic) {
      throw new LedgerError('INSUFFICIENT_FUNDS', command.availableAccountId);
    }

    const posted = await postJournal(trx, {
      transactionType: 'reserve',
      correlationId: command.correlationId,
      entries: [
        {
          accountId: command.availableAccountId,
          assetCode: command.assetCode,
          direction: 'debit',
          amountAtomic: command.amountAtomic,
        },
        {
          accountId: command.reservedAccountId,
          assetCode: command.assetCode,
          direction: 'credit',
          amountAtomic: command.amountAtomic,
        },
      ],
      ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
      event: {
        type: 'ledger.reserved',
        payload: {
          availableAccountId: command.availableAccountId,
          reservedAccountId: command.reservedAccountId,
          assetCode: command.assetCode,
          amountAtomic: command.amountAtomic.toString(),
        },
      },
    });

    const reservation = await trx
      .insertInto('ledger.reservations')
      .values({
        reserve_transaction_id: posted.transactionId,
        available_account_id: command.availableAccountId,
        reserved_account_id: command.reservedAccountId,
        asset_code: command.assetCode,
        original_amount: command.amountAtomic.toString(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return {
      reservationId: reservation.id,
      transactionId: posted.transactionId,
      correlationId: posted.correlationId,
      assetCode: command.assetCode,
      originalAmountAtomic: command.amountAtomic.toString(),
      capturedAmountAtomic: '0',
      releasedAmountAtomic: '0',
      remainingAmountAtomic: command.amountAtomic.toString(),
      state: 'open',
    };
  }
}
