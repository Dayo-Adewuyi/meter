import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { SimulatedChain } from '../../../../adapters/chain/simulated-chain.ts';
import { SIGNER, type SignerPort } from '../../../../adapters/signing/signer.port.ts';
import { decodeHeader, type PaymentRequired, type SettlementResponse } from '../../../../adapters/x402/protocol.ts';
import { AppModule } from '../../../../app.module.ts';
import { DATABASE } from '../../../../platform/database/database.module.ts';
import { withMigratedDb } from '../../../../test/support/database.ts';
import { AUTHENTICATOR, AuthenticationError, type AuthenticatorPort } from '../../../core/identity/authenticator.port.ts';
import { IDENTITY_REPOSITORY } from '../../../core/identity/identity.repository.ts';
import type { MeterPrincipal } from '../../../core/identity/principal.ts';
import { AgentsModule } from '../agents.module.ts';
import { X402FinalizerService } from './x402-finalizer.service.ts';
import { X402ReconciliationService } from './x402-reconciliation.service.ts';

describe('x402 over HTTP', () => {
  it('owner funds and draws a USDC covenant; the agent pays the oracle; the chain settles it', async () => {
    await withMigratedDb(async (db) => {
      const [ownerRow] = await db.insertInto('identity.users').values([{ roles: ['customer', 'operator'] }]).returning(['id', 'roles']).execute();
      const owner: MeterPrincipal = { userId: ownerRow!.id, roles: ownerRow!.roles, restrictionState: 'unrestricted' };
      const authenticator: AuthenticatorPort = {
        verifyToken: async (token) => {
          if (token !== 'owner') throw new AuthenticationError('INVALID_TOKEN');
          return { provider: 'clerk', subject: 'owner', sessionId: null };
        },
        fetchUser: async (subject) => ({ provider: 'clerk', subject, disabled: false }),
      };
      const moduleRef = await Test.createTestingModule({ imports: [AppModule, AgentsModule] })
        .overrideProvider(DATABASE).useValue(db)
        .overrideProvider(AUTHENTICATOR).useValue(authenticator)
        .overrideProvider(IDENTITY_REPOSITORY).useValue({ findPrincipal: async (_p: string, s: string) => (s === 'owner' ? owner : null) })
        .compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      app.setGlobalPrefix('v1');
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const chain = app.get(SimulatedChain);
      const signer = app.get<SignerPort>(SIGNER);

      try {
        const call = (method: 'GET' | 'POST', url: string, token: string | null, body?: object, headers: Record<string, string> = {}) =>
          app.inject({ method, url, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers }, ...(body === undefined ? {} : { payload: body }) });

        // Owner: fund 25 USDC (minted into the omnibus), draw an x402 covenant, issue a seal.
        expect((await call('POST', '/v1/sandbox/credit', 'owner', { amount: '25', asset: 'USDC' }, { 'idempotency-key': 'fund' })).json()).toMatchObject({ asset: 'USDC', amount: '25.000000' });
        chain.mine();
        const mandate = await call('POST', '/v1/mandates', 'owner', {
          name: 'Oracle budget',
          asset: 'USDC',
          per_transaction_limit: '0.50',
          daily_limit: '5',
          lifetime_limit: '50',
          velocity: { max_count: 20, window_secs: 600 },
          allowed_categories: ['x402'],
          allowed_destinations: ['http://localhost'],
        });
        expect(mandate.statusCode).toBe(201);
        const mismatched = await call('POST', '/v1/mandates', 'owner', { name: 'bad', asset: 'NGN', per_transaction_limit: '1', daily_limit: '1', lifetime_limit: '1', velocity: { max_count: 1, window_secs: 60 }, allowed_categories: ['x402'] });
        expect(mismatched.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
        const token = (await call('POST', `/v1/mandates/${mandate.json().id}/credentials`, 'owner', { label: 'claude' })).json().token as string;

        // Agent: the oracle demands payment.
        const oracle = '/v1/sandbox/x402/oracle?q=Will%20it%20rain%20in%20Lagos';
        const demand = await call('GET', oracle, null);
        expect(demand.statusCode).toBe(402);
        const header = demand.headers['payment-required'] as string;
        const required = decodeHeader<PaymentRequired>(header);
        expect(required).toMatchObject({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: '100000' }] });

        // Meter signs it under the covenant.
        const paid = await call('POST', '/v1/agent/x402/payments', token, { payment_required: header, resource_url: `http://localhost${oracle}`, intent: 'The user asked about rain in Lagos' }, { 'idempotency-key': 'p1' });
        expect(paid.statusCode).toBe(202);
        expect(paid.json()).toMatchObject({ status: 'signed', amount: '0.100000', asset: 'USDC' });

        // Retry with PAYMENT-SIGNATURE: the oracle verifies, settles, answers.
        const answer = await call('GET', oracle, null, undefined, { 'payment-signature': paid.json().payment_signature });
        expect(answer.statusCode).toBe(200);
        expect(answer.json()).toMatchObject({ oracle: 'sandbox', question: 'Will it rain in Lagos' });
        const settlement = decodeHeader<SettlementResponse>(answer.headers['payment-response'] as string);
        expect(settlement.success).toBe(true);

        // The agent's hint only hurries the check; the chain decides once the block is safe.
        const paymentId = paid.json().payment_id as string;
        await call('POST', `/v1/agent/x402/payments/${paymentId}/settlement`, token, { payment_response: answer.headers['payment-response'] as string });
        chain.mineMany(3);
        await app.get(X402FinalizerService).tick();
        expect((await call('GET', `/v1/agent/x402/payments/${paymentId}`, token)).json()).toMatchObject({ status: 'settled', amount_charged: '0.100000', settlement_tx: settlement.transaction });

        // A second use of the same signature is refused by the token itself.
        const reuse = await call('GET', oracle, null, undefined, { 'payment-signature': paid.json().payment_signature });
        expect(reuse.statusCode).toBe(402);

        // An origin outside the covenant: nothing is signed.
        const foreign = await call('POST', '/v1/agent/x402/payments', token, { payment_required: header, resource_url: `http://localhost${oracle}`.replace('localhost', 'evil.example'), intent: 'x' }, { 'idempotency-key': 'p2' });
        expect(foreign.json()).toMatchObject({ error: { code: 'X402_RESOURCE_MISMATCH' } });

        // Owner reads the chronicle; the omnibus reconciles.
        const timeline = (await call('GET', `/v1/x402/payments/${paymentId}/timeline`, 'owner')).json();
        expect(timeline.entries.map((e: { kind: string }) => e.kind)).toEqual(['decision', 'ledger', 'purchase', 'provider', 'provider', 'ledger', 'purchase']);
        expect(timeline.purchase).toMatchObject({ amount: '0.100000', pay_to: required.accepts[0]!.payTo.toLowerCase(), settlement_tx: settlement.transaction });
        expect((await call('GET', `/v1/mandates/${mandate.json().id}/x402-payments`, 'owner')).json().payments).toHaveLength(1);
        await expect(app.get(X402ReconciliationService).run()).resolves.toMatchObject({ healthy: true, float: '0.000000' });
        expect(signer.address).toMatch(/^0x/);
      } finally {
        await app.close();
      }
    });
  }, 120_000);
});
