import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { type LedgerFixture, createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { CreditDebitService } from './credit-debit.service.ts';
import type { LedgerAmountCommand } from './ledger.types.ts';

const SCOPE = 'test.credit-debit';

function commandFor(fixture: LedgerFixture, key: string, amountAtomic: bigint): LedgerAmountCommand {
  return {
    idempotencyScope: SCOPE,
    idempotencyKey: key,
    correlationId: randomUUID(),
    availableAccountId: fixture.available,
    assetCode: 'NGN',
    amountAtomic,
  };
}

async function setup(db: Kysely<DB>, funding = 0n) {
  const fixture = await createLedgerFixture(db, funding);
  return { fixture, service: new CreditDebitService(db) };
}

describe('credit and debit commands', () => {
  it('credits and debits available value with balanced journals', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);

      const credited = await service.credit(commandFor(fixture, 'credit-1', 1_000n));
      const debited = await service.debit(commandFor(fixture, 'debit-1', 250n));

      expect(credited.amountAtomic).toBe('1000');
      expect(debited.amountAtomic).toBe('250');
      expect(credited.replayed).toBe(false);
      await expect(fixture.balance(fixture.available)).resolves.toBe(750n);
      await expect(fixture.totals()).resolves.toEqual({ debits: 1_250n, credits: 1_250n });
    });
  }, 60_000);

  it('does not debit below zero', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db, 1_000n);

      await expect(service.debit(commandFor(fixture, 'too-much', 1_001n))).rejects.toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
      });
      await expect(fixture.balance(fixture.available)).resolves.toBe(1_000n);
    });
  }, 60_000);

  it('writes no transaction, outbox row, or completed claim for a refused debit', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db, 100n);
      const before = await db.selectFrom('ledger.transactions').selectAll().execute();

      await expect(service.debit(commandFor(fixture, 'refused', 500n))).rejects.toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
      });

      await expect(db.selectFrom('ledger.transactions').selectAll().execute()).resolves.toHaveLength(
        before.length,
      );
      await expect(
        db.selectFrom('ledger.idempotency').selectAll().where('key', '=', 'refused').execute(),
      ).resolves.toHaveLength(0);
      await expect(
        db.selectFrom('operations.outbox').selectAll().where('event_type', '=', 'ledger.debited').execute(),
      ).resolves.toHaveLength(0);
    });
  }, 60_000);

  it('replays a recognized retry instead of creating value', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);

      const first = await service.credit(commandFor(fixture, 'credit-retry', 400n));
      const retry = await service.credit(commandFor(fixture, 'credit-retry', 400n));

      expect(retry.transactionId).toBe(first.transactionId);
      expect(retry.replayed).toBe(true);
      expect(first.replayed).toBe(false);
      await expect(fixture.balance(fixture.available)).resolves.toBe(400n);
      await expect(
        db.selectFrom('ledger.transactions').selectAll().where('transaction_type', '=', 'credit').execute(),
      ).resolves.toHaveLength(1);
    });
  }, 60_000);

  it('rejects the same key used for a different amount', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);

      await service.credit(commandFor(fixture, 'reused', 400n));

      await expect(service.credit(commandFor(fixture, 'reused', 401n))).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      });
      await expect(fixture.balance(fixture.available)).resolves.toBe(400n);
    });
  }, 60_000);

  it('keeps two customers isolated under the same idempotency key', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);
      const other = await createLedgerFixture(db);

      await service.credit(commandFor(fixture, 'shared-key', 100n));
      await expect(
        service.credit({ ...commandFor(other, 'shared-key', 100n), idempotencyScope: 'other' }),
      ).resolves.toMatchObject({ replayed: false });

      await expect(fixture.balance(fixture.available)).resolves.toBe(100n);
      await expect(other.balance(other.available)).resolves.toBe(100n);
    });
  }, 60_000);

  it.each([0n, -1n])('refuses a non-positive amount of %s', async (amount) => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);

      await expect(service.credit(commandFor(fixture, 'bad', amount))).rejects.toMatchObject({
        code: 'INVALID_ENTRY_AMOUNT',
      });
      await expect(
        db.selectFrom('ledger.idempotency').selectAll().execute(),
      ).resolves.toHaveLength(0);
    });
  }, 60_000);

  it('records the correlation id and an outbox event per posted command', async () => {
    await withMigratedDb(async (db) => {
      const { fixture, service } = await setup(db);
      const command = commandFor(fixture, 'traced', 600n);

      const result = await service.credit(command);

      expect(result.correlationId).toBe(command.correlationId);
      const outbox = await db
        .selectFrom('operations.outbox')
        .selectAll()
        .where('aggregate_id', '=', result.transactionId)
        .executeTakeFirstOrThrow();
      expect(outbox).toMatchObject({
        event_type: 'ledger.credited',
        correlation_id: command.correlationId,
      });
    });
  }, 60_000);
});
