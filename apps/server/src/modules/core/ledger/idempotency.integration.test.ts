import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { serializable } from '../../../platform/database/transaction.ts';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { executeIdempotent } from './idempotency.ts';

const SCOPE = 'ledger.test';

function claim(key: string, request: Record<string, unknown>) {
  return { scope: SCOPE, key, request };
}

/** A real journal row: the claim's transaction link is a live foreign key. */
async function postTransaction(trx: Transaction<DB>): Promise<{ transactionId: string }> {
  const transaction = await trx
    .insertInto('ledger.transactions')
    .values({ transaction_type: 'test', state: 'posted', correlation_id: randomUUID() })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { transactionId: transaction.id };
}

const row = (db: Kysely<DB>, key: string) =>
  db
    .selectFrom('ledger.idempotency')
    .selectAll()
    .where('scope', '=', SCOPE)
    .where('key', '=', key)
    .executeTakeFirstOrThrow();

describe('ledger command idempotency', () => {
  it('runs once, replays the first result, and rejects a changed request', async () => {
    await withMigratedDb(async (db) => {
      const operation = vi.fn(postTransaction);

      const first = await serializable(db, (trx) =>
        executeIdempotent(trx, claim('same', { amount: '10' }), () => operation(trx)),
      );
      const replay = await serializable(db, (trx) =>
        executeIdempotent(trx, claim('same', { amount: '10' }), () => operation(trx)),
      );

      expect(replay.result).toEqual(first.result);
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);

      await expect(
        serializable(db, (trx) =>
          executeIdempotent(trx, claim('same', { amount: '11' }), () => operation(trx)),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(operation).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it('ignores request key order but not request values', async () => {
    await withMigratedDb(async (db) => {
      const first = await serializable(db, (trx) =>
        executeIdempotent(trx, claim('order', { a: 1, b: 2 }), () => postTransaction(trx)),
      );
      const replay = await serializable(db, (trx) =>
        executeIdempotent(trx, claim('order', { b: 2, a: 1 }), () => postTransaction(trx)),
      );

      expect(replay.result).toEqual(first.result);
      expect(replay.replayed).toBe(true);
    });
  }, 60_000);

  it('stores the completed result with its transaction link', async () => {
    await withMigratedDb(async (db) => {
      const transaction = await db
        .insertInto('ledger.transactions')
        .values({ transaction_type: 'test', state: 'posted', correlation_id: randomUUID() })
        .returning('id')
        .executeTakeFirstOrThrow();

      const outcome = await serializable(db, (trx) =>
        executeIdempotent(trx, claim('linked', { amount: '10' }), async () => ({
          transactionId: transaction.id,
          amountAtomic: '10',
        })),
      );

      const stored = await row(db, 'linked');
      expect(stored.state).toBe('completed');
      expect(stored.transaction_id).toBe(transaction.id);
      expect(stored.result).toEqual(outcome.result);
      expect(stored.completed_at).not.toBeNull();
      expect(stored.request_digest).toMatch(/^[0-9a-f]{64}$/);
    });
  }, 60_000);

  it('leaves no claim behind when the operation fails', async () => {
    await withMigratedDb(async (db) => {
      await expect(
        serializable(db, (trx) =>
          executeIdempotent(trx, claim('boom', { amount: '10' }), async () => {
            throw new Error('operation failed');
          }),
        ),
      ).rejects.toThrow('operation failed');

      const rows = await db
        .selectFrom('ledger.idempotency')
        .selectAll()
        .where('key', '=', 'boom')
        .execute();
      expect(rows).toHaveLength(0);
    });
  }, 60_000);

  it('lets two concurrent callers observe exactly one stored result', async () => {
    await withMigratedDb(async (db) => {
      const operation = vi.fn(postTransaction);

      const outcomes = await Promise.all([
        serializable(db, (trx) =>
          executeIdempotent(trx, claim('race', { amount: '10' }), () => operation(trx)),
        ),
        serializable(db, (trx) =>
          executeIdempotent(trx, claim('race', { amount: '10' }), () => operation(trx)),
        ),
      ]);

      expect(outcomes[0]?.result).toEqual(outcomes[1]?.result);
      expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(1);
      expect(operation).toHaveBeenCalledTimes(1);
      await expect(
        db.selectFrom('ledger.idempotency').selectAll().where('key', '=', 'race').execute(),
      ).resolves.toHaveLength(1);
    });
  }, 60_000);

  it('refuses a half-written claim at the database boundary', async () => {
    await withMigratedDb(async (db) => {
      await expect(
        db
          .insertInto('ledger.idempotency')
          .values({
            scope: SCOPE,
            key: 'half',
            request_digest: 'a'.repeat(64),
            state: 'completed',
            result: null,
          })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });

      await expect(
        db
          .insertInto('ledger.idempotency')
          .values({ scope: SCOPE, key: 'short', request_digest: 'nope' })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    });
  }, 60_000);
});
