import { describe, expect, it } from 'vitest';
import { SimulatedVasProvider } from '../../../adapters/vas/simulated-vas-provider.ts';
import type { VasProvider } from '../../../adapters/vas/vas-provider.port.ts';
import { airtime, createAgentFixture, FinalizerHarness as Harness, harness } from '../../../test/support/agent-fixtures.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { SANDBOX_AGENTS_CONFIG } from './agents.config.ts';

const ATOMIC_500 = 50_000n;

describe('finalizer', () => {
  it.each([
    ['0000', 'delivered', 1],
    ['0001', 'rejected', 1],
    ['0002', 'delivered', 1],
    ['0003', 'rejected', 1],
    ['0004', 'delivered', 1],
    ['0006', 'delivered', 3],
  ] as const)('scenario %s ends %s after %i send(s)', async (lastFour, expected, sends) => {
    await withMigratedDb(async (db) => {
      const h = await harness(db);
      const id = await h.buy(lastFour);

      await expect(h.settle(id)).resolves.toBe(expected);

      expect(h.simulator.sends(id)).toBe(sends);
      const [available, reserved] = await h.ledger();
      expect(reserved).toBe(0n);
      expect(available).toBe(expected === 'delivered' ? 1_000_000n - ATOMIC_500 : 1_000_000n);
      const authorization = await db.selectFrom('authz.authorizations').selectAll().executeTakeFirstOrThrow();
      expect(authorization.state).toBe(expected === 'delivered' ? 'captured' : 'released');
    });
  }, 60_000);

  // I11: an unknown outcome never captures or releases without a definitive answer.
  it('holds the ledger unchanged for every tick while the outcome is unknown', async () => {
    await withMigratedDb(async (db) => {
      const h = await harness(db);
      const ids = await Promise.all(['0002', '0003', '0004', '0005'].map((d) => h.buy(d)));
      const held = await h.ledger();
      expect(held).toEqual([1_000_000n - 4n * ATOMIC_500, 4n * ATOMIC_500]);

      await h.finalizer.tick();
      for (const id of ids) expect(await h.status(id)).toBe('awaiting_confirmation');
      await expect(h.ledger()).resolves.toEqual(held);

      // Walk time forward; the ledger may only move when a purchase leaves awaiting/unresolved.
      for (let s = 0; s < 90; s++) {
        h.advance(1_000);
        await h.finalizer.tick();
        const statuses = await Promise.all(ids.map((id) => h.status(id)));
        const [available, reserved] = await h.ledger();
        const open = statuses.filter((st) => st === 'awaiting_confirmation' || st === 'unresolved').length;
        const delivered = statuses.filter((st) => st === 'delivered').length;
        expect(reserved).toBe(BigInt(open) * ATOMIC_500);
        expect(available).toBe(1_000_000n - BigInt(open + delivered) * ATOMIC_500);
      }
      expect(await Promise.all(ids.map((id) => h.status(id)))).toEqual(['delivered', 'rejected', 'delivered', 'unresolved']);
      await expect(h.ledger()).resolves.toEqual([1_000_000n - 3n * ATOMIC_500, ATOMIC_500]);
    });
  }, 120_000);

  it('lets an operator resolve an unresolved purchase with evidence, once', async () => {
    await withMigratedDb(async (db) => {
      const h = await harness(db);
      const id = await h.buy('0005');
      await expect(h.settle(id, 90)).resolves.toBe('unresolved');

      const resolved = await h.f.purchases.operatorResolve('00000000-0000-7000-8000-00000000000a', id, {
        outcome: 'delivered',
        reason: 'provider statement shows delivery',
        evidence: 'statement 2026-09-24 line 42',
      });

      expect(resolved.status).toBe('delivered');
      await expect(h.ledger()).resolves.toEqual([1_000_000n - ATOMIC_500, 0n]);
      await expect(
        h.f.purchases.operatorResolve('00000000-0000-7000-8000-00000000000a', id, { outcome: 'rejected', reason: 'x', evidence: 'y' }),
      ).rejects.toMatchObject({ response: { error: { code: 'PURCHASE_NOT_UNRESOLVED' } } });
      const last = await db.selectFrom('agents.purchase_events').selectAll().where('purchase_id', '=', id).orderBy('id', 'desc').executeTakeFirstOrThrow();
      expect(last).toMatchObject({ from_status: 'unresolved', to_status: 'delivered', actor: 'operator:00000000-0000-7000-8000-00000000000a' });
    });
  }, 120_000);

  it('releases as PROVIDER_UNREACHABLE once not_sent exhausts its attempts', async () => {
    await withMigratedDb(async (db) => {
      const refusing: VasProvider = {
        name: 'refusing',
        sendAirtime: async () => ({ kind: 'not_sent', reason: 'connection refused' }),
        requery: async () => ({ kind: 'not_found' }),
      };
      const h = await harness(db, refusing);
      const id = await h.buy('0000');

      await expect(h.settle(id)).resolves.toBe('rejected');
      const purchase = await db.selectFrom('agents.purchases').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(purchase.send_attempts).toBe(3);
      await expect(h.ledger()).resolves.toEqual([1_000_000n, 0n]);
    });
  }, 60_000);

  it('treats an adapter that throws as unknown, never as a failure', async () => {
    await withMigratedDb(async (db) => {
      const throwing: VasProvider = {
        name: 'throwing',
        sendAirtime: async () => {
          throw new Error('socket hang up');
        },
        requery: async () => ({ kind: 'pending' }),
      };
      const h = await harness(db, throwing);
      const id = await h.buy('0000');
      await h.finalizer.tick();
      await expect(h.status(id)).resolves.toBe('awaiting_confirmation');
      await expect(h.ledger()).resolves.toEqual([1_000_000n - ATOMIC_500, ATOMIC_500]);
    });
  }, 60_000);

  // I12: after write-ahead the provider receives at most one send per purchase.
  it('recovers a worker that died mid-send by requerying, never resending', async () => {
    await withMigratedDb(async (db) => {
      const simulator = new SimulatedVasProvider({ latencyMs: 0, hangMs: 1_500 });
      const f = await createAgentFixture(db, { funding: 1_000_000n });
      const dead = new Harness(db, f, simulator);
      const id = await dead.buy('0007');

      // Worker A writes ahead and is "killed": its send hangs past its lease.
      const abandoned = dead.finalizer.tick();
      for (let i = 0; i < 50 && (await dead.status(id)) !== 'dispatching'; i++) await new Promise((r) => setTimeout(r, 20));
      expect(await dead.status(id)).toBe('dispatching');

      // Worker B starts after the lease expired.
      const restarted = new Harness(db, f, simulator);
      restarted.now = new Date(Date.now() + SANDBOX_AGENTS_CONFIG.leaseMs + 1_000);
      await restarted.finalizer.tick();
      await expect(restarted.status(id)).resolves.toBe('awaiting_confirmation');
      await expect(restarted.settle(id)).resolves.toBe('delivered');

      // A's late answer arrives after B settled: a lost race, not a second capture.
      await abandoned;
      expect(simulator.sends(id)).toBe(1);
      expect(simulator.requeries(id)).toBeGreaterThanOrEqual(1);
      await expect(db.selectFrom('ledger.captures').selectAll().execute()).resolves.toHaveLength(1);
      await expect(restarted.ledger()).resolves.toEqual([1_000_000n - ATOMIC_500, 0n]);
    });
  }, 60_000);

  it('expires an undispatched hold once it outlives its TTL, and never dispatches it', async () => {
    await withMigratedDb(async (db) => {
      const h = await harness(db);
      const id = await h.buy('0000');
      h.advance(SANDBOX_AGENTS_CONFIG.holdTtlMs + 1);

      await expect(h.finalizer.sweep()).resolves.toBe(1);
      await expect(h.finalizer.sweep()).resolves.toBe(0);
      await h.finalizer.tick();

      await expect(h.status(id)).resolves.toBe('expired');
      expect(h.simulator.sends(id)).toBe(0);
      await expect(h.ledger()).resolves.toEqual([1_000_000n, 0n]);
      await expect(db.selectFrom('authz.authorizations').select('state').executeTakeFirstOrThrow()).resolves.toEqual({ state: 'expired' });
    });
  }, 60_000);

  it('revalidates authority at dispatch time', async () => {
    await withMigratedDb(async (db) => {
      const h = await harness(db);
      const id = await h.buy('0000');
      await db.updateTable('authz.mandates').set({ status: 'revoked', revoked_at: new Date() }).where('id', '=', h.f.mandateId).execute();

      await h.finalizer.tick();

      await expect(h.status(id)).resolves.toBe('expired');
      expect(h.simulator.sends(id)).toBe(0);
      await expect(h.ledger()).resolves.toEqual([1_000_000n, 0n]);
    });
  }, 60_000);

  it('revocation expires undispatched purchases in the same transaction and leaves in-flight ones held', async () => {
    await withMigratedDb(async (db) => {
      const h = await harness(db);
      const inFlight = await h.buy('0005');
      await h.finalizer.tick();
      const pending = await h.buy('0000');

      const revoked = await h.f.purchases.revokeCredential(h.f.ownerId, h.f.agent.credentialId);

      expect(revoked.expired_purchases).toBe(1);
      await expect(h.status(pending)).resolves.toBe('expired');
      await expect(h.status(inFlight)).resolves.toBe('awaiting_confirmation');
      await expect(h.ledger()).resolves.toEqual([1_000_000n - ATOMIC_500, ATOMIC_500]);
      const next = await h.f.purchases.create(h.f.agent, 'after-revoke', airtime({ destination: '08030000009' }));
      expect(next.body).toMatchObject({ error: { code: 'CREDENTIAL_REVOKED' } });
    });
  }, 60_000);
});
