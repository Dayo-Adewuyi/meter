import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { SimulatedVasProvider } from '../../../adapters/vas/simulated-vas-provider.ts';
import { VAS_PROVIDER } from '../../../adapters/vas/vas-provider.port.ts';
import { AppModule } from '../../../app.module.ts';
import { DATABASE } from '../../../platform/database/database.module.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { AuthenticationError, AUTHENTICATOR, type AuthenticatorPort } from '../../core/identity/authenticator.port.ts';
import { IDENTITY_REPOSITORY } from '../../core/identity/identity.repository.ts';
import type { MeterPrincipal } from '../../core/identity/principal.ts';
import { AgentsModule } from './agents.module.ts';
import { FinalizerService } from './finalizer.service.ts';

describe('agents HTTP API', () => {
  it('runs the owner → agent → finalizer → timeline → revoke flow over HTTP', async () => {
    await withMigratedDb(async (db) => {
      const users = await db
        .insertInto('identity.users')
        .values([{ roles: ['customer'] }, { roles: ['customer', 'operator'] }, { roles: ['customer'] }])
        .returning(['id', 'roles'])
        .execute();
      const principals = new Map<string, MeterPrincipal>(
        ['owner', 'operator', 'stranger'].map((name, i) => [name, { userId: users[i]!.id, roles: users[i]!.roles, restrictionState: 'unrestricted' }]),
      );
      const authenticator: AuthenticatorPort = {
        verifyToken: async (token) => {
          if (!principals.has(token)) throw new AuthenticationError('INVALID_TOKEN');
          return { provider: 'clerk', subject: token, sessionId: null };
        },
        fetchUser: async (subject) => ({ provider: 'clerk', subject, disabled: false }),
      };

      const moduleRef = await Test.createTestingModule({ imports: [AppModule, AgentsModule] })
        .overrideProvider(DATABASE).useValue(db)
        .overrideProvider(AUTHENTICATOR).useValue(authenticator)
        .overrideProvider(IDENTITY_REPOSITORY).useValue({ findPrincipal: async (_p: string, s: string) => principals.get(s) ?? null })
        .overrideProvider(VAS_PROVIDER).useValue(new SimulatedVasProvider({ latencyMs: 0 }))
        .compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      app.setGlobalPrefix('v1');
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      try {
        const call = (method: 'GET' | 'POST', url: string, token: string, body?: object, headers: Record<string, string> = {}) =>
          app.inject({ method, url: `/v1${url}`, headers: { authorization: `Bearer ${token}`, ...headers }, ...(body === undefined ? {} : { payload: body }) });

        // Owner funds, creates a mandate, issues a credential.
        const credit = await call('POST', '/sandbox/credit', 'owner', { amount: '10000.00' }, { 'idempotency-key': 'fund-1' });
        expect(credit.statusCode).toBe(201);
        const mandate = await call('POST', '/mandates', 'owner', {
          name: 'Demo',
          per_transaction_limit: '2000.00',
          daily_limit: '5000.00',
          lifetime_limit: '50000.00',
          velocity: { max_count: 5, window_secs: 600 },
          allowed_categories: ['airtime'],
        });
        expect(mandate.statusCode).toBe(201);
        const mandateId = mandate.json().id as string;
        expect((await call('POST', '/mandates', 'owner', { name: 'bad', per_transaction_limit: '9000', daily_limit: '5000', lifetime_limit: '50000', velocity: { max_count: 1, window_secs: 1 }, allowed_categories: ['airtime'] })).json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

        const issued = await call('POST', `/mandates/${mandateId}/credentials`, 'owner', { label: 'claude' });
        expect(issued.statusCode).toBe(201);
        const token = issued.json().token as string;
        expect(token).toMatch(/^mtr_agt_/);
        expect((await call('GET', `/mandates/${mandateId}`, 'owner')).json().credentials[0]).not.toHaveProperty('token');
        expect((await call('GET', `/mandates/${mandateId}`, 'stranger')).statusCode).toBe(404);

        // Principals do not cross: a human session on agent routes, an agent token on owner routes.
        expect((await call('GET', '/agent/spending-power', 'owner')).json()).toMatchObject({ error: { code: 'CREDENTIAL_INVALID' } });
        expect((await call('GET', '/mandates', token)).statusCode).toBe(401);

        const power = await call('GET', '/agent/spending-power', token);
        expect(power.json()).toMatchObject({ spendable: '2000.00', binding_limit: 'per_transaction_limit', in_flight: 0 });

        // Purchase: validation, idempotency header, replay, conflict.
        const body = { category: 'airtime', network: 'mtn', destination: '0803 000 0000', amount: '500.00', intent: 'Top up my line' };
        expect((await call('POST', '/agent/purchases', token, body)).json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
        expect((await call('POST', '/agent/purchases', token, { ...body, destination: '12345' }, { 'idempotency-key': 'v' })).statusCode).toBe(400);
        const created = await call('POST', '/agent/purchases', token, body, { 'idempotency-key': 'p1' });
        expect(created.statusCode).toBe(202);
        expect(created.json()).toMatchObject({ status: 'processing', canonical_state: 'authorized' });
        const purchaseId = created.json().purchase_id as string;
        const replay = await call('POST', '/agent/purchases', token, body, { 'idempotency-key': 'p1' });
        expect(replay.statusCode).toBe(202);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(replay.json()).toEqual(created.json());
        expect((await call('POST', '/agent/purchases', token, { ...body, amount: '600' }, { 'idempotency-key': 'p1' })).statusCode).toBe(409);

        const over = await call('POST', '/agent/purchases', token, { ...body, amount: '3000' }, { 'idempotency-key': 'p2' });
        expect(over.statusCode).toBe(403);
        expect(over.json()).toMatchObject({ error: { code: 'PER_TRANSACTION_LIMIT', limit: '2000.00', requested: '3000.00' } });

        // The worker delivers; the agent sees it; the owner reads the timeline.
        await app.get(FinalizerService).tick();
        expect((await call('GET', `/agent/purchases/${purchaseId}`, token)).json()).toMatchObject({ status: 'delivered', amount_charged: '500.00' });
        expect((await call('GET', '/agent/purchases?limit=10', token)).json().purchases).toHaveLength(2);
        const timeline = await call('GET', `/purchases/${purchaseId}/timeline`, 'owner');
        expect(timeline.json().entries.map((e: { kind: string }) => e.kind)).toEqual(['decision', 'ledger', 'purchase', 'purchase', 'provider', 'ledger', 'purchase']);
        expect((await call('GET', `/purchases/${purchaseId}/timeline`, 'stranger')).statusCode).toBe(404);
        expect((await call('GET', `/purchases/${purchaseId}/timeline`, 'operator')).statusCode).toBe(200);

        // Owner reads the balance and the mandate's purchases; another owner sees nothing.
        expect((await call('GET', '/balance', 'owner')).json()).toEqual({ asset: 'NGN', available: '9500.00', reserved: '0.00' });
        const listed = (await call('GET', `/mandates/${mandateId}/purchases?limit=10`, 'owner')).json();
        expect(listed.purchases.map((p: { status: string }) => p.status)).toEqual(['declined', 'delivered']);
        expect(listed.purchases[0].credential_label).toBe('claude');
        expect((await call('GET', `/mandates/${mandateId}/purchases`, 'stranger')).json().purchases).toEqual([]);

        // Operator route is role-gated.
        expect((await call('POST', `/operator/purchases/${purchaseId}/resolve`, 'owner', { outcome: 'delivered', reason: 'x', evidence: 'y' })).statusCode).toBe(403);
        expect((await call('POST', `/operator/purchases/${purchaseId}/resolve`, 'operator', { outcome: 'delivered', reason: 'x', evidence: 'y' })).json()).toMatchObject({ error: { code: 'PURCHASE_NOT_UNRESOLVED' } });

        // Revocation: the agent's next attempt fails.
        const credentialId = issued.json().id as string;
        expect((await call('POST', `/credentials/${credentialId}/revoke`, 'owner')).json()).toMatchObject({ status: 'revoked' });
        const after = await call('POST', '/agent/purchases', token, { ...body, destination: '08030000009' }, { 'idempotency-key': 'p3' });
        expect(after.statusCode).toBe(401);
        expect(after.json()).toMatchObject({ error: { code: 'CREDENTIAL_REVOKED' } });
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
