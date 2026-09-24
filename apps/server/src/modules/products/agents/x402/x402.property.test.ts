import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { USDC_SYSTEM_ACCOUNT_IDS } from '../../../core/ledger/account-taxonomy.ts';
import { withMigratedDb } from '../../../../test/support/database.ts';
import type { Hex } from '../../../../adapters/evm/evm.ts';
import { requirements, x402World } from '../../../../test/support/x402-world.ts';

type Seller = 'settle_now' | 'settle_later' | 'after_expiry' | 'never' | 'reorged';

const RUNS = { numRuns: 10, seed: 20260924 } as const;

// I18 + I19 together: whatever sellers do, a hold is captured exactly when the
// chain shows the authorization used at the safe head, released otherwise, and
// the omnibus wallet reconciles to the ledger to the last atomic unit.
describe('x402 finalization against adversarial sellers', () => {
  it('captures exactly the payments the chain executed, and nothing else', async () => {
    await withMigratedDb(async (db) => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              seller: fc.constantFrom<Seller>('settle_now', 'settle_later', 'after_expiry', 'never', 'reorged'),
              cents: fc.integer({ min: 1, max: 90 }),
              delay: fc.integer({ min: 1, max: 40 }),
              gap: fc.integer({ min: 0, max: 20 }),
            }),
            { minLength: 1, maxLength: 5 },
          ),
          async (plan) => {
            // Runs share one database; the new chain must also back earlier runs' USDC.
            const earlier = await db
              .selectFrom('ledger.accounts as a')
              .innerJoin('ledger.balances as b', 'b.account_id', 'a.id')
              .select('b.posted_amount')
              .where('a.asset_code', '=', 'USDC')
              .where('a.purpose', 'in', ['customer_available', 'customer_reserved'])
              .execute();
            const backing = earlier.reduce((sum, row) => sum + BigInt(row.posted_amount), 0n);
            const w = await x402World(db, { mandate: { velocityMaxCount: 50, maxInFlight: 50 }, backing });
            const payable = await w.f.balance(USDC_SYSTEM_ACCOUNT_IDS.provider_payable);
            const pending: { at: number; run: () => Promise<unknown> }[] = [];
            const issued: { id: string; signature: string }[] = [];

            for (const step of plan) {
              const amount = String(step.cents * 10_000);
              const created = await w.pay({}, [requirements({ amount })]);
              expect(created.httpStatus).toBe(202);
              const signature = created.body.payment_signature as string;
              issued.push({ id: created.body.payment_id as string, signature });
              const settle = () => w.sellerSettles(signature);
              if (step.seller === 'settle_now') await settle();
              if (step.seller === 'settle_later') pending.push({ at: w.now() + step.delay * 1000, run: settle });
              if (step.seller === 'after_expiry') pending.push({ at: w.now() + 400_000, run: settle });
              if (step.seller === 'reorged') {
                await settle();
                w.chain.reorg(1);
              }
              w.advance(step.gap * 2);
              await w.finalizer.tick();
            }

            for (let s = 0; s < 700; s += 2) {
              w.advance(2);
              for (const job of pending.filter((p) => p.at <= w.now())) {
                pending.splice(pending.indexOf(job), 1);
                await job.run();
              }
              await w.finalizer.tick();
            }

            let captured = 0n;
            for (const { id } of issued) {
              const row = await db.selectFrom('agents.x402_payments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
              const use = await w.chain.authorizationUse(row.auth_from as Hex, row.auth_nonce as Hex);
              expect(row.state).toBe(use === null ? 'lapsed' : 'settled');
              if (use !== null) {
                expect(use.value).toBe(BigInt(row.amount));
                captured += use.value;
              }
            }
            const [available, reserved] = await w.ledger();
            expect(reserved).toBe(0n);
            expect(available).toBe(25_000_000n - captured);
            await expect(w.f.balance(USDC_SYSTEM_ACCOUNT_IDS.provider_payable)).resolves.toBe(payable + captured);
            await expect(w.reconciliation.run()).resolves.toMatchObject({ healthy: true, float: '0.000000', foreignNonces: [] });
          },
        ),
        RUNS,
      );
    });
  }, 600_000);
});
