import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { type AgentFixture, airtime, createAgentFixture } from '../../../test/support/agent-fixtures.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { lagosDay } from '../../core/authorization/authorization.service.ts';

const ledgerTransactions = async (db: Kysely<DB>) =>
  Number((await db.selectFrom('ledger.transactions').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);

let keySeq = 0;
const key = () => `key-${++keySeq}`;

describe('authorize (TX1)', () => {
  it('approves within limits: reserves, records an approved decision and a pending purchase', async () => {
    await withMigratedDb(async (db) => {
      const f = await createAgentFixture(db, { funding: 1_000_000n });

      const result = await f.purchases.create(f.agent, key(), airtime({ amount: '500' }));

      expect(result).toMatchObject({ httpStatus: 202, replayed: false, body: { status: 'processing', canonical_state: 'authorized' } });
      await expect(f.balance(f.availableAccountId)).resolves.toBe(950_000n);
      await expect(f.balance(f.reservedAccountId)).resolves.toBe(50_000n);
      const purchase = await db.selectFrom('agents.purchases').selectAll().executeTakeFirstOrThrow();
      expect(purchase).toMatchObject({ delivery_status: 'pending_dispatch', destination: '+2348030000000', amount: '50000' });
      const decision = await db.selectFrom('authz.decisions').selectAll().executeTakeFirstOrThrow();
      expect(decision.outcome).toBe('approved');
      expect((decision.evaluated as { checks: { check: string }[] }).checks.map((c) => c.check)).toEqual([
        'credential', 'scope', 'mandate', 'owner', 'category', 'destination', 'per_transaction',
        'duplicate', 'velocity', 'concurrency', 'daily', 'lifetime', 'funds',
      ]);
      await expect(db.updateTable('authz.decisions').set({ outcome: 'declined' }).execute()).rejects.toThrow(/append-only/);
    });
  }, 60_000);

  it('replays the same key and body, and refuses the same key with a different body', async () => {
    await withMigratedDb(async (db) => {
      const f = await createAgentFixture(db, { funding: 1_000_000n });
      const first = await f.purchases.create(f.agent, 'same', airtime());
      const replay = await f.purchases.create(f.agent, 'same', airtime());

      expect(replay).toEqual({ ...first, replayed: true });
      await expect(f.purchases.create(f.agent, 'same', airtime({ amount: '600' }))).rejects.toMatchObject({
        response: { error: { code: 'IDEMPOTENCY_CONFLICT' } },
      });
      await expect(f.balance(f.reservedAccountId)).resolves.toBe(50_000n);

      // Concurrent same-key requests reserve once.
      const racing = await Promise.all(Array.from({ length: 5 }, () => f.purchases.create(f.agent, 'race', airtime({ destination: '08030000009' }))));
      expect(new Set(racing.map((r) => r.body.purchase_id)).size).toBe(1);
      await expect(f.balance(f.reservedAccountId)).resolves.toBe(100_000n);
    });
  }, 60_000);

  // I13: every denial code writes no ledger rows (the provider is never reachable from TX1).
  it('declines each policy dimension with a stable code and touches no ledger row', async () => {
    await withMigratedDb(async (db) => {
      const scenarios: [string, (f: AgentFixture) => Promise<unknown>, Parameters<typeof createAgentFixture>[1]?][] = [
        ['CREDENTIAL_REVOKED', (f) => db.updateTable('authz.agent_credentials').set({ status: 'revoked', revoked_at: new Date() }).where('id', '=', f.agent.credentialId).execute()],
        ['CREDENTIAL_EXPIRED', (f) => db.updateTable('authz.agent_credentials').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', f.agent.credentialId).execute()],
        ['MANDATE_REVOKED', (f) => db.updateTable('authz.mandates').set({ status: 'revoked', revoked_at: new Date() }).where('id', '=', f.mandateId).execute()],
        ['MANDATE_EXPIRED', (f) => db.updateTable('authz.mandates').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', f.mandateId).execute()],
        ['ACCOUNT_RESTRICTED', (f) => db.updateTable('identity.users').set({ status: 'suspended' }).where('id', '=', f.ownerId).execute()],
        ['CATEGORY_NOT_ALLOWED', async () => undefined, { mandate: { allowedCategories: ['data'] } }],
        ['DESTINATION_NOT_ALLOWED', async () => undefined, { mandate: { allowedDestinations: ['+2348030000001'] } }],
        ['PER_TRANSACTION_LIMIT', async () => undefined, { mandate: { perTransactionLimit: 10_000n } }],
        ['DUPLICATE_SUSPECTED', (f) => f.purchases.create(f.agent, key(), airtime()), { mandate: { duplicateWindowSecs: 120 } }],
        ['VELOCITY_LIMIT', (f) => f.purchases.create(f.agent, key(), airtime({ destination: '08030000009' })), { mandate: { velocityMaxCount: 1 } }],
        ['CONCURRENCY_LIMIT', (f) => f.purchases.create(f.agent, key(), airtime({ destination: '08030000009' })), { mandate: { maxInFlight: 1 } }],
        ['DAILY_LIMIT', (f) => f.purchases.create(f.agent, key(), airtime({ amount: '800', destination: '08030000009' })), { mandate: { perTransactionLimit: 100_000n, dailyLimit: 100_000n } }],
        ['LIFETIME_LIMIT', async (f) => {
          // Lifetime can only bind below the daily ceiling through earlier days' exposure.
          await f.purchases.create(f.agent, key(), airtime({ amount: '800', destination: '08030000009' }));
          await db.updateTable('authz.authorizations').set({ created_at: new Date(Date.now() - 2 * 86_400_000) } as never).where('mandate_id', '=', f.mandateId).execute();
        }, { mandate: { perTransactionLimit: 90_000n, dailyLimit: 100_000n, lifetimeLimit: 100_000n } }],
        ['INSUFFICIENT_FUNDS', async () => undefined, { funding: 10_000n }],
      ];
      for (const [code, arrange, options] of scenarios) {
        const f = await createAgentFixture(db, { funding: 1_000_000n, ...options });
        await arrange(f);
        const before = await ledgerTransactions(db);
        const result = await f.purchases.create(f.agent, key(), airtime());
        expect(result.body, code).toMatchObject({ error: { code } });
        expect(result.httpStatus, code).toBe(code === 'INSUFFICIENT_FUNDS' ? 402 : 403);
        expect(await ledgerTransactions(db), code).toBe(before);
      }

      const scoped = await createAgentFixture(db, { funding: 1_000_000n });
      const readOnly = await scoped.newAgent(['purchases:read']);
      await expect(scoped.purchases.create(readOnly, key(), airtime())).resolves.toMatchObject({ body: { error: { code: 'SCOPE_DENIED' } } });
    });
  }, 120_000);

  it('names the violated limit, what is left and when it resets', async () => {
    await withMigratedDb(async (db) => {
      const f = await createAgentFixture(db, { funding: 1_000_000n, mandate: { perTransactionLimit: 200_000n, dailyLimit: 500_000n } });
      await f.purchases.create(f.agent, key(), airtime({ amount: '2000' }));
      await f.purchases.create(f.agent, key(), airtime({ amount: '2000', destination: '08030000009' }));
      await f.purchases.create(f.agent, key(), airtime({ amount: '500', destination: '08030000008' }));

      const denied = await f.purchases.create(f.agent, key(), airtime({ amount: '1000', destination: '08030000007' }));

      expect(denied.body).toMatchObject({
        error: {
          code: 'DAILY_LIMIT',
          dimension: 'daily_limit',
          limit: '5000.00',
          current: '4500.00',
          requested: '1000.00',
          remaining: '500.00',
        },
      });
      expect((denied.body.error as { resets_at: string }).resets_at).toMatch(/T23:00:00.000Z$/); // 00:00 WAT
    });
  }, 60_000);

  it('computes the daily window on the Africa/Lagos calendar day', async () => {
    await withMigratedDb(async (db) => {
      // 23:59:59 WAT is 22:59:59Z the same day; 00:00:00 WAT is 23:00:00Z the day before.
      await expect(lagosDay(db, new Date('2026-09-24T22:59:59Z'))).resolves.toEqual({
        start: new Date('2026-09-23T23:00:00Z'),
        next: new Date('2026-09-24T23:00:00Z'),
      });
      await expect(lagosDay(db, new Date('2026-09-24T23:00:00Z'))).resolves.toEqual({
        start: new Date('2026-09-24T23:00:00Z'),
        next: new Date('2026-09-25T23:00:00Z'),
      });
    });
  }, 60_000);
});
