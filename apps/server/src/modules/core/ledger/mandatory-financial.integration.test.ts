import { randomUUID } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY } from '../../../platform/database/transaction.ts';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { type LedgerFixture, createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { CreditDebitService } from './credit-debit.service.ts';
import { LedgerError } from './ledger.errors.ts';
import { RebuildProjectionsService } from './rebuild-projections.service.ts';
import { ReservationService } from './reservation.service.ts';

/**
 * The eight invariants that must hold before any financial change merges
 * (§10.6). Each one queries persisted state for itself rather than trusting a
 * command's return value, because the return value is exactly what a bug
 * would get wrong.
 */

const scopeFor = (fixture: LedgerFixture) => `mandatory-${fixture.customerId}`;

function creditCommand(fixture: LedgerFixture, key: string, amountAtomic: bigint) {
  return {
    idempotencyScope: scopeFor(fixture),
    idempotencyKey: key,
    correlationId: randomUUID(),
    availableAccountId: fixture.available,
    assetCode: 'NGN' as const,
    amountAtomic,
  };
}

function reserveCommandFor(fixture: LedgerFixture, key: string, amountAtomic: bigint) {
  return {
    idempotencyScope: scopeFor(fixture),
    idempotencyKey: key,
    correlationId: randomUUID(),
    availableAccountId: fixture.available,
    reservedAccountId: fixture.reserved,
    assetCode: 'NGN' as const,
    amountAtomic,
  };
}

/** Debits minus credits per asset, read straight from the entry rows. */
async function journalImbalances(db: Kysely<DB>): Promise<unknown[]> {
  const result = await sql<{ transaction_id: string; asset_code: string }>`
    select transaction_id, asset_code
    from ledger.entries
    group by transaction_id, asset_code
    having sum(case when direction = 'debit' then amount_atomic else 0 end)
        <> sum(case when direction = 'credit' then amount_atomic else 0 end)
  `.execute(db);
  return result.rows;
}

async function verifyBalancedJournals(): Promise<void> {
  await withMigratedDb(async (db) => {
    const fixture = await createLedgerFixture(db, 5_000n);
    const reservations = new ReservationService(db);
    const reservation = await reservations.reserve(reserveCommandFor(fixture, 'reserve', 3_000n));
    await reservations.capture({
      idempotencyScope: scopeFor(fixture),
      idempotencyKey: 'capture',
      correlationId: randomUUID(),
      reservationId: reservation.reservationId,
      destinationAccountId: fixture.payable,
      amountAtomic: 1_200n,
    });
    await reservations.release({
      idempotencyScope: scopeFor(fixture),
      idempotencyKey: 'release',
      correlationId: randomUUID(),
      reservationId: reservation.reservationId,
    });

    expect(await journalImbalances(db)).toEqual([]);
    const totals = await fixture.totals();
    expect(totals.debits).toBe(totals.credits);
  });
}

async function verifyAppendOnlyEntries(): Promise<void> {
  await withMigratedDb(async (db) => {
    await createLedgerFixture(db, 750n);
    const before = await db.selectFrom('ledger.entries').selectAll().orderBy('transaction_id').execute();
    expect(before.length).toBeGreaterThan(0);

    await expect(sql`update ledger.entries set amount_atomic = 1`.execute(db)).rejects.toMatchObject({
      code: '23000',
    });
    await expect(sql`delete from ledger.entries`.execute(db)).rejects.toMatchObject({ code: '23000' });

    const after = await db.selectFrom('ledger.entries').selectAll().orderBy('transaction_id').execute();
    expect(after).toEqual(before);
  });
}

async function verifyNonNegativeAvailability(): Promise<void> {
  await withMigratedDb(async (db) => {
    const fixture = await createLedgerFixture(db, 500n);

    await expect(
      new CreditDebitService(db).debit(creditCommand(fixture, 'overdraw', 501n)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    // Even a writer that bypasses the command layer cannot go negative.
    await expect(
      db.updateTable('ledger.balances').set({ posted_amount: '-1' }).where('account_id', '=', fixture.available).execute(),
    ).rejects.toMatchObject({ code: '23514' });

    const stored = await db
      .selectFrom('ledger.balances')
      .select('posted_amount')
      .where('account_id', '=', fixture.available)
      .executeTakeFirstOrThrow();
    expect(BigInt(stored.posted_amount)).toBe(500n);
  });
}

async function verifyConcurrentReservations(): Promise<void> {
  await withMigratedDb(async (db) => {
    const fixture = await createLedgerFixture(db, 1_000n);
    const service = new ReservationService(db, DEFAULT_RETRY_POLICY);

    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_unused, index) =>
        service.reserve(reserveCommandFor(fixture, `parallel-${index}`, 100n)),
      ),
    );

    const declined = settled.filter((result) => result.status === 'rejected');
    expect(declined).toHaveLength(10);
    expect(
      declined.every(
        (result) =>
          (result as PromiseRejectedResult).reason instanceof LedgerError &&
          ((result as PromiseRejectedResult).reason as LedgerError).code === 'INSUFFICIENT_FUNDS',
      ),
    ).toBe(true);

    const reservations = await db.selectFrom('ledger.reservations').selectAll().execute();
    const balances = await db
      .selectFrom('ledger.balances')
      .select(['account_id', 'posted_amount'])
      .where('account_id', 'in', [fixture.available, fixture.reserved])
      .execute();
    expect(reservations).toHaveLength(10);
    expect(
      balances.find((row) => row.account_id === fixture.available)?.posted_amount,
    ).toBe('0');
    expect(balances.find((row) => row.account_id === fixture.reserved)?.posted_amount).toBe('1000');
    expect(await journalImbalances(db)).toEqual([]);
  });
}

