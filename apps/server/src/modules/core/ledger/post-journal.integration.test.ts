import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { serializable } from '../../../platform/database/transaction.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { postJournal } from './post-journal.ts';
import type { PostJournalCommand } from './ledger.types.ts';

function credit(externalCash: string, available: string, amount: bigint): PostJournalCommand {
  return {
    transactionType: 'credit',
    correlationId: randomUUID(),
    entries: [
      { accountId: externalCash, assetCode: 'NGN', direction: 'debit', amountAtomic: amount },
      { accountId: available, assetCode: 'NGN', direction: 'credit', amountAtomic: amount },
    ],
    event: { type: 'ledger.credited', payload: { amount: amount.toString() } },
  };
}

describe('postJournal', () => {
  it('commits journal, projections, and outbox together', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);
      const command = credit(fixture.externalCash, fixture.available, 1_000n);

      const result = await serializable(db, (trx) => postJournal(trx, command));

      const [entries, outbox, idempotency, transaction] = await Promise.all([
        db.selectFrom('ledger.entries').selectAll().where('transaction_id', '=', result.transactionId).orderBy('sequence').execute(),
        db.selectFrom('operations.outbox').selectAll().where('aggregate_id', '=', result.transactionId).execute(),
        db.selectFrom('ledger.idempotency').selectAll().execute(),
        db.selectFrom('ledger.transactions').selectAll().where('id', '=', result.transactionId).executeTakeFirstOrThrow(),
      ]);

      expect(entries).toHaveLength(2);
      expect(outbox).toHaveLength(1);
      // postJournal must not claim idempotency: command services own that.
      expect(idempotency).toHaveLength(0);
      expect(transaction.correlation_id).toBe(command.correlationId);
      expect(outbox[0]).toMatchObject({
        aggregate_type: 'ledger.transaction',
        event_type: 'ledger.credited',
        correlation_id: command.correlationId,
      });
      expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
      await expect(fixture.balance(fixture.available)).resolves.toBe(1_000n);
      await expect(fixture.balance(fixture.externalCash)).resolves.toBe(1_000n);
      await expect(fixture.totals()).resolves.toEqual({ debits: 1_000n, credits: 1_000n });
      expect(result.balances).toEqual(
        expect.arrayContaining([{ accountId: fixture.available, postedAmountAtomic: '1000' }]),
      );
    });
  }, 60_000);

  it('accumulates projections across journals and versions each change', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);

      await serializable(db, (trx) => postJournal(trx, credit(fixture.externalCash, fixture.available, 400n)));
      await serializable(db, (trx) => postJournal(trx, credit(fixture.externalCash, fixture.available, 600n)));

      const balance = await db
        .selectFrom('ledger.balances')
        .selectAll()
        .where('account_id', '=', fixture.available)
        .executeTakeFirstOrThrow();
      expect(balance.posted_amount).toBe('1000');
      expect(balance.version).toBe('2');
    });
  }, 60_000);

  it('rolls back every table when the outbox insert fails', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);
      // correlation_id is NOT NULL in the outbox; an invalid UUID fails there,
      // after the journal, entries and projections have already been written.
      const command = {
        ...credit(fixture.externalCash, fixture.available, 500n),
        correlationId: 'not-a-uuid',
      };

      await expect(serializable(db, (trx) => postJournal(trx, command))).rejects.toThrow();

      await expect(db.selectFrom('ledger.transactions').selectAll().execute()).resolves.toHaveLength(0);
      await expect(db.selectFrom('ledger.entries').selectAll().execute()).resolves.toHaveLength(0);
      await expect(db.selectFrom('operations.outbox').selectAll().execute()).resolves.toHaveLength(0);
      await expect(fixture.balance(fixture.available)).resolves.toBe(0n);
    });
  }, 60_000);

  it.each([
    ['an unbalanced journal', 999n, 'UNBALANCED_JOURNAL'],
    ['a zero entry', 0n, 'INVALID_ENTRY_AMOUNT'],
  ])('refuses %s before touching the database', async (_name, creditAmount, code) => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);

      await expect(
        serializable(db, (trx) =>
          postJournal(trx, {
            transactionType: 'credit',
            correlationId: randomUUID(),
            entries: [
              { accountId: fixture.externalCash, assetCode: 'NGN', direction: 'debit', amountAtomic: 1_000n },
              { accountId: fixture.available, assetCode: 'NGN', direction: 'credit', amountAtomic: creditAmount },
            ],
            event: { type: 'ledger.credited', payload: {} },
          }),
        ),
      ).rejects.toMatchObject({ code });
      await expect(db.selectFrom('ledger.transactions').selectAll().execute()).resolves.toHaveLength(0);
    });
  }, 60_000);

  it('refuses an entry whose asset does not match its account', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);

      await expect(
        serializable(db, (trx) =>
          postJournal(trx, {
            transactionType: 'credit',
            correlationId: randomUUID(),
            entries: [
              { accountId: fixture.externalCash, assetCode: 'USDC', direction: 'debit', amountAtomic: 5n },
              { accountId: fixture.available, assetCode: 'USDC', direction: 'credit', amountAtomic: 5n },
            ],
            event: { type: 'ledger.credited', payload: {} },
          }),
        ),
      ).rejects.toMatchObject({ code: 'ASSET_MISMATCH' });
    });
  }, 60_000);

  it('refuses an unknown or inactive account', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);

      await expect(
        serializable(db, (trx) => postJournal(trx, credit(fixture.externalCash, randomUUID(), 10n))),
      ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

      await db
        .updateTable('ledger.accounts')
        .set({ status: 'closed' })
        .where('id', '=', fixture.available)
        .execute();
      await expect(
        serializable(db, (trx) => postJournal(trx, credit(fixture.externalCash, fixture.available, 10n))),
      ).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    });
  }, 60_000);

  it('returns INSUFFICIENT_FUNDS rather than a negative available balance', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db, 100n);

      await expect(
        serializable(db, (trx) =>
          postJournal(trx, {
            transactionType: 'debit',
            correlationId: randomUUID(),
            entries: [
              { accountId: fixture.available, assetCode: 'NGN', direction: 'debit', amountAtomic: 101n },
              { accountId: fixture.externalCash, assetCode: 'NGN', direction: 'credit', amountAtomic: 101n },
            ],
            event: { type: 'ledger.debited', payload: {} },
          }),
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
      await expect(fixture.balance(fixture.available)).resolves.toBe(100n);
    });
  }, 60_000);
});

