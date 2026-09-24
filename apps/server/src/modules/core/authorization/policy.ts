import { ASSETS, type AssetCode, fromAtomic } from '@meter/contracts';

export type DenialCode =
  | 'CREDENTIAL_INVALID'
  | 'CREDENTIAL_REVOKED'
  | 'CREDENTIAL_EXPIRED'
  | 'SCOPE_DENIED'
  | 'MANDATE_REVOKED'
  | 'MANDATE_EXPIRED'
  | 'ACCOUNT_RESTRICTED'
  | 'CATEGORY_NOT_ALLOWED'
  | 'DESTINATION_NOT_ALLOWED'
  | 'PER_TRANSACTION_LIMIT'
  | 'DUPLICATE_SUSPECTED'
  | 'VELOCITY_LIMIT'
  | 'CONCURRENCY_LIMIT'
  | 'DAILY_LIMIT'
  | 'LIFETIME_LIMIT'
  | 'INSUFFICIENT_FUNDS';

/** The §6.3 payload, minus the decision id the caller adds once it is written. */
export interface Denial {
  readonly code: DenialCode;
  readonly message: string;
  readonly dimension?: string;
  readonly limit?: string;
  readonly current?: string;
  readonly requested?: string;
  readonly remaining?: string;
  readonly resets_at?: string;
}

export interface CheckRecord {
  readonly check: string;
  readonly passed: boolean;
}

export interface PolicyRequest {
  readonly category: string;
  readonly destination: string;
  readonly amount: bigint;
  readonly confirmDuplicate: boolean;
}

export interface CredentialFacts {
  readonly status: 'active' | 'revoked';
  readonly expires_at: Date;
  readonly scopes: readonly string[];
}

export interface MandateFacts {
  readonly status: 'active' | 'revoked';
  readonly expires_at: Date;
  readonly asset_code: string;
  readonly per_transaction_limit: string;
  readonly daily_limit: string;
  readonly lifetime_limit: string;
  readonly velocity_max_count: number;
  readonly velocity_window_secs: number;
  readonly max_in_flight: number;
  readonly allowed_categories: readonly string[];
  readonly allowed_destinations: readonly string[] | null;
}

/**
 * Everything the evaluator reads. Aggregates are lazy so a request declined by
 * a cheap check never pays for the expensive ones (§6.1).
 */
export interface PolicyFacts {
  readonly credential: CredentialFacts | null;
  readonly mandate: MandateFacts | null;
  readonly now: Date;
  /** Start of the next Africa/Lagos calendar day. */
  readonly dayResetsAt: Date;
  ownerActive(): Promise<boolean>;
  duplicates(): Promise<number>;
  velocityCount(): Promise<number>;
  inFlight(): Promise<number>;
  exposureToday(): Promise<bigint>;
  exposureLifetime(): Promise<bigint>;
  available(): Promise<bigint>;
}

export interface PolicyResult {
  readonly checks: readonly CheckRecord[];
  readonly denial: Denial | null;
}

type Check = (
  facts: PolicyFacts,
  request: PolicyRequest,
  money: (atomic: bigint) => string,
) => Promise<Denial | null> | Denial | null;

const deny = (code: DenialCode, message: string, extra: Omit<Denial, 'code' | 'message'> = {}): Denial => ({
  code,
  message,
  ...extra,
});

function limitDenial(
  code: DenialCode,
  dimension: string,
  message: string,
  limit: bigint,
  current: bigint,
  request: PolicyRequest,
  money: (atomic: bigint) => string,
  resetsAt?: Date,
): Denial {
  const remaining = limit - current > 0n ? limit - current : 0n;
  return deny(code, message, {
    dimension,
    limit: money(limit),
    current: money(current),
    requested: money(request.amount),
    remaining: money(remaining),
    ...(resetsAt === undefined ? {} : { resets_at: resetsAt.toISOString() }),
  });
}

