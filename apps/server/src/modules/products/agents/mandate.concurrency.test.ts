import { describe, expect, it } from 'vitest';
import { airtime, createAgentFixture } from '../../../test/support/agent-fixtures.ts';
import { withMigratedDb } from '../../../test/support/database.ts';

const STABLE_DENIALS = new Set(['DAILY_LIMIT', 'LIFETIME_LIMIT', 'CONCURRENCY_LIMIT', 'INSUFFICIENT_FUNDS', 'VELOCITY_LIMIT']);

// I9: mandate exposure never exceeds any limit, under concurrency.
describe('mandate limits under concurrency', () => {
  it.each([
    ['daily binds', { dailyLimit: 300_000n, lifetimeLimit: 1_000_000n, maxInFlight: 100 }, 1_000_000n],
    ['in-flight binds', { dailyLimit: 1_000_000n, lifetimeLimit: 1_000_000n, maxInFlight: 4 }, 1_000_000n],
    ['balance binds', { dailyLimit: 1_000_000n, lifetimeLimit: 1_000_000n, maxInFlight: 100 }, 250_000n],
  ] as const)('%s: 30 parallel purchases never overshoot', async (_name, limits, funding) => {
    await withMigratedDb(async (db) => {
      const f = await createAgentFixture(db, {
        funding,
        mandate: { perTransactionLimit: 50_000n, velocityMaxCount: 1_000, ...limits },
      });

      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          f.purchases.create(f.agent, `c-${i}`, airtime({ amount: '500', destination: `0803000${String(1000 + i).padStart(4, '0')}` })),
        ),
      );

      const approved = results.filter((r) => r.httpStatus === 202);
      const approvedSum = BigInt(approved.length) * 50_000n;
      expect(approvedSum).toBeLessThanOrEqual(limits.dailyLimit);
      expect(approvedSum).toBeLessThanOrEqual(limits.lifetimeLimit);
      expect(approvedSum).toBeLessThanOrEqual(funding);
      expect(approved.length).toBeLessThanOrEqual(limits.maxInFlight);
      // The binding limit is actually reached, not merely respected by declining everything.
      expect(approvedSum).toBe(
        [limits.dailyLimit, limits.lifetimeLimit, funding, BigInt(limits.maxInFlight) * 50_000n, 30n * 50_000n].reduce((a, b) => (a < b ? a : b)),
      );
      for (const denied of results.filter((r) => r.httpStatus !== 202)) {
        expect(STABLE_DENIALS).toContain((denied.body.error as { code: string }).code);
      }
      await expect(f.balance(f.reservedAccountId)).resolves.toBe(approvedSum);
      await expect(f.balance(f.availableAccountId)).resolves.toBe(funding - approvedSum);
    });
  }, 120_000);
});
