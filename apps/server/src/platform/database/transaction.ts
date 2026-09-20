import type { Kysely, Transaction } from 'kysely';

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

export interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  /** Called once per attempt, so tests can bound observed retries. */
  readonly onAttempt?: (attempt: number) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const RETRY_POLICY = Symbol('RETRY_POLICY');

/**
 * Measured, not guessed: 20 callers reserving against one balance needed up to
 * 6 attempts with this backoff (8 with none). Five would have surfaced a
 * serialization failure to a caller that should simply have been declined, so
 * the bound is set above the observed worst case with headroom.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 10, baseDelayMs: 20 };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Financial commands run SERIALIZABLE with bounded backoff (§10.5).
 *
 * `fn` must make no external network call: a retry re-runs it from the start.
 * Only serialization failures and deadlocks are retried — a constraint
 * violation is a real conflict and retrying it would risk a second journal.
 * Statement and idle-in-transaction timeouts come from the pool, not from here.
 */
export async function serializable<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<T> {
  const sleep = policy.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    policy.onAttempt?.(attempt);
    try {
      return await db.transaction().setIsolationLevel('serializable').execute(fn);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= policy.attempts || code === undefined || !RETRYABLE.has(code)) throw error;
      await sleep(2 ** attempt * (policy.baseDelayMs / 2) + Math.random() * policy.baseDelayMs);
    }
  }
}
