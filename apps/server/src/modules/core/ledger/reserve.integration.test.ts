import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { type LedgerFixture, createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import type { ReserveCommand } from './ledger.types.ts';
import { ReservationService } from './reservation.service.ts';

const SCOPE = 'test.reserve';

export function reserveCommand(
  fixture: LedgerFixture,
  key: string,
  amountAtomic: bigint,
): ReserveCommand {
  return {
    idempotencyScope: SCOPE,
    idempotencyKey: key,
    correlationId: randomUUID(),
    availableAccountId: fixture.available,
    reservedAccountId: fixture.reserved,
    assetCode: 'NGN',
    amountAtomic,
  };
}

async function setup(db: Kysely<DB>, funding = 1_000n) {
  const fixture = await createLedgerFixture(db, funding);
  return { fixture, service: new ReservationService(db) };
}

describe('reserve', () => {
  it('moves available to reserved in one idempotent transaction', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);

      const result = await service.reserve(reserveCommand(fixture, 'reserve-1', 600n));

      expect(result).toMatchObject({
        originalAmountAtomic: '600',
        capturedAmountAtomic: '0',
        releasedAmountAtomic: '0',
        remainingAmountAtomic: '600',
        state: 'open',
        replayed: false,
      });
      await expect(fixture.balance(fixture.available)).resolves.toBe(400n);
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(600n);
      await expect(fixture.totals()).resolves.toEqual({ debits: 1_600n, credits: 1_600n });

      await expect(service.reserve(reserveCommand(fixture, 'reserve-1', 600n))).resolves.toMatchObject({
        reservationId: result.reservationId,
        replayed: true,
      });
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(600n);
    });
  }, 60_000);

  it('refuses a reservation that would make available negative', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);

      await expect(service.reserve(reserveCommand(fixture, 'over', 1_001n))).rejects.toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
      });
      await expect(fixture.balance(fixture.available)).resolves.toBe(1_000n);
      await expect(db.selectFrom('ledger.reservations').selectAll().execute()).resolves.toHaveLength(0);
      await expect(
        db.selectFrom('ledger.idempotency').selectAll().where('key', '=', 'over').execute(),
      ).resolves.toHaveLength(0);
    });
  }, 60_000);

  it('links the reservation to its journal, projections, and outbox event', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);

      const result = await service.reserve(reserveCommand(fixture, 'linked', 250n));

      const reservation = await db
        .selectFrom('ledger.reservations')
        .selectAll()
        .where('id', '=', result.reservationId)
        .executeTakeFirstOrThrow();
      expect(reservation).toMatchObject({
        reserve_transaction_id: result.transactionId,
        available_account_id: fixture.available,
        reserved_account_id: fixture.reserved,
        original_amount: '250',
        captured_amount: '0',
        released_amount: '0',
        state: 'open',
      });
      await expect(
        db.selectFrom('operations.outbox').selectAll().where('aggregate_id', '=', result.transactionId).execute(),
      ).resolves.toHaveLength(1);
      await expect(
        db.selectFrom('ledger.idempotency').selectAll().where('key', '=', 'linked').execute(),
      ).resolves.toHaveLength(1);
    });
  }, 60_000);

  it.each([0n, -5n])('refuses a non-positive reservation of %s', async (amount) => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);

      await expect(service.reserve(reserveCommand(fixture, 'bad', amount))).rejects.toMatchObject({
        code: 'INVALID_ENTRY_AMOUNT',
      });
    });
  }, 60_000);

  it('refuses accounts that are not one customer available/reserved pair', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);
      const other = await createLedgerFixture(db);

      await expect(
        service.reserve({ ...reserveCommand(fixture, 'cross', 100n), reservedAccountId: other.reserved }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_ROLE' });
      await expect(
        service.reserve({ ...reserveCommand(fixture, 'wrong-purpose', 100n), reservedAccountId: fixture.pending }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_ROLE' });
      await expect(
        service.reserve({ ...reserveCommand(fixture, 'same', 100n), reservedAccountId: fixture.available }),
      ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_ROLE' });
    });
  }, 60_000);
});
