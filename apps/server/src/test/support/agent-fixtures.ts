import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { AgentPrincipal } from '../../modules/core/authorization/agent-principal.ts';
import { AuthorizationService } from '../../modules/core/authorization/authorization.service.ts';
import { type CreateMandateInput, MandatesService } from '../../modules/core/authorization/mandates.service.ts';
import { CreditDebitService } from '../../modules/core/ledger/credit-debit.service.ts';
import { ReservationService } from '../../modules/core/ledger/reservation.service.ts';
import { type AgentsConfig, SANDBOX_AGENTS_CONFIG } from '../../modules/products/agents/agents.config.ts';
import { type PurchaseRequest, purchaseRequestSchema } from '../../modules/products/agents/airtime-request.ts';
import { PurchasesService } from '../../modules/products/agents/purchases.service.ts';
import type { DB } from '../../platform/database/types.ts';

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
