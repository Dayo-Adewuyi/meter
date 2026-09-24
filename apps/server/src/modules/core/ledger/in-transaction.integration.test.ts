import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serializable } from '../../../platform/database/transaction.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { captureCommand } from './capture.integration.test.ts';
import { ReservationService } from './reservation.service.ts';
import { reserveCommand } from './reserve.integration.test.ts';

describe('transaction-scoped ledger commands', () => {
  it('refuse a transaction weaker than SERIALIZABLE', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db, 1_000n);
      const service = new ReservationService(db);
      const held = await service.reserve(reserveCommand(fixture, 'held', 100n));
      const release = {
        idempotencyScope: 'test',
        idempotencyKey: 'r',
        correlationId: randomUUID(),
        reservationId: held.reservationId,
      };

      const readCommitted = db.transaction().setIsolationLevel('read committed');
      await expect(
        readCommitted.execute((trx) => service.reserveInTransaction(trx, reserveCommand(fixture, 'x', 1n))),
      ).rejects.toMatchObject({ code: 'LEDGER_REQUIRES_SERIALIZABLE' });
      await expect(
        readCommitted.execute((trx) =>
          service.captureInTransaction(trx, captureCommand(held.reservationId, 'c', 1n, fixture.payable)),
        ),
      ).rejects.toMatchObject({ code: 'LEDGER_REQUIRES_SERIALIZABLE' });
      await expect(
        readCommitted.execute((trx) => service.releaseInTransaction(trx, release)),
      ).rejects.toMatchObject({ code: 'LEDGER_REQUIRES_SERIALIZABLE' });
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(100n);
    });
  }, 60_000);

  it('commit nothing when the caller throws after the ledger movement', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db, 1_000n);
      const service = new ReservationService(db);
      const held = await service.reserve(reserveCommand(fixture, 'held', 100n));
      const before = await db.selectFrom('ledger.transactions').select('id').execute();

      const attempts = [
        (trx: Parameters<typeof service.reserveInTransaction>[0]) =>
          service.reserveInTransaction(trx, reserveCommand(fixture, 'r', 50n)),
        (trx: Parameters<typeof service.reserveInTransaction>[0]) =>
          service.captureInTransaction(trx, captureCommand(held.reservationId, 'c', 50n, fixture.payable)),
        (trx: Parameters<typeof service.reserveInTransaction>[0]) =>
          service.releaseInTransaction(trx, {
            idempotencyScope: 'test',
            idempotencyKey: 'rel',
            correlationId: randomUUID(),
            reservationId: held.reservationId,
          }),
      ];
      for (const attempt of attempts) {
        await expect(
          serializable(db, async (trx) => {
            await attempt(trx);
            throw new Error('caller failed');
          }),
        ).rejects.toThrow('caller failed');
      }

      await expect(db.selectFrom('ledger.transactions').select('id').execute()).resolves.toHaveLength(
        before.length,
      );
      await expect(fixture.balance(fixture.available)).resolves.toBe(900n);
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(100n);
    });
  }, 60_000);
});
