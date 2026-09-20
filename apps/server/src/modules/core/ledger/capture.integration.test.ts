import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { type LedgerFixture, createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import type { CaptureCommand } from './ledger.types.ts';
import { ReservationService } from './reservation.service.ts';
import { reserveCommand } from './reserve.integration.test.ts';

const SCOPE = 'test.capture';

export function captureCommand(
  reservationId: string,
  key: string,
  amountAtomic: bigint,
  destinationAccountId: string,
): CaptureCommand {
  return {
    idempotencyScope: SCOPE,
    idempotencyKey: key,
    correlationId: randomUUID(),
    reservationId,
    destinationAccountId,
    amountAtomic,
  };
}

async function setup(db: Kysely<DB>, reserved: bigint, funding = 1_000n) {
  const fixture = await createLedgerFixture(db, funding);
  const service = new ReservationService(db);
  const reservation = await service.reserve(reserveCommand(fixture, `reserve-${reserved}`, reserved));
  return { fixture, service, reservation };
}

const reservationRow = (db: Kysely<DB>, id: string) =>
  db.selectFrom('ledger.reservations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('capture', () => {
  it('captures no more than the remaining reservation and reports the cap', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 600n);
      const payable: string = fixture.payable;

      const first = await service.capture(captureCommand(reservation.reservationId, 'capture-1', 400n, payable));
      const capped = await service.capture(captureCommand(reservation.reservationId, 'capture-2', 400n, payable));

      expect(first).toMatchObject({
        requestedAmountAtomic: '400',
        capturedAmountAtomic: '400',
        capped: false,
        state: 'partially_captured',
      });
      expect(capped).toMatchObject({
        requestedAmountAtomic: '400',
        capturedAmountAtomic: '200',
        capped: true,
        state: 'captured',
        remainingAmountAtomic: '0',
      });
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(0n);
      await expect(fixture.balance(payable)).resolves.toBe(600n);
      await expect(fixture.totals()).resolves.toEqual({ debits: 1_600n + 600n, credits: 1_600n + 600n });
    });
  }, 60_000);

  it('refuses to capture an exhausted reservation', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 300n);
      await service.capture(captureCommand(reservation.reservationId, 'all', 300n, fixture.payable));

      await expect(
        service.capture(captureCommand(reservation.reservationId, 'again', 1n, fixture.payable)),
      ).rejects.toMatchObject({ code: 'RESERVATION_EXHAUSTED' });
      await expect(reservationRow(db, reservation.reservationId)).resolves.toMatchObject({
        captured_amount: '300',
        state: 'captured',
      });
    });
  }, 60_000);

  it('returns the exact first result for a capped retry', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 500n);
      await service.capture(captureCommand(reservation.reservationId, 'first', 300n, fixture.payable));
      const capped = await service.capture(captureCommand(reservation.reservationId, 'capped', 400n, fixture.payable));

      const retry = await service.capture(captureCommand(reservation.reservationId, 'capped', 400n, fixture.payable));

      expect(retry).toEqual({ ...capped, replayed: true });
      await expect(fixture.balance(fixture.payable)).resolves.toBe(500n);
      await expect(
        db.selectFrom('ledger.captures').selectAll().execute(),
      ).resolves.toHaveLength(2);
    });
  }, 60_000);

  it('records each capture against its reservation and journal', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 400n);

      const result = await service.capture(captureCommand(reservation.reservationId, 'linked', 150n, fixture.revenue));

      await expect(
        db.selectFrom('ledger.captures').selectAll().where('transaction_id', '=', result.transactionId).executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({
        reservation_id: reservation.reservationId,
        destination_account_id: fixture.revenue,
        amount: '150',
      });
      await expect(reservationRow(db, reservation.reservationId)).resolves.toMatchObject({
        captured_amount: '150',
        released_amount: '0',
        state: 'partially_captured',
      });
    });
  }, 60_000);

  it.each([
    ['a customer available account', 'available' as const],
    ['a customer reserved account', 'reserved' as const],
  ])('refuses %s as a capture destination', async (_name, target) => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 200n);

      await expect(
        service.capture(captureCommand(reservation.reservationId, 'bad-dest', 10n, fixture[target])),
      ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT_ROLE' });
    });
  }, 60_000);

  it('refuses an unknown reservation and a non-positive amount', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service, reservation } = await setup(db, 200n);

      await expect(
        service.capture(captureCommand(randomUUID(), 'missing', 10n, fixture.payable)),
      ).rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
      await expect(
        service.capture(captureCommand(reservation.reservationId, 'zero', 0n, fixture.payable)),
      ).rejects.toMatchObject({ code: 'INVALID_ENTRY_AMOUNT' });
    });
  }, 60_000);
});
