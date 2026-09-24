import type { Kysely } from 'kysely';
import { SimulatedChain } from '../../adapters/chain/simulated-chain.ts';
import type { Hex } from '../../adapters/evm/evm.ts';
import { LocalKeySigner, SANDBOX_SIGNER_KEY } from '../../adapters/signing/signer.port.ts';
import { SimulatedFacilitator } from '../../adapters/x402/facilitator.port.ts';
import { BASE_SEPOLIA, decodeHeader, encodeHeader, type PaymentPayload, type PaymentRequired, type PaymentRequirements } from '../../adapters/x402/protocol.ts';
import { SANDBOX_X402_CONFIG } from '../../modules/products/agents/x402/x402.config.ts';
import { X402FinalizerService } from '../../modules/products/agents/x402/x402-finalizer.service.ts';
import { X402PaymentsService } from '../../modules/products/agents/x402/x402-payments.service.ts';
import { X402ReconciliationService } from '../../modules/products/agents/x402/x402-reconciliation.service.ts';
import { type X402PaymentRequest, x402PaymentRequestSchema } from '../../modules/products/agents/x402/x402-request.ts';
import type { DB } from '../../platform/database/types.ts';
import { createAgentFixture } from './agent-fixtures.ts';

export const SELLER = '0x00000000000000000000000000000000005e11e7' as Hex;
export const ORIGIN = 'https://oracle.example';
export const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: BASE_SEPOLIA.network,
    amount: '100000',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: SELLER,
    maxTimeoutSeconds: 120,
    extra: { name: 'USDC', version: '2' },
    ...overrides,
  };
}

export function paymentRequired(url: string, offers: PaymentRequirements[] = [requirements()]): string {
  const body: PaymentRequired = { x402Version: 2, resource: { url, description: 'oracle' }, accepts: offers };
  return encodeHeader(body);
}

/** Services wired to one simulated chain and one fake clock. */
export async function x402World(db: Kysely<DB>, options: { funding?: bigint; mandate?: Record<string, unknown>; backing?: bigint } = {}) {
  let now = Date.UTC(2026, 8, 24, 12, 0, 0);
  const funding = options.funding ?? USDC(25);
  const f = await createAgentFixture(db, {
    funding,
    mandate: {
      assetCode: 'USDC',
      perTransactionLimit: USDC(1),
      dailyLimit: USDC(10),
      lifetimeLimit: USDC(100),
      allowedCategories: ['x402'],
      allowedDestinations: [ORIGIN],
      ...options.mandate,
    },
  });
  const chain = new SimulatedChain(BASE_SEPOLIA, () => now, 2);
  const signer = new LocalKeySigner(SANDBOX_SIGNER_KEY);
  // The omnibus float backs exactly what was credited (plus any USDC already in this database).
  chain.mint(signer.address, funding + (options.backing ?? 0n));
  chain.mine();
  const config = SANDBOX_X402_CONFIG;
  const payments = new X402PaymentsService(db, config, signer, f.authorization);
  const finalizer = new X402FinalizerService(db, config, chain, f.authorization);
  payments.clock = finalizer.clock = () => new Date(now);
  const facilitator = new SimulatedFacilitator(chain, BASE_SEPOLIA);
  const reconciliation = new X402ReconciliationService(db, chain, signer);
  let seq = 0;

  const world = {
    f,
    chain,
    signer,
    payments,
    finalizer,
    facilitator,
    reconciliation,
    now: () => now,
    /** Advances chain time and mines one block per `step` seconds. */
    advance(seconds: number, step = 2) {
      for (let s = 0; s < seconds; s += step) {
        now += step * 1000;
        chain.mine();
      }
    },
    request(overrides: Partial<Record<keyof X402PaymentRequest, unknown>> = {}, offers?: PaymentRequirements[]): X402PaymentRequest {
      const url = String(overrides.resource_url ?? `${ORIGIN}/oracle?q=${++seq}`);
      return x402PaymentRequestSchema.parse({ payment_required: paymentRequired(url, offers), resource_url: url, intent: 'ask the oracle', ...overrides });
    },
    async pay(overrides: Partial<Record<keyof X402PaymentRequest, unknown>> = {}, offers?: PaymentRequirements[]) {
      return payments.create(f.agent, crypto.randomUUID(), world.request(overrides, offers));
    },
    /** What the seller's facilitator does with a PAYMENT-SIGNATURE. */
    async sellerSettles(paymentSignature: string) {
      const payload = decodeHeader<PaymentPayload>(paymentSignature);
      return facilitator.settle(payload, payload.accepted);
    },
    async state(paymentId: string) {
      return (await db.selectFrom('agents.x402_payments').select('state').where('id', '=', paymentId).executeTakeFirstOrThrow()).state;
    },
    ledger: () => Promise.all([f.balance(f.availableAccountId), f.balance(f.reservedAccountId)]),
    async drain(seconds = 400) {
      for (let s = 0; s < seconds; s += 2) {
        world.advance(2);
        await finalizer.tick();
      }
    },
  };
  return world;
}
