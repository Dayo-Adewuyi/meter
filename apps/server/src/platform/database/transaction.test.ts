import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { type RetryPolicy, serializable } from './transaction.ts';

/** Minimal stand-in for the one Kysely call `serializable` makes. */
function fakeDb<T>(outcomes: Array<T | Error>) {
  const calls: Array<() => unknown> = [];
  const db = {
    transaction: () => ({
      setIsolationLevel: () => ({
        execute: async (fn: () => Promise<T>) => {
          calls.push(fn);
          const outcome = outcomes[calls.length - 1];
          if (outcome instanceof Error) throw outcome;
          return outcome as T;
        },
      }),
    }),
  };
  return { db: db as unknown as Kysely<unknown>, calls };
}

const pgError = (code: string) => Object.assign(new Error(code), { code });
const policy = (attempts: number, sleep: RetryPolicy['sleep'] = async () => {}): RetryPolicy => ({
  attempts,
  baseDelayMs: 20,
  sleep,
});
const run = async () => 'committed';

describe('serializable', () => {
  it('returns the first successful commit without retrying', async () => {
    const { db, calls } = fakeDb(['committed']);
    await expect(serializable(db, run, policy(5))).resolves.toBe('committed');
    expect(calls).toHaveLength(1);
  });

  it('retries serialization failures and deadlocks, then succeeds', async () => {
    for (const code of ['40001', '40P01']) {
      const { db, calls } = fakeDb([pgError(code), pgError(code), 'committed']);
      await expect(serializable(db, run, policy(5))).resolves.toBe('committed');
      expect(calls).toHaveLength(3);
    }
  });

  it('never retries a constraint violation — a duplicate must not become two journals', async () => {
    const { db, calls } = fakeDb([pgError('23505'), 'committed']);
    await expect(serializable(db, run, policy(5))).rejects.toThrow('23505');
    expect(calls).toHaveLength(1);
  });

  it('gives up at the attempt limit instead of retrying forever', async () => {
    const { db, calls } = fakeDb(Array.from({ length: 10 }, () => pgError('40001')));
    await expect(serializable(db, run, policy(3))).rejects.toThrow('40001');
    expect(calls).toHaveLength(3);
  });

  it('backs off with jitter between attempts', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const { db } = fakeDb([pgError('40001'), pgError('40001'), 'committed']);
    await serializable(db, run, policy(5, sleep));
    const delays = sleep.mock.calls.map(([ms]) => ms);
    expect(delays).toHaveLength(2);
    expect(delays[1]!).toBeGreaterThan(delays[0]! - 20); // growing, jitter aside
    expect(delays.every((d) => d > 0)).toBe(true);
  });

  it('reports every attempt so a caller can bound observed retries', async () => {
    const attempts: number[] = [];
    const { db } = fakeDb([pgError('40001'), 'committed']);

    await serializable(db, run, { ...policy(5), onAttempt: (n) => attempts.push(n) });

    expect(attempts).toEqual([1, 2]);
  });
});
