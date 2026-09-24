import { describe, expect, it } from 'vitest';
import { bytesToHex, keccak256, normalizeAddress, recoverAddress } from '../../../../adapters/evm/evm.ts';
import { type Authorization, authorizationDigest, BASE_SEPOLIA, decodeHeader, encodeHeader, type PaymentPayload } from '../../../../adapters/x402/protocol.ts';
import { USDC_SYSTEM_ACCOUNT_IDS } from '../../../core/ledger/account-taxonomy.ts';
import { withMigratedDb } from '../../../../test/support/database.ts';
import { ORIGIN, paymentRequired, requirements, SELLER, USDC, x402World } from '../../../../test/support/x402-world.ts';
import { SANDBOX_X402_CONFIG } from './x402.config.ts';
import { X402FinalizerService } from './x402-finalizer.service.ts';
import { nonceFor } from './x402-payments.service.ts';
import { x402PaymentRequestSchema, X402RequestError } from './x402-request.ts';

const signedFields = (sig: string) => decodeHeader<PaymentPayload>(sig).payload;

describe('x402 payments', () => {
  // I16: Meter signs only for an approved, reserved payment, for exactly what was reserved.
  it('signs exactly the reserved payment and settles it only from the safe head', async () => {
    await withMigratedDb(async (db) => {
      const w = await x402World(db);
      const created = await w.pay();

      expect(created.httpStatus).toBe(202);
      const paymentId = created.body.payment_id as string;
      const { authorization, signature } = signedFields(created.body.payment_signature as string);
      expect(recoverAddress(authorizationDigest(BASE_SEPOLIA, authorization), signature)).toBe(w.signer.address);
      expect(authorization).toMatchObject({ to: normalizeAddress(SELLER), value: '100000', nonce: nonceFor(paymentId) });
      await expect(w.ledger()).resolves.toEqual([USDC(25) - 100_000n, 100_000n]);

      const settlement = await w.sellerSettles(created.body.payment_signature as string);
      expect(settlement.success).toBe(true);
      await w.finalizer.check(await db.selectFrom('agents.x402_payments').selectAll().where('id', '=', paymentId).executeTakeFirstOrThrow());
      await expect(w.state(paymentId)).resolves.toBe('signed'); // on-chain, but not yet at the safe head

      w.advance(6);
      await w.finalizer.tick();
      await expect(w.state(paymentId)).resolves.toBe('settled');
      await expect(w.ledger()).resolves.toEqual([USDC(25) - 100_000n, 0n]);
      await expect(w.f.balance(USDC_SYSTEM_ACCOUNT_IDS.provider_payable)).resolves.toBe(100_000n);
      const row = await db.selectFrom('agents.x402_payments').selectAll().where('id', '=', paymentId).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ settlement_tx: settlement.transaction, settled_value: '100000' });
      await expect(w.reconciliation.run()).resolves.toMatchObject({ healthy: true, float: '0.000000', foreignNonces: [] });
    });
  }, 60_000);

  // I17: one payment id, one authorization, whatever is retried.
  it('replays the identical authorization and never signs a second one', async () => {
    await withMigratedDb(async (db) => {
      const w = await x402World(db);
      const request = w.request();
      const first = await w.payments.create(w.f.agent, 'k1', request);
      const again = await w.payments.create(w.f.agent, 'k1', request);
      expect(again).toEqual({ ...first, replayed: true });

      const racing = await Promise.all(Array.from({ length: 6 }, () => w.payments.create(w.f.agent, 'k2', w.request({ resource_url: `${ORIGIN}/oracle?q=race` }))));
      expect(new Set(racing.map((r) => r.body.payment_signature)).size).toBe(1);
      const rows = await db.selectFrom('agents.x402_payments').select(['id', 'auth_nonce']).execute();
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.auth_nonce).toBe(nonceFor(row.id));
    });
  }, 60_000);

  it('refuses before signing anything it cannot or may not pay', async () => {
    await withMigratedDb(async (db) => {
      const w = await x402World(db, { mandate: { allowedCounterparties: [SELLER] } });
      const count = async () => (await db.selectFrom('agents.x402_payments').select('id').where('signature', 'is not', null).execute()).length;

      await expect(w.pay({ resource_url: 'https://elsewhere.example/oracle' })).resolves.toMatchObject({ httpStatus: 403, body: { error: { code: 'DESTINATION_NOT_ALLOWED' } } });
      await expect(w.pay({}, [requirements({ payTo: '0x00000000000000000000000000000000000000bb' })])).resolves.toMatchObject({ body: { error: { code: 'COUNTERPARTY_NOT_ALLOWED' } } });
      await expect(w.pay({}, [requirements({ amount: String(USDC(2)) })])).resolves.toMatchObject({ body: { error: { code: 'PER_TRANSACTION_LIMIT' } } });
      await expect(w.pay({ max_amount: '0.05' })).rejects.toBeInstanceOf(X402RequestError);
      await expect(w.pay({}, [requirements({ network: 'eip155:1' })])).rejects.toMatchObject({ code: 'X402_UNSUPPORTED' });
      await expect(w.pay({}, [requirements({ asset: '0x0000000000000000000000000000000000000001' })])).rejects.toMatchObject({ code: 'X402_UNSUPPORTED' });
      const url = `${ORIGIN}/oracle`;
      await expect(
        w.payments.create(w.f.agent, 'bind', x402PaymentRequestSchema.parse({ payment_required: paymentRequired(`${ORIGIN}/other`), resource_url: url, intent: 'x' })),
      ).rejects.toMatchObject({ code: 'X402_RESOURCE_MISMATCH' });

      expect(await count()).toBe(0);
      await expect(w.ledger()).resolves.toEqual([USDC(25), 0n]);
    });
  }, 60_000);

  // I18: release only once chain time at the safe head is past validBefore, nonce unused.
  it('holds an unsettled payment until the safe head passes validBefore, then releases', async () => {
    await withMigratedDb(async (db) => {
      const w = await x402World(db);
      const created = await w.pay();
      const paymentId = created.body.payment_id as string;
      const validBefore = Number(signedFields(created.body.payment_signature as string).authorization.validBefore);

      while (Number((await w.chain.safeHead()).timestamp) < validBefore) {
        await w.finalizer.tick();
        await expect(w.state(paymentId)).resolves.toBe('signed');
        await expect(w.ledger()).resolves.toEqual([USDC(25) - 100_000n, 100_000n]);
        w.advance(2);
      }
      await w.drain(20);
      await expect(w.state(paymentId)).resolves.toBe('lapsed');
      await expect(w.ledger()).resolves.toEqual([USDC(25), 0n]);

      // A seller trying afterwards gets nothing: the token refuses an expired authorization.
      const late = await w.sellerSettles(created.body.payment_signature as string);
      expect(late.success).toBe(false);
      await expect(w.reconciliation.run()).resolves.toMatchObject({ healthy: true, float: '0.000000' });
    });
  }, 60_000);

  it('settles, never lapses, a payment executed just before validBefore', async () => {
    await withMigratedDb(async (db) => {
      const w = await x402World(db);
      const created = await w.pay();
      const paymentId = created.body.payment_id as string;
      const validBefore = Number(signedFields(created.body.payment_signature as string).authorization.validBefore);
      while (Number(w.chain.latestTimestamp()) < validBefore - 14) {
        w.advance(2);
        await w.finalizer.tick();
      }
      expect((await w.sellerSettles(created.body.payment_signature as string)).success).toBe(true);
      await w.drain(60);
      await expect(w.state(paymentId)).resolves.toBe('settled');
    });
  }, 60_000);

  // I19: nobody but the chain can make Meter charge.
  it('ignores the agent, the seller and reorged blocks as witnesses of payment', async () => {
    await withMigratedDb(async (db) => {
      const w = await x402World(db);
      const liar = await w.pay();
      const liarId = liar.body.payment_id as string;
      // "200 without settling" plus a forged PAYMENT-RESPONSE from the agent.
      await w.payments.hint(w.f.agent, liarId, encodeHeader({ success: true, transaction: `0x${'ab'.repeat(32)}`, network: BASE_SEPOLIA.network }));
      await w.finalizer.tick();
      await expect(w.state(liarId)).resolves.toBe('signed');

      const reorged = await w.pay();
      const reorgedId = reorged.body.payment_id as string;
      expect((await w.sellerSettles(reorged.body.payment_signature as string)).success).toBe(true);
      w.chain.reorg(1); // the block holding it never reaches the safe head
      await w.drain(400);

      await expect(w.state(liarId)).resolves.toBe('lapsed');
      await expect(w.state(reorgedId)).resolves.toBe('lapsed');
      await expect(w.ledger()).resolves.toEqual([USDC(25), 0n]);
      await expect(w.reconciliation.run()).resolves.toMatchObject({ healthy: true });
    });
  }, 60_000);

  it('goes unresolved when the chain cannot be read past the deadline, and an operator cannot release a spent nonce', async () => {
    await withMigratedDb(async (db) => {
      const w = await x402World(db);
      const created = await w.pay();
      const paymentId = created.body.payment_id as string;
      expect((await w.sellerSettles(created.body.payment_signature as string)).success).toBe(true);

      const broken = new X402FinalizerService(db, SANDBOX_X402_CONFIG, {
        network: BASE_SEPOLIA.network,
        safeHead: async () => { throw new Error('rpc down'); },
        authorizationUse: async () => { throw new Error('rpc down'); },
        authorizationUses: async () => [],
        balanceOf: async () => 0n,
      }, w.f.authorization);
      broken.clock = () => new Date(w.now());
      for (let i = 0; i < 250; i++) {
        w.advance(2);
        await broken.tick();
      }
      await expect(w.state(paymentId)).resolves.toBe('unresolved');
      await expect(w.ledger()).resolves.toEqual([USDC(25) - 100_000n, 100_000n]); // still held

      await expect(w.finalizer.resolve('00000000-0000-7000-8000-00000000000a', paymentId, { outcome: 'lapsed', reason: 'looks unpaid', evidence: 'none' })).rejects.toThrow(/cannot be released/);
      await expect(w.finalizer.resolve('00000000-0000-7000-8000-00000000000a', paymentId, { outcome: 'settled', reason: 'on-chain', evidence: 'basescan tx' })).resolves.toBe(true);
      await expect(w.state(paymentId)).resolves.toBe('settled');
    });
  }, 60_000);

  // I20: the omnibus reconciles to the ledger; a foreign nonce is caught.
  it('detects key use outside the policy path and an under-backed wallet', async () => {
    await withMigratedDb(async (db) => {
      const w = await x402World(db);
      const t = Number(w.chain.latestTimestamp());
      const rogue: Authorization = {
        from: w.signer.address,
        to: '0x00000000000000000000000000000000000000ee',
        value: '5000000',
        validAfter: String(t - 60),
        validBefore: String(t + 120),
        nonce: bytesToHex(keccak256('not issued by Meter')),
      };
      w.chain.submitTransferWithAuthorization(rogue, w.signer.sign(authorizationDigest(BASE_SEPOLIA, rogue)));
      w.advance(8);

      const report = await w.reconciliation.run();
      expect(report.healthy).toBe(false);
      expect(report.foreignNonces).toEqual([rogue.nonce]);
      expect(report.float).toBe('-5.000000');
    });
  }, 60_000);
});
