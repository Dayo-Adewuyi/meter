import { describe, expect, it } from 'vitest';
import { type PolicyFacts, type PolicyRequest, CHECK_ORDER, evaluatePolicy } from './policy.ts';

const NOW = new Date('2026-09-24T12:00:00Z');

function facts(overrides: Partial<PolicyFacts> = {}, calls: string[] = []): PolicyFacts {
  const track = <T>(name: string, value: T) => async () => {
    calls.push(name);
    return value;
  };
  return {
    credential: { status: 'active', expires_at: new Date('2027-01-01'), scopes: ['purchases:create'] },
    mandate: {
      status: 'active',
      expires_at: new Date('2027-01-01'),
      asset_code: 'NGN',
      per_transaction_limit: '200000',
      daily_limit: '500000',
      lifetime_limit: '1000000',
      velocity_max_count: 5,
      velocity_window_secs: 600,
      max_in_flight: 3,
      allowed_categories: ['airtime'],
      allowed_destinations: null,
    },
    now: NOW,
    dayResetsAt: new Date('2026-09-24T23:00:00Z'),
    ownerActive: track('owner', true),
    duplicates: track('duplicates', 0),
    velocityCount: track('velocity', 0),
    inFlight: track('inFlight', 0),
    exposureToday: track('today', 0n),
    exposureLifetime: track('lifetime', 0n),
    available: track('available', 10_000_000n),
    ...overrides,
  };
}

const request: PolicyRequest = { category: 'airtime', destination: '+2348030000000', amount: 50_000n, confirmDuplicate: false };

describe('policy evaluation', () => {
  it('runs every check in the documented order when approving', async () => {
    const result = await evaluatePolicy(facts(), request);
    expect(result.denial).toBeNull();
    expect(result.checks.map((c) => c.check)).toEqual(CHECK_ORDER);
    expect(CHECK_ORDER).toEqual([
      'credential', 'scope', 'mandate', 'owner', 'category', 'destination', 'per_transaction',
      'duplicate', 'velocity', 'concurrency', 'daily', 'lifetime', 'funds',
    ]);
  });

  it('short-circuits on the first denial and never runs the aggregates behind it', async () => {
    const calls: string[] = [];
    const result = await evaluatePolicy(facts({}, calls), { ...request, amount: 300_000n });
    expect(result.denial?.code).toBe('PER_TRANSACTION_LIMIT');
    expect(result.checks.at(-1)).toEqual({ check: 'per_transaction', passed: false });
    expect(calls).toEqual(['owner']);
  });

  it('denies a revoked credential before looking at anything else, even a broken mandate', async () => {
    const calls: string[] = [];
    const result = await evaluatePolicy(
      facts({ credential: { status: 'revoked', expires_at: NOW, scopes: [] }, mandate: null }, calls),
      request,
    );
    expect(result.denial?.code).toBe('CREDENTIAL_REVOKED');
    expect(calls).toEqual([]);
  });

  it('lets a confirmed duplicate through and blocks an unconfirmed one', async () => {
    const dup = facts({ duplicates: async () => 1 });
    expect((await evaluatePolicy(dup, request)).denial?.code).toBe('DUPLICATE_SUSPECTED');
    expect((await evaluatePolicy(dup, { ...request, confirmDuplicate: true })).denial).toBeNull();
  });

  it('enforces exposure at the exact limit boundary', async () => {
    const at = facts({ exposureToday: async () => 450_000n });
    expect((await evaluatePolicy(at, request)).denial).toBeNull(); // 450k + 50k = 500k: allowed
    const over = facts({ exposureToday: async () => 450_001n });
    expect((await evaluatePolicy(over, request)).denial).toMatchObject({
      code: 'DAILY_LIMIT', limit: '5000.00', current: '4500.01', requested: '500.00', remaining: '499.99', resets_at: '2026-09-24T23:00:00.000Z',
    });
  });

  it('never reveals the balance on INSUFFICIENT_FUNDS', async () => {
    const result = await evaluatePolicy(facts({ available: async () => 1n }), request);
    expect(result.denial?.code).toBe('INSUFFICIENT_FUNDS');
    expect(JSON.stringify(result.denial)).not.toContain('0.01');
  });
});
