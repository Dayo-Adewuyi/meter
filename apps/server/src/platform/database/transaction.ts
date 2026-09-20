import type { Kysely, Transaction } from 'kysely';

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * Financial commands run SERIALIZABLE with bounded backoff (§10.5).
 *
 * `fn` must make no external network call: a retry re-runs it from the start.
 * Statement and idle-in-transaction timeouts come from the pool, not from here.
 */
export async function serializable<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
  attempts = 5,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction().setIsolationLevel('serializable').execute(fn);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= attempts || code === undefined || !RETRYABLE.has(code)) throw error;
      await sleep(2 ** attempt * 10 + Math.random() * 20);
    }
  }
}
