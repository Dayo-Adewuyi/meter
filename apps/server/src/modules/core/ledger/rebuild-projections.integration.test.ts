import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { type LedgerFixture, createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { captureCommand } from './capture.integration.test.ts';
import { CreditDebitService } from './credit-debit.service.ts';
import { RebuildProjectionsService } from './rebuild-projections.service.ts';
import { RefundService } from './refund.service.ts';
import { ReservationService } from './reservation.service.ts';
import { reserveCommand } from './reserve.integration.test.ts';

const allBalances = (db: Kysely<DB>) =>
  db
    .selectFrom('ledger.balances')
    .select(['account_id', 'posted_amount'])
    .orderBy('account_id')
    .execute();

/** Credit, reserve, capture, release and refund, so every command contributes. */
async function scenario(db: Kysely<DB>): Promise<LedgerFixture> {
  const fixture = await createLedgerFixture(db);
  const reservations = new ReservationService(db);

  await new CreditDebitService(db).credit({
    idempotencyScope: 'rebuild',
    idempotencyKey: 'credit',
    correlationId: randomUUID(),
    availableAccountId: fixture.available,
    assetCode: 'NGN',
    amountAtomic: 5_000n,
  });
  const reservation = await reservations.reserve(reserveCommand(fixture, 'reserve', 3_000n));
  const capture = await reservations.capture(
    captureCommand(reservation.reservationId, 'capture', 1_750n, fixture.payable),
  );
  await reservations.release({
    idempotencyScope: 'rebuild',
    idempotencyKey: 'release',
    correlationId: randomUUID(),
    reservationId: reservation.reservationId,
  });
  await new RefundService(db).refund({
    idempotencyScope: 'rebuild',
    idempotencyKey: 'refund',
    correlationId: randomUUID(),
    captureTransactionId: capture.transactionId,
    amountAtomic: 250n,
  });

  return fixture;
}

describe('projection rebuild', () => {
  it('replays immutable entries into the exact recorded balances', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await scenario(db);
      const service = new RebuildProjectionsService(db);
      const expected = await allBalances(db);

      await db.updateTable('ledger.balances').set({ posted_amount: '999999', version: '0' }).execute();
      const result = await service.rebuild();

      expect(await allBalances(db)).toEqual(expected);
      expect(result.accountCount).toBe(expected.length);
      await expect(fixture.balance(fixture.available)).resolves.toBe(3_500n);
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(0n);
      await expect(fixture.balance(fixture.payable)).resolves.toBe(1_500n);
    });
  }, 60_000);

  it('is identical when run twice and leaves the journal alone', async () => {
    await withMigratedDb(async (db) => {
      await scenario(db);
      const service = new RebuildProjectionsService(db);
      const transactions = await db.selectFrom('ledger.transactions').selectAll().execute();
      const outbox = await db.selectFrom('operations.outbox').selectAll().execute();

      await service.rebuild();
      const once = await allBalances(db);
      await service.rebuild();

      expect(await allBalances(db)).toEqual(once);
      // A projection rebuild is not a financial event.
      await expect(db.selectFrom('ledger.transactions').selectAll().execute()).resolves.toEqual(transactions);
      await expect(db.selectFrom('operations.outbox').selectAll().execute()).resolves.toEqual(outbox);
      await expect(db.selectFrom('ledger.idempotency').selectAll().where('scope', '=', 'rebuild.projections').execute()).resolves.toHaveLength(0);
    });
  }, 60_000);

  it('clears a stale projection for an account whose entries were never posted', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);
      await db
        .insertInto('ledger.balances')
        .values({ account_id: fixture.pending, posted_amount: '4242' })
        .execute();

      await new RebuildProjectionsService(db).rebuild();

      await expect(fixture.balance(fixture.pending)).resolves.toBe(0n);
    });
  }, 60_000);

  it('increments the version so cached readers notice the change', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await scenario(db);
      const before = await db
        .selectFrom('ledger.balances')
        .select('version')
        .where('account_id', '=', fixture.available)
        .executeTakeFirstOrThrow();

      await new RebuildProjectionsService(db).rebuild();

      const after = await db
        .selectFrom('ledger.balances')
        .select('version')
        .where('account_id', '=', fixture.available)
        .executeTakeFirstOrThrow();
      expect(BigInt(after.version)).toBeGreaterThan(BigInt(before.version));
    });
  }, 60_000);
});
