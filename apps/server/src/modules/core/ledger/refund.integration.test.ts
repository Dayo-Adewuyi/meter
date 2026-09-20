import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { type LedgerFixture, createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { captureCommand } from './capture.integration.test.ts';
import type { RefundCommand } from './ledger.types.ts';
import { RefundService } from './refund.service.ts';
import { ReservationService } from './reservation.service.ts';
import { reserveCommand } from './reserve.integration.test.ts';

function refundCommand(key: string, captureTransactionId: string, amountAtomic: bigint): RefundCommand {
  return {
    idempotencyScope: 'test.refund',
    idempotencyKey: key,
    correlationId: randomUUID(),
    captureTransactionId,
    amountAtomic,
  };
}

async function captured(db: Kysely<DB>, amount: bigint, funding = 1_000n) {
  const fixture: LedgerFixture = await createLedgerFixture(db, funding);
  const reservations = new ReservationService(db);
  const reservation = await reservations.reserve(reserveCommand(fixture, 'reserve', amount));
  const capture = await reservations.capture(
    captureCommand(reservation.reservationId, 'capture', amount, fixture.payable),
  );
  return { fixture, capture, service: new RefundService(db) };
}

describe('refund', () => {
  it('allows partial refunds but never exceeds capture minus prior refunds', async () => {
    await withMigratedDb(async (db) => {
      const { capture, service } = await captured(db, 600n);

      await expect(service.refund(refundCommand('refund-1', capture.transactionId, 250n))).resolves.toMatchObject({
        refundedAmountAtomic: '250',
        remainingRefundableAtomic: '350',
      });
      await expect(service.refund(refundCommand('refund-2', capture.transactionId, 351n))).rejects.toMatchObject({
        code: 'REFUND_CEILING_EXCEEDED',
      });
      await expect(service.refund(refundCommand('refund-3', capture.transactionId, 350n))).resolves.toMatchObject({
        remainingRefundableAtomic: '0',
      });
    });
  }, 60_000);

  it('returns refunded value to the customer and keeps the trial balance', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, capture, service } = await captured(db, 600n);

      await service.refund(refundCommand('full', capture.transactionId, 600n));

      await expect(fixture.balance(fixture.payable)).resolves.toBe(0n);
      await expect(fixture.balance(fixture.available)).resolves.toBe(1_000n);
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(0n);
      const totals = await fixture.totals();
      expect(totals.debits).toBe(totals.credits);
    });
  }, 60_000);

  it('records each refund against its capture', async () => {
    await withMigratedDb(async (db) => {
      const { capture, service } = await captured(db, 400n);

      const result = await service.refund(refundCommand('linked', capture.transactionId, 100n));

      await expect(
        db.selectFrom('ledger.refunds').selectAll().where('transaction_id', '=', result.transactionId).executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ capture_transaction_id: capture.transactionId, amount: '100' });
      await expect(
        db.selectFrom('operations.outbox').selectAll().where('aggregate_id', '=', result.transactionId).executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ event_type: 'ledger.refunded' });
    });
  }, 60_000);

  it('creates no additional value on a recognized retry', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, capture, service } = await captured(db, 400n);

      const first = await service.refund(refundCommand('retry', capture.transactionId, 150n));
      const retry = await service.refund(refundCommand('retry', capture.transactionId, 150n));

      expect(retry).toEqual({ ...first, replayed: true });
      await expect(fixture.balance(fixture.available)).resolves.toBe(750n);
      await expect(db.selectFrom('ledger.refunds').selectAll().execute()).resolves.toHaveLength(1);
    });
  }, 60_000);

  it.each([0n, -1n])('refuses a non-positive refund of %s', async (amount) => {
    await withMigratedDb(async (db) => {
      const { capture, service } = await captured(db, 200n);

      await expect(service.refund(refundCommand('bad', capture.transactionId, amount))).rejects.toMatchObject({
        code: 'INVALID_ENTRY_AMOUNT',
      });
    });
  }, 60_000);

  it('refuses an unknown capture', async () => {
    await withMigratedDb(async (db) => {
      const { service } = await captured(db, 200n);

      await expect(service.refund(refundCommand('missing', randomUUID(), 10n))).rejects.toMatchObject({
        code: 'CAPTURE_NOT_FOUND',
      });
    });
  }, 60_000);
});