describe('database-level ledger invariants', () => {
  it('rejects a directly written unbalanced journal at commit', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db);

      await expect(
        db.transaction().execute(async (trx) => {
          const transaction = await trx
            .insertInto('ledger.transactions')
            .values({ transaction_type: 'rogue', state: 'posted', correlation_id: randomUUID() })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('ledger.entries')
            .values([
              { transaction_id: transaction.id, sequence: 1, account_id: fixture.externalCash, direction: 'debit', amount_atomic: '100', asset_code: 'NGN' },
              { transaction_id: transaction.id, sequence: 2, account_id: fixture.available, direction: 'credit', amount_atomic: '99', asset_code: 'NGN' },
            ])
            .execute();
        }),
      ).rejects.toMatchObject({ code: '23514' });

      await expect(db.selectFrom('ledger.entries').selectAll().execute()).resolves.toHaveLength(0);
    });
  }, 60_000);

  it('raises rather than silently affecting zero rows on entry update or delete', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db, 250n);

      await expect(
        sql`update ledger.entries set amount_atomic = 1`.execute(db),
      ).rejects.toMatchObject({ code: '23000' });
      await expect(sql`delete from ledger.entries`.execute(db)).rejects.toMatchObject({
        code: '23000',
      });
      await expect(db.selectFrom('ledger.entries').selectAll().execute()).resolves.toHaveLength(2);
      await expect(fixture.balance(fixture.available)).resolves.toBe(250n);
    });
  }, 60_000);

  it('rejects a directly written negative customer-available projection', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db, 100n);

      await expect(
        db
          .updateTable('ledger.balances')
          .set({ posted_amount: '-1' })
          .where('account_id', '=', fixture.available)
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    });
  }, 60_000);

  it('allows at most one reversal per transaction', async () => {
    await withMigratedDb(async (db) => {
      const original = await db
        .insertInto('ledger.transactions')
        .values({ transaction_type: 'credit', state: 'posted', correlation_id: randomUUID() })
        .returning('id')
        .executeTakeFirstOrThrow();
      const reversal = (sequence: number) =>
        db
          .insertInto('ledger.transactions')
          .values({
            transaction_type: `reverse_${sequence}`,
            state: 'posted',
            correlation_id: randomUUID(),
            reversal_of: original.id,
          })
          .execute();

      await expect(reversal(1)).resolves.toBeDefined();
      await expect(reversal(2)).rejects.toMatchObject({ code: '23505' });
    });
  }, 60_000);
});
