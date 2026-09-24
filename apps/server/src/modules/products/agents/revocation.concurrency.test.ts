import { describe, expect, it } from 'vitest';
import { FinalizerHarness, airtime, createAgentFixture } from '../../../test/support/agent-fixtures.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { SANDBOX_AGENTS_CONFIG } from './agents.config.ts';

describe('revocation under concurrency', () => {
  // I14: a credential revoked before an authorization commits cannot authorize.
  it('leaves no hold behind whichever side of the revocation a purchase committed on', async () => {
    await withMigratedDb(async (db) => {
      const f = await createAgentFixture(db, { funding: 10_000_000n });

      const purchases = Array.from({ length: 20 }, (_, i) =>
        f.purchases.create(f.agent, `r-${i}`, airtime({ destination: `0803000${String(2000 + i)}` })),
      );
      const revocation = new Promise((resolve) => setTimeout(resolve, 15)).then(() =>
        f.purchases.revokeCredential(f.ownerId, f.agent.credentialId),
      );
      const [results] = await Promise.all([Promise.all(purchases), revocation]);

      // Committed before the revocation → expired by it; after → declined by policy step 1.
      const rows = await db.selectFrom('agents.purchases').select(['delivery_status', 'decision_id']).execute();
      expect(rows).toHaveLength(20);
      for (const row of rows) expect(['expired', 'declined']).toContain(row.delivery_status);
      for (const result of results.filter((r) => r.httpStatus !== 202)) {
        expect(result.body).toMatchObject({ error: { code: 'CREDENTIAL_REVOKED' } });
      }
      await expect(f.balance(f.reservedAccountId)).resolves.toBe(0n);
      await expect(f.balance(f.availableAccountId)).resolves.toBe(10_000_000n);
    });
  }, 120_000);

  // I15: pre-dispatch expiry and revocation release exactly the held amount once.
  it('sweeper, revocation and finalizer racing over the same holds release each exactly once', async () => {
    await withMigratedDb(async (db) => {
      const f = await createAgentFixture(db, { funding: 10_000_000n, mandate: { dailyLimit: 5_000_000n } });
      const dispatcher = new FinalizerHarness(db, f);
      const sweeper = new FinalizerHarness(db, f);
      for (let i = 0; i < 12; i++) await dispatcher.buy(String(3000 + i));
      sweeper.now = new Date(Date.now() + SANDBOX_AGENTS_CONFIG.holdTtlMs + 1_000);

      await Promise.all([
        dispatcher.finalizer.tick(),
        sweeper.finalizer.sweep(),
        f.purchases.revokeMandate(f.ownerId, f.mandateId, 'race'),
        dispatcher.finalizer.tick(),
        sweeper.finalizer.sweep(),
      ]);
      for (let i = 0; i < 10; i++) {
        dispatcher.advance(1_000);
        await dispatcher.finalizer.tick();
      }

      const rows = await db
        .selectFrom('ledger.reservations')
        .select(['original_amount', 'captured_amount', 'released_amount'])
        .execute();
      expect(rows).toHaveLength(12);
      let captured = 0n;
      for (const row of rows) {
        expect(BigInt(row.captured_amount) + BigInt(row.released_amount)).toBe(BigInt(row.original_amount));
        expect(row.captured_amount === '0' || row.released_amount === '0').toBe(true);
        captured += BigInt(row.captured_amount);
      }
      const releases = await db.selectFrom('ledger.transactions').select('id').where('transaction_type', '=', 'release').execute();
      expect(releases.length).toBe(rows.filter((r) => r.released_amount !== '0').length);
      await expect(f.balance(f.reservedAccountId)).resolves.toBe(0n);
      await expect(f.balance(f.availableAccountId)).resolves.toBe(10_000_000n - captured);
    });
  }, 120_000);
});
