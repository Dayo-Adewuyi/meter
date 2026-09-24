import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import { SimulatedVasProvider } from '../../adapters/vas/simulated-vas-provider.ts';
import type { VasProvider } from '../../adapters/vas/vas-provider.port.ts';
import type { AgentPrincipal } from '../../modules/core/authorization/agent-principal.ts';
import { AuthorizationService } from '../../modules/core/authorization/authorization.service.ts';
import { type CreateMandateInput, MandatesService } from '../../modules/core/authorization/mandates.service.ts';
import { CreditDebitService } from '../../modules/core/ledger/credit-debit.service.ts';
import { ReservationService } from '../../modules/core/ledger/reservation.service.ts';
import { type AgentsConfig, SANDBOX_AGENTS_CONFIG } from '../../modules/products/agents/agents.config.ts';
import { type PurchaseRequest, purchaseRequestSchema } from '../../modules/products/agents/airtime-request.ts';
import { FinalizerService } from '../../modules/products/agents/finalizer.service.ts';
import { PurchasesService } from '../../modules/products/agents/purchases.service.ts';
import type { DB, DeliveryStatus } from '../../platform/database/types.ts';

export const TEST_PEPPER = 'test-pepper-test-pepper-test-pepper-0123';

export interface AgentFixture {
  readonly ownerId: string;
  readonly mandateId: string;
  readonly availableAccountId: string;
  readonly reservedAccountId: string;
  readonly token: string;
  readonly agent: AgentPrincipal;
  readonly mandates: MandatesService;
  readonly authorization: AuthorizationService;
  readonly purchases: PurchasesService;
  balance(accountId: string): Promise<bigint>;
  /** Issues another credential on the same mandate. */
  newAgent(scopes?: string[]): Promise<AgentPrincipal & { token: string }>;
}

export function airtime(overrides: Partial<Record<string, unknown>> = {}): PurchaseRequest {
  return purchaseRequestSchema.parse({
    category: 'airtime',
    network: 'mtn',
    destination: '08030000000',
    amount: '500',
    intent: 'test purchase',
    ...overrides,
  });
}

/** An owner with a funded NGN balance, one mandate and one credential. */
export async function createAgentFixture(
  db: Kysely<DB>,
  options: { funding?: bigint; mandate?: Partial<CreateMandateInput>; config?: Partial<AgentsConfig> } = {},
): Promise<AgentFixture> {
  const owner = await db
    .insertInto('identity.users')
    .values({ status: 'active', roles: ['customer'] })
    .returning('id')
    .executeTakeFirstOrThrow();
  const reservations = new ReservationService(db);
  const mandates = new MandatesService(db, TEST_PEPPER);
  const authorization = new AuthorizationService(reservations);
  const purchases = new PurchasesService(db, { ...SANDBOX_AGENTS_CONFIG, ...options.config }, authorization, mandates);

  const mandate = await mandates.create(owner.id, {
    name: 'test mandate',
    assetCode: 'NGN',
    perTransactionLimit: 200_000n,
    dailyLimit: 500_000n,
    lifetimeLimit: 5_000_000n,
    velocityMaxCount: 100,
    velocityWindowSecs: 600,
    maxInFlight: 100,
    duplicateWindowSecs: 0,
    allowedCategories: ['airtime'],
    allowedDestinations: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...options.mandate,
  });
  const row = await db
    .selectFrom('authz.mandates')
    .select(['available_account_id', 'reserved_account_id'])
    .where('id', '=', mandate.id)
    .executeTakeFirstOrThrow();

  if ((options.funding ?? 0n) > 0n) {
    await new CreditDebitService(db).credit({
      idempotencyScope: 'test.funding',
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      availableAccountId: row.available_account_id,
      assetCode: 'NGN',
      amountAtomic: options.funding!,
    });
  }

  const newAgent = async (scopes = ['purchases:create', 'purchases:read']) => {
    const credential = await mandates.issueCredential(owner.id, mandate.id, {
      label: 'test agent',
      scopes,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return { credentialId: credential.id, mandateId: mandate.id, ownerId: owner.id, scopes, token: credential.token };
  };
  const first = await newAgent();

  return {
    ownerId: owner.id,
    mandateId: mandate.id,
    availableAccountId: row.available_account_id,
    reservedAccountId: row.reserved_account_id,
    token: first.token,
    agent: first,
    mandates,
    authorization,
    purchases,
    newAgent,
    async balance(accountId) {
      const balance = await db
        .selectFrom('ledger.balances')
        .select('posted_amount')
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return BigInt(balance?.posted_amount ?? '0');
    },
  };
}

/** A finalizer on a fake clock, driving one fixture's purchases. */
export class FinalizerHarness {
  now = new Date();
  readonly finalizer: FinalizerService;

  constructor(
    readonly db: Kysely<DB>,
    readonly f: AgentFixture,
    readonly provider: VasProvider = new SimulatedVasProvider({ latencyMs: 0, hangMs: 0 }),
  ) {
    this.finalizer = new FinalizerService(db, SANDBOX_AGENTS_CONFIG, provider, f.purchases);
    this.finalizer.clock = () => this.now;
  }

  get simulator(): SimulatedVasProvider {
    return this.provider as SimulatedVasProvider;
  }

  async buy(lastFour: string, amount = '500'): Promise<string> {
    const result = await this.f.purchases.create(this.f.agent, crypto.randomUUID(), airtime({ amount, destination: `0803000${lastFour}` }));
    expect(result.httpStatus).toBe(202);
    // The fake clock never runs behind the real one the purchase was stamped with.
    this.now = new Date(Math.max(this.now.getTime(), Date.now()));
    return result.body.purchase_id as string;
  }

  async status(id: string): Promise<DeliveryStatus> {
    return (await this.db.selectFrom('agents.purchases').select('delivery_status').where('id', '=', id).executeTakeFirstOrThrow()).delivery_status;
  }

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }

  /** Tick, advancing a second at a time, until the purchase leaves the active statuses. */
  async settle(id: string, maxSeconds = 120): Promise<DeliveryStatus> {
    for (let s = 0; s < maxSeconds; s++) {
      await this.finalizer.tick();
      const status = await this.status(id);
      if (!['pending_dispatch', 'dispatching', 'awaiting_confirmation'].includes(status)) return status;
      this.advance(1_000);
    }
    return this.status(id);
  }

  ledger() {
    return Promise.all([this.f.balance(this.f.availableAccountId), this.f.balance(this.f.reservedAccountId)]);
  }
}

export async function harness(db: Kysely<DB>, provider?: VasProvider) {
  return new FinalizerHarness(db, await createAgentFixture(db, { funding: 1_000_000n }), provider);
}
