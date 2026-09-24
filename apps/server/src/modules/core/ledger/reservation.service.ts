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
import { postedAmount } from './credit-debit.service.ts';
import { executeIdempotent } from './idempotency.ts';
import { LedgerError } from './ledger.errors.ts';
import type {
  CaptureCommand,
  CaptureResult,
  LockedAccount,
  ReservationResult,
  ReleaseCommand,
  ReleaseResult,
  ReservationState,
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

interface LockedReservation {
  readonly id: string;
  readonly reserved_account_id: string;
  readonly available_account_id: string;
  readonly asset_code: string;
  readonly original_amount: string;
  readonly captured_amount: string;
  readonly released_amount: string;
}

/** Value still held by the authorization: neither captured nor released. */
function remainingOf(reservation: LockedReservation): bigint {
  return (
    BigInt(reservation.original_amount) -
    BigInt(reservation.captured_amount) -
    BigInt(reservation.released_amount)
  );
}

async function lockReservation(
  trx: Transaction<DB>,
  reservationId: string,
): Promise<LockedReservation> {
  const reservation = await trx
    .selectFrom('ledger.reservations')
    .select([
      'id',
      'reserved_account_id',
      'available_account_id',
      'asset_code',
      'original_amount',
      'captured_amount',
      'released_amount',
    ])
    .where('id', '=', reservationId)
    .forUpdate()
    .executeTakeFirst();
  if (reservation === undefined) throw new LedgerError('RESERVATION_NOT_FOUND', reservationId);
  return reservation;
}

/**
 * The `*InTransaction` variants let a caller commit its own state change in
 * the same transaction as the ledger movement it describes. Anything weaker
 * than SERIALIZABLE would void the balance checks those variants rely on.
 */
async function assertSerializable(trx: Transaction<DB>): Promise<void> {
  const { rows } = await sql<{ transaction_isolation: string }>`show transaction_isolation`.execute(trx);
  if (rows[0]?.transaction_isolation !== 'serializable') {
    throw new LedgerError('LEDGER_REQUIRES_SERIALIZABLE');
  }
}

@Injectable()
export class ReservationService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Optional() @Inject(RETRY_POLICY) private readonly retry: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  /** Holds value without spending it: debit available, credit reserved. */
  async reserve(command: ReserveCommand): Promise<ReservationResult> {
    return serializable(this.db, (trx) => this.reserveInTransaction(trx, command), this.retry);
  }

  /** Caller owns the SERIALIZABLE transaction and its retry. No network calls. */
  async reserveInTransaction(trx: Transaction<DB>, command: ReserveCommand): Promise<ReservationResult> {
    if (command.amountAtomic <= 0n) {
      throw new LedgerError('INVALID_ENTRY_AMOUNT', 'amount must be positive');
    }

    await assertSerializable(trx);
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

  /**
   * Settles part or all of an authorization. Capturing more than remains is a
   * normal outcome, not an error: the excess is silently dropped and reported
   * through `capped`, so a caller never moves value it never held.
   */
  async capture(command: CaptureCommand): Promise<CaptureResult> {
    return serializable(this.db, (trx) => this.captureInTransaction(trx, command), this.retry);
  }

  /** Caller owns the SERIALIZABLE transaction and its retry. No network calls. */
  async captureInTransaction(trx: Transaction<DB>, command: CaptureCommand): Promise<CaptureResult> {
    if (command.amountAtomic <= 0n) {
      throw new LedgerError('INVALID_ENTRY_AMOUNT', 'amount must be positive');
    }

    await assertSerializable(trx);
    await acquireLedgerLock(trx);
    const { result, replayed } = await executeIdempotent(
      trx,
      {
        scope: command.idempotencyScope,
        key: command.idempotencyKey,
        request: {
          kind: 'capture',
          reservationId: command.reservationId,
          destinationAccountId: command.destinationAccountId,
          amountAtomic: command.amountAtomic,
        },
      },
      () => this.postCapture(trx, command),
    );
    return { ...result, replayed };
  }

  private async postCapture(
    trx: Transaction<DB>,
    command: CaptureCommand,
  ): Promise<Omit<CaptureResult, 'replayed'>> {
    const reservation = await lockReservation(trx, command.reservationId);
    const remaining = remainingOf(reservation);
    if (remaining <= 0n) throw new LedgerError('RESERVATION_EXHAUSTED', command.reservationId);

    const captured = command.amountAtomic < remaining ? command.amountAtomic : remaining;
    const accounts = await lockAccounts(trx, [
      reservation.reserved_account_id,
      command.destinationAccountId,
    ]);
    const destination = find(accounts, command.destinationAccountId);
    if (
      destination.normal_balance !== 'credit' ||
      destination.purpose === 'customer_available' ||
      destination.purpose === 'customer_reserved'
    ) {
      throw new LedgerError('INVALID_ACCOUNT_ROLE', 'capture destination cannot hold customer value');
    }
    if (destination.status !== 'active') {
      throw new LedgerError('ACCOUNT_INACTIVE', command.destinationAccountId);
    }
    if (destination.asset_code !== reservation.asset_code) {
      throw new LedgerError('ASSET_MISMATCH', reservation.asset_code);
    }

    const assetCode = reservation.asset_code as AssetCode;
    const posted = await postJournal(trx, {
      transactionType: 'capture',
      correlationId: command.correlationId,
      entries: [
        {
          accountId: reservation.reserved_account_id,
          assetCode,
          direction: 'debit',
          amountAtomic: captured,
        },
        {
          accountId: command.destinationAccountId,
          assetCode,
          direction: 'credit',
          amountAtomic: captured,
        },
      ],
      ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
      event: {
        type: 'ledger.captured',
        payload: {
          reservationId: command.reservationId,
          destinationAccountId: command.destinationAccountId,
          assetCode,
          amountAtomic: captured.toString(),
        },
      },
    });

    await trx
      .insertInto('ledger.captures')
      .values({
        transaction_id: posted.transactionId,
        reservation_id: command.reservationId,
        destination_account_id: command.destinationAccountId,
        amount: captured.toString(),
      })
      .execute();

    const stillRemaining = remaining - captured;
    const state: ReservationState = stillRemaining === 0n ? 'captured' : 'partially_captured';
    await trx
      .updateTable('ledger.reservations')
      .set({
        captured_amount: (BigInt(reservation.captured_amount) + captured).toString(),
        state,
        updated_at: new Date(),
      })
      .where('id', '=', command.reservationId)
      .execute();

    return {
      transactionId: posted.transactionId,
      correlationId: posted.correlationId,
      reservationId: command.reservationId,
      assetCode,
      requestedAmountAtomic: command.amountAtomic.toString(),
      capturedAmountAtomic: captured.toString(),
      remainingAmountAtomic: stillRemaining.toString(),
      capped: captured < command.amountAtomic,
      state,
    };
  }

  /** Returns all unused value to the customer and closes the authorization. */
  async release(command: ReleaseCommand): Promise<ReleaseResult> {
    return serializable(this.db, (trx) => this.releaseInTransaction(trx, command), this.retry);
  }

  /** Caller owns the SERIALIZABLE transaction and its retry. No network calls. */
  async releaseInTransaction(trx: Transaction<DB>, command: ReleaseCommand): Promise<ReleaseResult> {
    await assertSerializable(trx);
    await acquireLedgerLock(trx);
    const { result, replayed } = await executeIdempotent(
      trx,
      {
        scope: command.idempotencyScope,
        key: command.idempotencyKey,
        request: { kind: 'release', reservationId: command.reservationId },
      },
      () => this.postRelease(trx, command),
    );
    return { ...result, replayed };
  }

  private async postRelease(
    trx: Transaction<DB>,
    command: ReleaseCommand,
  ): Promise<Omit<ReleaseResult, 'replayed'>> {
    const reservation = await lockReservation(trx, command.reservationId);
    const remaining = remainingOf(reservation);
    if (remaining <= 0n) throw new LedgerError('RESERVATION_EXHAUSTED', command.reservationId);

    const assetCode = reservation.asset_code as AssetCode;
    const posted = await postJournal(trx, {
      transactionType: 'release',
      correlationId: command.correlationId,
      entries: [
        {
          accountId: reservation.reserved_account_id,
          assetCode,
          direction: 'debit',
          amountAtomic: remaining,
        },
        {
          accountId: reservation.available_account_id,
          assetCode,
          direction: 'credit',
          amountAtomic: remaining,
        },
      ],
      ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
      event: {
        type: 'ledger.released',
        payload: {
          reservationId: command.reservationId,
          assetCode,
          amountAtomic: remaining.toString(),
        },
      },
    });

    await trx
      .updateTable('ledger.reservations')
      .set({
        released_amount: (BigInt(reservation.released_amount) + remaining).toString(),
        state: 'released',
        updated_at: new Date(),
      })
      .where('id', '=', command.reservationId)
      .execute();

    return {
      transactionId: posted.transactionId,
      correlationId: posted.correlationId,
      reservationId: command.reservationId,
      assetCode,
      releasedAmountAtomic: remaining.toString(),
      state: 'released',
    };
  }
}
