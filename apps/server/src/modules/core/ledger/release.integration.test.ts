import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { captureCommand } from './capture.integration.test.ts';
import type { ReleaseCommand } from './ledger.types.ts';
import { ReservationService } from './reservation.service.ts';
import { reserveCommand } from './reserve.integration.test.ts';

function releaseCommand(key: string, reservationId: string): ReleaseCommand {
  return {
    idempotencyScope: 'test.release',
    idempotencyKey: key,
    correlationId: randomUUID(),
    reservationId,
  };
}

async function setup(db: Kysely<DB>, reserved: bigint, funding = 1_000n) {
  const fixture = await createLedgerFixture(db, funding);
  const service = new ReservationService(db);
  const reservation = await service.reserve(reserveCommand(fixture, 'reserve', reserved));
  return { fixture, service, reservation };
}

const reservationRow = (db: Kysely<DB>, id: string) =>
  db.selectFrom('ledger.reservations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('release', () => {
  it('returns every unused atomic unit and closes the reservation', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 1_000n, 1_000n);
      await service.capture(captureCommand(reservation.reservationId, 'capture', 615n, fixture.payable));

      const release = await service.release(releaseCommand('release-1', reservation.reservationId));

      expect(release.releasedAmountAtomic).toBe('385');
      expect(615n + BigInt(release.releasedAmountAtomic)).toBe(1_000n);
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(0n);
      await expect(fixture.balance(fixture.available)).resolves.toBe(385n);
      await expect(reservationRow(db, reservation.reservationId)).resolves.toMatchObject({
        state: 'released',
        captured_amount: '615',
        released_amount: '385',
      });
    });
  }, 60_000);

  it('releases the whole reservation when nothing was captured', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 600n);

      const release = await service.release(releaseCommand('release-all', reservation.reservationId));

      expect(release).toMatchObject({ releasedAmountAtomic: '600', state: 'released', replayed: false });
      await expect(fixture.balance(fixture.available)).resolves.toBe(1_000n);
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(0n);
      await expect(fixture.totals()).resolves.toEqual({ debits: 2_200n, credits: 2_200n });
    });
  }, 60_000);

  it('refuses to release an exhausted reservation', async () => {
    await withMigratedDb(async (db) => {
      const { service, reservation } = await setup(db, 400n);
      await service.release(releaseCommand('once', reservation.reservationId));

      await expect(
        service.release(releaseCommand('twice', reservation.reservationId)),
      ).rejects.toMatchObject({ code: 'RESERVATION_EXHAUSTED' });
    });
  }, 60_000);

  it('replays a recognized retry without returning value twice', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 400n);

      const first = await service.release(releaseCommand('retry', reservation.reservationId));
      const retry = await service.release(releaseCommand('retry', reservation.reservationId));

      expect(retry).toEqual({ ...first, replayed: true });
      await expect(fixture.balance(fixture.available)).resolves.toBe(1_000n);
    });
  }, 60_000);

  it('cannot be captured after release', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 300n);
      await service.release(releaseCommand('release', reservation.reservationId));

      await expect(
        service.capture(captureCommand(reservation.reservationId, 'late', 100n, fixture.payable)),
      ).rejects.toMatchObject({ code: 'RESERVATION_EXHAUSTED' });
    });
  }, 60_000);

  it('refuses an unknown reservation', async () => {
    await withMigratedDb(async (db) => {
      const { service } = await setup(db, 100n);

      await expect(service.release(releaseCommand('missing', randomUUID()))).rejects.toMatchObject({
        code: 'RESERVATION_NOT_FOUND',
      });
    });
  }, 60_000);
});
