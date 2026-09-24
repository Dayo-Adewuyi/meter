import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { FinalizerHarness, airtime, createAgentFixture } from '../../../test/support/agent-fixtures.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { SANDBOX_AGENTS_CONFIG } from './agents.config.ts';

const RUNS = { numRuns: 12, seed: 20260924 } as const;
const OPERATOR = '00000000-0000-7000-8000-00000000000a';

type Action =
  | { kind: 'buy'; lastFour: string }
  | { kind: 'tick' }
  | { kind: 'sweep' }
  | { kind: 'advance'; seconds: number }
  | { kind: 'revoke_credential' }
  | { kind: 'revoke_mandate' }
  | { kind: 'operator_resolve'; outcome: 'delivered' | 'rejected' };

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('0000', '0001', '0002', '0003', '0004', '0005', '0006').map((lastFour) => ({ kind: 'buy' as const, lastFour })) },
  { weight: 4, arbitrary: fc.constant({ kind: 'tick' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'sweep' as const }) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 40 }).map((seconds) => ({ kind: 'advance' as const, seconds })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'revoke_credential' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'revoke_mandate' as const }) },
  { weight: 1, arbitrary: fc.constantFrom('delivered' as const, 'rejected' as const).map((outcome) => ({ kind: 'operator_resolve' as const, outcome })) },
);

async function holdsFinalizeOnce(db: Kysely<DB>, mandateId: string) {
  const rows = await db
    .selectFrom('authz.authorizations as a')
    .innerJoin('ledger.reservations as r', 'r.id', 'a.reservation_id')
    .select(['a.state', 'a.amount', 'a.captured_amount', 'r.original_amount', 'r.captured_amount as r_captured', 'r.released_amount'])
    .where('a.mandate_id', '=', mandateId)
    .execute();
  for (const row of rows) {
    const captured = BigInt(row.r_captured);
    const released = BigInt(row.released_amount);
    // Never both, never more than held.
    expect(captured === 0n || released === 0n).toBe(true);
    expect(captured + released).toBeLessThanOrEqual(BigInt(row.original_amount));
    if (row.state === 'authorized') expect(captured + released).toBe(0n);
    else expect(captured + released).toBe(BigInt(row.original_amount));
    if (row.state === 'captured') expect(row.captured_amount).toBe(row.amount);
  }
  return rows;
}

// I10: a hold finalizes at most once — captured + released = held, never both —
// under interleaved finalizer, sweeper, revocation and operator actions.
describe('hold finalization under interleaved actors', () => {
  it('captures or releases each hold exactly once', async () => {
    await withMigratedDb(async (db) => {
      await fc.assert(
        fc.asyncProperty(fc.array(fc.array(action, { minLength: 1, maxLength: 3 }), { minLength: 5, maxLength: 25 }), async (steps) => {
          const f = await createAgentFixture(db, { funding: 10_000_000n });
          const h = new FinalizerHarness(db, f);
          const funding = 10_000_000n;

          const run = async (a: Action): Promise<unknown> => {
            switch (a.kind) {
              case 'buy':
                return f.purchases.create(f.agent, crypto.randomUUID(), airtime({ destination: `0803${String(Math.random()).slice(2, 5)}${a.lastFour}` }));
              case 'tick':
                return h.finalizer.tick();
              case 'sweep':
                return h.finalizer.sweep();
              case 'advance':
                return h.advance(a.seconds * 1_000);
              case 'revoke_credential':
                return f.purchases.revokeCredential(f.ownerId, f.agent.credentialId);
              case 'revoke_mandate':
                return f.purchases.revokeMandate(f.ownerId, f.mandateId, 'property test');
              case 'operator_resolve': {
                const unresolved = await db.selectFrom('agents.purchases').select('id').where('delivery_status', '=', 'unresolved').execute();
                return Promise.all(unresolved.map((p) => f.purchases.operatorResolve(OPERATOR, p.id, { outcome: a.outcome, reason: 'test', evidence: 'test' }).catch(() => undefined)));
              }
            }
          };

          // Each step runs its actions concurrently; steps run in order.
          for (const step of steps) {
            await Promise.all(step.map(run));
            await holdsFinalizeOnce(db, f.mandateId);
          }

          // Drain: everything reaches a terminal state or is held for an operator.
          for (let i = 0; i < 200; i++) {
            h.advance(1_000);
            await h.finalizer.tick();
            await h.finalizer.sweep();
          }
          const rows = await holdsFinalizeOnce(db, f.mandateId);
          const open = await db.selectFrom('agents.purchases as p').innerJoin('authz.agent_credentials as c', 'c.id', 'p.credential_id')
            .select(['p.delivery_status', 'p.amount']).where('c.mandate_id', '=', f.mandateId)
            .where('p.delivery_status', 'in', ['pending_dispatch', 'dispatching', 'awaiting_confirmation']).execute();
          expect(open).toEqual([]);

          // Balances reconcile to the journal: held = open holds, spent = captures.
          const held = rows.filter((r) => r.state === 'authorized').reduce((sum, r) => sum + BigInt(r.amount), 0n);
          const spent = rows.filter((r) => r.state === 'captured').reduce((sum, r) => sum + BigInt(r.amount), 0n);
          await expect(f.balance(f.reservedAccountId)).resolves.toBe(held);
          await expect(f.balance(f.availableAccountId)).resolves.toBe(funding - held - spent);
          expect(SANDBOX_AGENTS_CONFIG.maxSendAttempts).toBe(3);
        }),
        RUNS,
      );
    });
  }, 600_000);
});