/** Ordered, deny-by-default, first denial wins (§6.1). Order is the contract. */
const CHECKS: readonly (readonly [string, Check])[] = [
  ['credential', ({ credential, now }) => {
    if (credential === null) return deny('CREDENTIAL_INVALID', 'The agent credential is not valid.');
    if (credential.status !== 'active') return deny('CREDENTIAL_REVOKED', 'The agent credential has been revoked.');
    if (credential.expires_at <= now) return deny('CREDENTIAL_EXPIRED', 'The agent credential has expired.');
    return null;
  }],
  ['scope', ({ credential }) =>
    credential!.scopes.includes('purchases:create')
      ? null
      : deny('SCOPE_DENIED', 'The agent credential is not allowed to make purchases.')],
  ['mandate', ({ mandate, now }) => {
    if (mandate === null || mandate.status !== 'active') return deny('MANDATE_REVOKED', 'The spending mandate has been revoked.');
    if (mandate.expires_at <= now) return deny('MANDATE_EXPIRED', 'The spending mandate has expired.');
    return null;
  }],
  ['owner', async (facts) =>
    (await facts.ownerActive()) ? null : deny('ACCOUNT_RESTRICTED', "The owner's account is restricted.")],
  ['category', ({ mandate }, request) =>
    mandate!.allowed_categories.includes(request.category)
      ? null
      : deny('CATEGORY_NOT_ALLOWED', `The mandate does not allow ${request.category} purchases.`, { dimension: 'allowed_categories' })],
  ['destination', ({ mandate }, request) =>
    mandate!.allowed_destinations === null || mandate!.allowed_destinations.includes(request.destination)
      ? null
      : deny('DESTINATION_NOT_ALLOWED', 'The mandate does not allow purchases for this destination.', { dimension: 'allowed_destinations' })],
  ['per_transaction', ({ mandate }, request, money) => {
    const limit = BigInt(mandate!.per_transaction_limit);
    return request.amount <= limit
      ? null
      : deny('PER_TRANSACTION_LIMIT', "This purchase exceeds the mandate's per-transaction limit.", {
          dimension: 'per_transaction_limit',
          limit: money(limit),
          requested: money(request.amount),
        });
  }],
  ['duplicate', async (facts, request) =>
    request.confirmDuplicate || (await facts.duplicates()) === 0
      ? null
      : deny('DUPLICATE_SUSPECTED', 'An identical purchase for this destination was just made. Confirm with the user before repeating it.', {
          dimension: 'duplicate_window_secs',
        })],
  ['velocity', async (facts) => {
    const count = await facts.velocityCount();
    const { velocity_max_count: max, velocity_window_secs: window } = facts.mandate!;
    return count < max
      ? null
      : deny('VELOCITY_LIMIT', `The mandate allows at most ${max} purchases per ${window} seconds.`, {
          dimension: 'velocity',
          limit: String(max),
          current: String(count),
        });
  }],
  ['concurrency', async (facts) => {
    const count = await facts.inFlight();
    const max = facts.mandate!.max_in_flight;
    return count < max
      ? null
      : deny('CONCURRENCY_LIMIT', `The mandate allows at most ${max} purchases in progress at once.`, {
          dimension: 'max_in_flight',
          limit: String(max),
          current: String(count),
        });
  }],
  ['daily', async (facts, request, money) => {
    const current = await facts.exposureToday();
    const limit = BigInt(facts.mandate!.daily_limit);
    return current + request.amount <= limit
      ? null
      : limitDenial('DAILY_LIMIT', 'daily_limit', "This purchase would exceed the mandate's daily limit.", limit, current, request, money, facts.dayResetsAt);
  }],
  ['lifetime', async (facts, request, money) => {
    const current = await facts.exposureLifetime();
    const limit = BigInt(facts.mandate!.lifetime_limit);
    return current + request.amount <= limit
      ? null
      : limitDenial('LIFETIME_LIMIT', 'lifetime_limit', "This purchase would exceed the mandate's lifetime limit.", limit, current, request, money);
  }],
  // The ledger re-checks under its own account lock; this is the same read
  // inside the same SERIALIZABLE snapshot, so a decline never touches ledger.*.
  ['funds', async (facts, request, money) => {
    const available = await facts.available();
    return available >= request.amount
      ? null
      : deny('INSUFFICIENT_FUNDS', 'The balance is too low for this purchase.', {
          dimension: 'available_balance',
          requested: money(request.amount),
        });
  }],
];

export const CHECK_ORDER = CHECKS.map(([name]) => name);

export async function evaluatePolicy(facts: PolicyFacts, request: PolicyRequest): Promise<PolicyResult> {
  const asset = ASSETS[(facts.mandate?.asset_code ?? 'NGN') as AssetCode] ?? ASSETS.NGN;
  const money = (atomic: bigint) => fromAtomic(atomic, asset);
  const checks: CheckRecord[] = [];
  for (const [name, check] of CHECKS) {
    const denial = await check(facts, request, money);
    checks.push({ check: name, passed: denial === null });
    if (denial !== null) return { checks, denial };
  }
  return { checks, denial: null };
}