async function verifyCaptureCeiling(): Promise<void> {
  await withMigratedDb(async (db) => {
    const fixture = await createLedgerFixture(db, 1_000n);
    const service = new ReservationService(db);
    const reservation = await service.reserve(reserveCommandFor(fixture, 'reserve', 600n));
    const capture = (key: string, amountAtomic: bigint) =>
      service.capture({
        idempotencyScope: scopeFor(fixture),
        idempotencyKey: key,
        correlationId: randomUUID(),
        reservationId: reservation.reservationId,
        destinationAccountId: fixture.payable,
        amountAtomic,
      });

    await capture('one', 400n);
    await capture('two', 400n);

    const row = await db
      .selectFrom('ledger.reservations')
      .selectAll()
      .where('id', '=', reservation.reservationId)
      .executeTakeFirstOrThrow();
    expect(BigInt(row.captured_amount)).toBe(600n);
    expect(BigInt(row.captured_amount)).toBeLessThanOrEqual(BigInt(row.original_amount));
    const captured = await db
      .selectFrom('ledger.captures')
      .select('amount')
      .where('reservation_id', '=', reservation.reservationId)
      .execute();
    expect(captured.reduce((sum, item) => sum + BigInt(item.amount), 0n)).toBe(600n);
  });
}

async function verifyReservationClosure(): Promise<void> {
  await withMigratedDb(async (db) => {
    const fixture = await createLedgerFixture(db, 1_000n);
    const service = new ReservationService(db);
    const reservation = await service.reserve(reserveCommandFor(fixture, 'reserve', 1_000n));
    await service.capture({
      idempotencyScope: scopeFor(fixture),
      idempotencyKey: 'capture',
      correlationId: randomUUID(),
      reservationId: reservation.reservationId,
      destinationAccountId: fixture.payable,
      amountAtomic: 615n,
    });
    await service.release({
      idempotencyScope: scopeFor(fixture),
      idempotencyKey: 'release',
      correlationId: randomUUID(),
      reservationId: reservation.reservationId,
    });

    const row = await db
      .selectFrom('ledger.reservations')
      .selectAll()
      .where('id', '=', reservation.reservationId)
      .executeTakeFirstOrThrow();
    expect(BigInt(row.captured_amount) + BigInt(row.released_amount)).toBe(BigInt(row.original_amount));
    expect(row.state).toBe('released');
    await expect(fixture.balance(fixture.reserved)).resolves.toBe(0n);
  });
}

async function verifyIdempotentRetries(): Promise<void> {
  await withMigratedDb(async (db) => {
    const fixture = await createLedgerFixture(db);
    const service = new CreditDebitService(db);

    const first = await service.credit(creditCommand(fixture, 'retry', 900n));
    for (let attempt = 0; attempt < 4; attempt++) {
      await service.credit(creditCommand(fixture, 'retry', 900n));
    }

    const journals = await db
      .selectFrom('ledger.transactions')
      .selectAll()
      .where('transaction_type', '=', 'credit')
      .execute();
    const claims = await db
      .selectFrom('ledger.idempotency')
      .selectAll()
      .where('key', '=', 'retry')
      .execute();
    expect(journals).toHaveLength(1);
    expect(journals[0]?.id).toBe(first.transactionId);
    expect(claims).toHaveLength(1);
    await expect(fixture.balance(fixture.available)).resolves.toBe(900n);
    await expect(
      db.selectFrom('operations.outbox').selectAll().where('event_type', '=', 'ledger.credited').execute(),
    ).resolves.toHaveLength(1);
  });
}

async function verifyProjectionRebuild(): Promise<void> {
  await withMigratedDb(async (db) => {
    const fixture = await createLedgerFixture(db, 2_000n);
    const service = new ReservationService(db);
    const reservation = await service.reserve(reserveCommandFor(fixture, 'reserve', 1_200n));
    await service.capture({
      idempotencyScope: scopeFor(fixture),
      idempotencyKey: 'capture',
      correlationId: randomUUID(),
      reservationId: reservation.reservationId,
      destinationAccountId: fixture.payable,
      amountAtomic: 700n,
    });

    const recorded = await db
      .selectFrom('ledger.balances')
      .select(['account_id', 'posted_amount'])
      .orderBy('account_id')
      .execute();

    await db.updateTable('ledger.balances').set({ posted_amount: '999999' }).execute();
    await new RebuildProjectionsService(db).rebuild();

    const rebuilt = await db
      .selectFrom('ledger.balances')
      .select(['account_id', 'posted_amount'])
      .orderBy('account_id')
      .execute();
    expect(rebuilt).toEqual(recorded);
  });
}

describe('mandatory financial invariants', () => {
  it('every posted journal balances by asset', verifyBalancedJournals, 300_000);
  it('posted entries cannot be edited or deleted', verifyAppendOnlyEntries, 300_000);
  it('available balance cannot become negative', verifyNonNegativeAvailability, 300_000);
  it('concurrent authorizations cannot overspend', verifyConcurrentReservations, 300_000);
  it('capture cannot exceed reservation', verifyCaptureCeiling, 300_000);
  it('capture plus release equals the original reservation', verifyReservationClosure, 300_000);
  it('recognized retries cannot create value', verifyIdempotentRetries, 300_000);
  it('projection rebuild produces recorded balances', verifyProjectionRebuild, 300_000);
});
