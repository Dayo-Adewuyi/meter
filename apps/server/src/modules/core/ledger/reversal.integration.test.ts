import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { type LedgerFixture, createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { CreditDebitService } from './credit-debit.service.ts';
import type { ReverseCommand } from './ledger.types.ts';
import { ReservationService } from './reservation.service.ts';
import { ReversalService } from './reversal.service.ts';
import { reserveCommand } from './reserve.integration.test.ts';

function reverseCommandFor(key: string, transactionId: string): ReverseCommand {
  return {
    idempotencyScope: 'test.reverse',
    idempotencyKey: key,
    correlationId: randomUUID(),
    transactionId,
    reason: 'operator correction',
  };
}

const entriesOf = (db: Kysely<DB>, transactionId: string) =>
  db
    .selectFrom('ledger.entries')
    .select(['sequence', 'account_id', 'direction', 'amount_atomic', 'asset_code'])
    .where('transaction_id', '=', transactionId)
    .orderBy('sequence')
    .execute();

function invertDirection<T extends { direction: string }>(entry: T): T {
  return { ...entry, direction: entry.direction === 'debit' ? 'credit' : 'debit' };
}

async function creditOf(db: Kysely<DB>, fixture: LedgerFixture, amount: bigint) {
  return new CreditDebitService(db).credit({
    idempotencyScope: 'test.reverse',
    idempotencyKey: `credit-${amount}`,
    correlationId: randomUUID(),
    availableAccountId: fixture.available,
    assetCode: 'NGN',
    amountAtomic: amount,
  });
}

describe('reversal', () => {
  it('writes an exact compensating journal and leaves the original untouched', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);
      const service = new ReversalService(db);
      const credit = await creditOf(db, fixture, 700n);
      const before = await entriesOf(db, credit.transactionId);

      const reversal = await service.reverse(reverseCommandFor('reverse-1', credit.transactionId));

      expect(await entriesOf(db, credit.transactionId)).toEqual(before);
      expect(await entriesOf(db, reversal.transactionId)).toEqual(
        before.map((entry) => invertDirection(entry)),
      );
      await expect(
        db.selectFrom('ledger.transactions').selectAll().where('id', '=', reversal.transactionId).executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ reversal_of: credit.transactionId, transaction_type: 'reverse' });
      expect(reversal).toMatchObject({ amountAtomic: '700', assetCode: 'NGN', replayed: false });
      await expect(fixture.balance(fixture.available)).resolves.toBe(0n);
      await expect(fixture.totals()).resolves.toEqual({ debits: 1_400n, credits: 1_400n });
    });
  }, 60_000);

  it('records the reason and an outbox event', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);
      const credit = await creditOf(db, fixture, 100n);

      const reversal = await new ReversalService(db).reverse(
        reverseCommandFor('reason', credit.transactionId),
      );

      const transaction = await db
        .selectFrom('ledger.transactions')
        .selectAll()
        .where('id', '=', reversal.transactionId)
        .executeTakeFirstOrThrow();
      expect(transaction.metadata).toMatchObject({ reason: 'operator correction' });
      await expect(
        db.selectFrom('operations.outbox').selectAll().where('aggregate_id', '=', reversal.transactionId).executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ event_type: 'ledger.reversed' });
    });
  }, 60_000);

  it('cannot create a second reversal of the same transaction', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);
      const service = new ReversalService(db);
      const credit = await creditOf(db, fixture, 300n);
      await service.reverse(reverseCommandFor('first', credit.transactionId));

      await expect(
        service.reverse(reverseCommandFor('second', credit.transactionId)),
      ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
      await expect(
        db.selectFrom('ledger.transactions').selectAll().where('reversal_of', '=', credit.transactionId).execute(),
      ).resolves.toHaveLength(1);
      await expect(fixture.balance(fixture.available)).resolves.toBe(0n);
    });
  }, 60_000);

  it('replays a recognized retry rather than reversing twice', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);
      const service = new ReversalService(db);
      const credit = await creditOf(db, fixture, 300n);

      const first = await service.reverse(reverseCommandFor('retry', credit.transactionId));
      const retry = await service.reverse(reverseCommandFor('retry', credit.transactionId));

      expect(retry).toEqual({ ...first, replayed: true });
      await expect(fixture.balance(fixture.available)).resolves.toBe(0n);
    });
  }, 60_000);

  it('refuses state-machine transactions that need coordinated compensation', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db, 1_000n);
      const reservations = new ReservationService(db);
      const service = new ReversalService(db);
      const reservation = await reservations.reserve(reserveCommand(fixture, 'reserve', 400n));

      await expect(
        service.reverse(reverseCommandFor('no-reserve', reservation.transactionId)),
      ).rejects.toMatchObject({ code: 'NON_REVERSIBLE_TRANSACTION' });
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(400n);
    });
  }, 60_000);

  it('refuses an unknown transaction', async () => {
    await withMigratedDb(async (db) => {
      await expect(
        new ReversalService(db).reverse(reverseCommandFor('missing', randomUUID())),
      ).rejects.toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
    });
  }, 60_000);
});
