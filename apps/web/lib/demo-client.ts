import { ApiError, type Balance, type CreateMandateInput, type Credential, type Mandate, type MeterClient, type Purchase, type Timeline, type TimelineEntry, type X402Payment } from './types';

/**
 * In-memory stand-in for the owner API, used when no Clerk key is configured:
 * the site can be previewed, judged and tested without a backend or a login.
 * Mutations persist for the tab's lifetime only.
 */

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
/** Fixture ids are fixed so deep links survive a reload; new records get random ones. */
let seq = 0;
let seeding = false;
const id = () => (seeding ? `0199d000-0000-7000-8000-${String(++seq).padStart(12, '0')}` : crypto.randomUUID());
const pause = () => new Promise((resolve) => setTimeout(resolve, 220 + Math.random() * 220));

// ponytail: demo-only arithmetic on small sums; real money never passes through here.
const cents = (value: string) => Math.round(Number(value) * 100);
const decimal = (value: number) => (value / 100).toFixed(2);

function credential(label: string, status: Credential['status'], lastUsedMinutes: number | null, createdDays: number): Credential {
  return {
    id: id(),
    public_id: Math.random().toString(36).slice(2, 14).padEnd(12, 'q'),
    label,
    scopes: ['purchases:create', 'purchases:read'],
    status,
    expires_at: ahead(30 * 1440 * MIN),
    last_used_at: lastUsedMinutes === null ? null : ago(lastUsedMinutes * MIN),
    created_at: ago(createdDays * 1440 * MIN),
  };
}

interface Scenario {
  readonly purchase: Purchase;
  readonly shape: 'delivered' | 'unknown_delivered' | 'unknown_rejected' | 'declined' | 'processing' | 'crash';
  readonly declineCode?: string;
}

function purchase(minutesAgo: number, amount: string, destination: string, status: Purchase['status'], intent: string, label: string): Purchase {
  return {
    purchase_id: id(),
    status,
    delivery_status: { delivered: 'delivered', failed: 'rejected', declined: 'declined', expired: 'expired', processing: 'awaiting_confirmation' }[status],
    network: 'mtn',
    destination,
    amount,
    amount_charged: status === 'delivered' ? amount : '0.00',
    amount_released: status === 'failed' || status === 'expired' ? amount : '0.00',
    amount_held: status === 'processing' ? amount : '0.00',
    provider_reference: status === 'delivered' ? `SIM-${Math.random().toString(16).slice(2, 10)}` : null,
    intent,
    credential_label: label,
    created_at: ago(minutesAgo * MIN),
  };
}

function timelineFor({ purchase: p, shape, declineCode }: Scenario): Timeline {
  const summary: Timeline['purchase'] = {
    amount: p.amount,
    asset: 'NGN',
    network: p.network,
    destination: `${p.destination.slice(0, 7)}····${p.destination.slice(-3)}`,
    intent: p.intent,
    delivery_status: p.delivery_status,
    credential_label: p.credential_label ?? 'agent',
    created_at: p.created_at,
  };
  const t0 = new Date(p.created_at).getTime();
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  const checks = ['credential', 'scope', 'mandate', 'owner', 'category', 'destination', 'per_transaction', 'duplicate', 'velocity', 'concurrency', 'daily', 'lifetime', 'funds'];
  const failAt = declineCode === undefined ? -1 : checks.indexOf('per_transaction');
  const entries: TimelineEntry[] = [
    {
      at: at(0),
      kind: 'decision',
      summary: shape === 'declined' ? `declined ${declineCode}` : 'approved',
      detail: {
        outcome: shape === 'declined' ? 'declined' : 'approved',
        reason_code: declineCode ?? null,
        checks: checks.slice(0, failAt === -1 ? checks.length : failAt + 1).map((c, i) => `${c} ${i === failAt ? '✗' : '✓'}`).join(' '),
      },
    },
  ];
  const ledger = (ms: number, type: string, move: string) =>
    entries.push({ at: at(ms), kind: 'ledger', summary: `${type} ${move}`, detail: { type, amount: p.amount, move } });
  const move = (ms: number, from: string, to: string, actor: string, reason: string) =>
    entries.push({ at: at(ms), kind: 'purchase', summary: `${from} → ${to}`, detail: { from, to, actor, reason } });
  const provider = (ms: number, call: string, kind: string, extra: Record<string, unknown> = {}) =>
    entries.push({ at: at(ms), kind: 'provider', summary: `${call} → ${kind}`, detail: { call, kind, ...extra } });

  if (shape === 'declined') {
    move(3, '∅', 'declined', `agent:${p.credential_label}`, declineCode ?? 'declined');
    return { purchase_id: p.purchase_id, correlation_id: id(), purchase: summary, entries };
  }
  ledger(4, 'reserve', 'available → reserved');
  move(4, '∅', 'pending_dispatch', `agent:${p.credential_label}`, 'authorized');
  move(310, 'pending_dispatch', 'dispatching', 'worker', 'write_ahead');
  if (shape === 'delivered') {
    provider(640, 'send', 'delivered', { provider_reference: p.provider_reference });
    ledger(660, 'capture', 'reserved → provider_payable');
    move(660, 'dispatching', 'delivered', 'worker', 'provider_delivered');
  } else if (shape === 'crash') {
    move(30_400, 'dispatching', 'awaiting_confirmation', 'worker', 'recovered_after_lease_expiry');
    provider(30_900, 'requery', 'delivered', { provider_reference: p.provider_reference });
    ledger(30_910, 'capture', 'reserved → provider_payable');
    move(30_910, 'awaiting_confirmation', 'delivered', 'worker', 'provider_delivered');
  } else {
    provider(15_300, 'send', 'unknown', { reason: 'timeout after write' });
    move(15_310, 'dispatching', 'awaiting_confirmation', 'worker', 'provider_outcome_unknown');
    provider(17_400, 'requery', 'pending');
    if (shape === 'unknown_delivered') {
      provider(21_600, 'requery', 'delivered', { provider_reference: p.provider_reference });
      ledger(21_620, 'capture', 'reserved → provider_payable');
      move(21_620, 'awaiting_confirmation', 'delivered', 'worker', 'provider_delivered');
    } else if (shape === 'unknown_rejected') {
      provider(21_600, 'requery', 'rejected', { code: 'PRODUCT_UNAVAILABLE' });
      ledger(21_620, 'release', 'reserved → available');
      move(21_620, 'awaiting_confirmation', 'rejected', 'worker', 'provider_rejected');
    } else {
      provider(25_700, 'requery', 'pending');
    }
  }
  return { purchase_id: p.purchase_id, correlation_id: id(), purchase: summary, entries };
}

interface X402Scenario {
  readonly payment: X402Payment;
  readonly timeline: Timeline;
}

const hex = (label: string) => `0x${Array.from(label).map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, 'a').slice(0, 64)}`;

function x402Scenario(minutesAgo: number, amount: string, question: string, status: X402Payment['status'], label: string): X402Scenario {
  const created = new Date(Date.now() - minutesAgo * MIN);
  const at = (ms: number) => new Date(created.getTime() + ms).toISOString();
  const payTo = '0x7a3be5c7c1d0b0e0f0a0b0c0d0e0f00112233445';
  const settlement = status === 'settled' ? hex(`tx${question}`) : null;
  const payment: X402Payment = {
    payment_id: id(),
    status,
    state: status === 'pending' ? 'signed' : status,
    amount,
    asset: 'USDC',
    network: 'eip155:84532',
    pay_to: payTo,
    resource_url: `http://localhost:3001/v1/sandbox/x402/oracle?q=${encodeURIComponent(question)}`,
    method: 'GET',
    intent: question,
    valid_before: at(120_000),
    settlement_tx: settlement,
    credential_label: label,
    created_at: created.toISOString(),
  };
  const checks = ['credential', 'scope', 'mandate', 'owner', 'category', 'destination', 'per_transaction', 'duplicate', 'velocity', 'concurrency', 'daily', 'lifetime', 'funds'];
  const entries: TimelineEntry[] = [];
  const move = (ms: number, from: string, to: string, actor: string, reason: string) => entries.push({ at: at(ms), kind: 'purchase', summary: `${from} → ${to}`, detail: { from, to, actor, reason } });
  const ledger = (ms: number, type: string, moveText: string) => entries.push({ at: at(ms), kind: 'ledger', summary: type, detail: { type, amount, move: moveText } });
  if (status === 'declined') {
    const fail = checks.indexOf('destination');
    entries.push({ at: at(0), kind: 'decision', summary: 'declined', detail: { outcome: 'declined', reason_code: 'DESTINATION_NOT_ALLOWED', checks: checks.slice(0, fail + 1).map((c, i) => `${c} ${i === fail ? '✗' : '✓'}`).join(' ') } });
    move(3, '∅', 'declined', `agent:${label}`, 'DESTINATION_NOT_ALLOWED');
  } else {
    entries.push({ at: at(0), kind: 'decision', summary: 'approved', detail: { outcome: 'approved', reason_code: null, checks: checks.map((c) => `${c} ✓`).join(' ') } });
    ledger(5, 'reserve', 'available → reserved');
    move(5, '∅', 'signed', `agent:${label}`, 'authorized');
    if (status === 'settled') {
      entries.push({ at: at(900), kind: 'provider', summary: 'hint', detail: { call: 'hint', kind: 'reported' } });
      entries.push({ at: at(6_400), kind: 'provider', summary: 'AuthorizationUsed at block 4', detail: { call: 'chain', kind: 'used', provider_reference: settlement } });
      ledger(6_420, 'capture', 'reserved → provider_payable');
      move(6_420, 'signed', 'settled', 'worker', 'authorization_used_at_safe_head');
    }
    if (status === 'lapsed') {
      entries.push({ at: at(126_000), kind: 'provider', summary: 'expired unused', detail: { call: 'chain', kind: 'expired unused' } });
      ledger(126_020, 'release', 'reserved → available');
      move(126_020, 'signed', 'lapsed', 'worker', 'expired_unused_at_safe_head');
    }
  }
  const timeline: Timeline = {
    purchase_id: payment.payment_id,
    correlation_id: id(),
    purchase: {
      amount,
      asset: 'USDC',
      network: payment.network,
      destination: payment.resource_url,
      intent: question,
      delivery_status: payment.state,
      credential_label: label,
      created_at: payment.created_at,
      pay_to: payTo,
      nonce: status === 'declined' ? null : hex(`nonce${question}`),
      valid_before: status === 'declined' ? null : payment.valid_before,
      settlement_tx: settlement,
    },
    entries,
  };
  return { payment, timeline };
}

function seed() {
  seeding = true;
  seq = 0;
  try {
    return seedFixtures();
  } finally {
    seeding = false;
  }
}

function seedFixtures() {
  const mama = credential('Claude Desktop', 'active', 4, 6);
  const scenariosA: Scenario[] = [
    { shape: 'processing', purchase: purchase(2, '500.00', '+2348030000005', 'processing', 'Top up Mama before her call tonight', 'Claude Desktop') },
    { shape: 'unknown_rejected', purchase: purchase(19, '500.00', '+2348030000003', 'failed', 'Recharge the spare line in the car', 'Claude Desktop') },
    { shape: 'unknown_delivered', purchase: purchase(41, '500.00', '+2348030000002', 'delivered', 'User asked to top up their own line before a trip', 'Claude Desktop') },
    { shape: 'declined', declineCode: 'PER_TRANSACTION_LIMIT', purchase: purchase(58, '3000.00', '+2348030000000', 'declined', 'Same number, a bigger top-up for the week', 'Claude Desktop') },
    { shape: 'delivered', purchase: purchase(64, '500.00', '+2348030000000', 'delivered', 'Top up my line — I am about to run out', 'Claude Desktop') },
    { shape: 'crash', purchase: purchase(1440 + 90, '1000.00', '+2348030000007', 'delivered', 'Weekly top-up for Mama', 'Old laptop') },
  ];
  const scenariosB: Scenario[] = [
    { shape: 'delivered', purchase: purchase(33, '1500.00', '+2348120000000', 'delivered', 'Airtime for the Abuja trip, as discussed', 'Travel agent') },
    { shape: 'delivered', purchase: purchase(95, '1200.00', '+2348120000000', 'delivered', 'Data-heavy day; top up the travel line', 'Travel agent') },
  ];
  const base = { asset: 'NGN', created_at: ago(6 * 1440 * MIN), revoked_at: null, expires_at: ahead(24 * 1440 * MIN) };
  const reset = ahead(9 * 60 * MIN);
  const mandates: Mandate[] = [
    {
      ...base,
      id: id(),
      name: "Mama's line",
      status: 'active',
      limits: { per_transaction: '2000.00', daily: '5000.00', lifetime: '50000.00', velocity: { max_count: 5, window_secs: 600 }, max_in_flight: 3, duplicate_window_secs: 120, allowed_categories: ['airtime'], allowed_destinations: null },
      exposure: { today: '1500.00', lifetime: '2500.00', daily_remaining: '3500.00', lifetime_remaining: '47500.00', in_flight: 1, daily_resets_at: reset },
      credentials: [mama, credential('Old laptop', 'revoked', 1440 + 80, 20)],
    },
    {
      ...base,
      id: id(),
      name: 'Travel top-ups',
      status: 'active',
      created_at: ago(2 * 1440 * MIN),
      limits: { per_transaction: '1500.00', daily: '3000.00', lifetime: '20000.00', velocity: { max_count: 3, window_secs: 3600 }, max_in_flight: 2, duplicate_window_secs: 300, allowed_categories: ['airtime'], allowed_destinations: ['+2348120000000'] },
      exposure: { today: '2700.00', lifetime: '2700.00', daily_remaining: '300.00', lifetime_remaining: '17300.00', in_flight: 0, daily_resets_at: reset },
      credentials: [credential('Travel agent', 'active', 33, 2)],
    },
    {
      ...base,
      id: id(),
      name: 'The intern bot',
      status: 'revoked',
      revoked_at: ago(3 * 1440 * MIN),
      created_at: ago(40 * 1440 * MIN),
      limits: { per_transaction: '500.00', daily: '1000.00', lifetime: '5000.00', velocity: { max_count: 2, window_secs: 3600 }, max_in_flight: 1, duplicate_window_secs: 120, allowed_categories: ['airtime'], allowed_destinations: null },
      exposure: { today: '0.00', lifetime: '1500.00', daily_remaining: '1000.00', lifetime_remaining: '3500.00', in_flight: 0, daily_resets_at: reset },
      credentials: [credential('Intern', 'revoked', 3 * 1440 + 30, 40)],
    },
  ];
  const oracleSeal = credential('Claude Desktop (x402)', 'active', 1, 1);
  const oracle: Mandate = {
    ...base,
    id: id(),
    name: 'Oracle budget',
    asset: 'USDC',
    status: 'active',
    created_at: ago(1440 * MIN),
    limits: { per_transaction: '0.500000', daily: '5.000000', lifetime: '50.000000', velocity: { max_count: 20, window_secs: 600 }, max_in_flight: 3, duplicate_window_secs: 120, allowed_categories: ['x402'], allowed_destinations: ['http://localhost:3001'], allowed_counterparties: null },
    exposure: { today: '0.200000', lifetime: '0.300000', daily_remaining: '4.800000', lifetime_remaining: '49.700000', in_flight: 1, daily_resets_at: reset },
    credentials: [oracleSeal],
  };
  mandates.push(oracle);
  const x402 = new Map<string, X402Scenario[]>([
    [
      oracle.id,
      [
        x402Scenario(1, '0.100000', 'Will it rain in Lagos tonight?', 'pending', 'Claude Desktop (x402)'),
        x402Scenario(9, '0.100000', 'What does the chain say about Friday?', 'settled', 'Claude Desktop (x402)'),
        x402Scenario(44, '0.100000', 'Should I trust a seller who never settles?', 'lapsed', 'Claude Desktop (x402)'),
        x402Scenario(80, '0.100000', 'Ask the oracle on evil.example', 'declined', 'Claude Desktop (x402)'),
        x402Scenario(1440 + 20, '0.100000', 'First question to the oracle', 'settled', 'Claude Desktop (x402)'),
      ],
    ],
  ]);
  const scenarios = new Map<string, Scenario[]>([
    [mandates[0]!.id, scenariosA],
    [mandates[1]!.id, scenariosB],
    [mandates[2]!.id, []],
  ]);
  const balance: Balance = {
    asset: 'NGN',
    available: '14250.00',
    reserved: '500.00',
    balances: [
      { asset: 'NGN', available: '14250.00', reserved: '500.00' },
      { asset: 'USDC', available: '24.600000', reserved: '0.100000' },
    ],
  };
  return { balance, mandates, scenarios, x402 };
}

const STORE = 'meter:demo:v2';
type State = ReturnType<typeof seed>;

function restore(): State {
  try {
    const saved = sessionStorage.getItem(STORE);
    if (saved !== null) {
      const parsed = JSON.parse(saved) as Omit<State, 'scenarios' | 'x402'> & { scenarios: [string, Scenario[]][]; x402: [string, X402Scenario[]][] };
      return { ...parsed, scenarios: new Map(parsed.scenarios), x402: new Map(parsed.x402) };
    }
  } catch {
    // Private mode or corrupt state: start from the fixtures.
  }
  return seed();
}

export function demoClient(): MeterClient {
  const state = restore();
  const save = () => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify({ ...state, scenarios: [...state.scenarios], x402: [...state.x402] }));
    } catch {
      // Demo changes then last for this page only.
    }
  };
  const find = (mandateId: string) => {
    const mandate = state.mandates.find((m) => m.id === mandateId);
    if (mandate === undefined) throw new ApiError('MANDATE_NOT_FOUND', 'No such covenant.');
    return mandate;
  };
  const replace = (next: Mandate) => {
    state.mandates = state.mandates.map((m) => (m.id === next.id ? next : m));
  };

  return {
    async balance() {
      await pause();
      return state.balance;
    },
    async credit(amount) {
      await pause();
      state.balance = { ...state.balance, available: decimal(cents(state.balance.available) + cents(amount)) };
      save();
    },
    async mandates() {
      await pause();
      return state.mandates;
    },
    async mandate(mandateId) {
      await pause();
      return find(mandateId);
    },
    async createMandate(input: CreateMandateInput) {
      await pause();
      if (cents(input.per_transaction_limit) > cents(input.daily_limit) || cents(input.daily_limit) > cents(input.lifetime_limit)) {
        throw new ApiError('VALIDATION_FAILED', 'Limits must satisfy per deed ≤ per day ≤ in all.');
      }
      const mandate: Mandate = {
        id: id(),
        name: input.name,
        asset: input.asset,
        status: 'active',
        expires_at: input.expires_at,
        revoked_at: null,
        created_at: new Date().toISOString(),
        limits: {
          per_transaction: input.per_transaction_limit,
          daily: input.daily_limit,
          lifetime: input.lifetime_limit,
          velocity: input.velocity,
          max_in_flight: input.max_in_flight,
          duplicate_window_secs: input.duplicate_window_secs,
          allowed_categories: input.allowed_categories,
          allowed_destinations: input.allowed_destinations,
          allowed_counterparties: input.allowed_counterparties ?? null,
        },
        exposure: { today: '0.00', lifetime: '0.00', daily_remaining: input.daily_limit, lifetime_remaining: input.lifetime_limit, in_flight: 0, daily_resets_at: ahead(9 * 60 * MIN) },
        credentials: [],
      };
      state.mandates = [mandate, ...state.mandates];
      state.scenarios.set(mandate.id, []);
      state.x402.set(mandate.id, []);
      save();
      return mandate;
    },
    async revokeMandate(mandateId) {
      await pause();
      const mandate = find(mandateId);
      replace({
        ...mandate,
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        credentials: mandate.credentials.map((c) => ({ ...c, status: 'revoked' })),
      });
      save();
    },
    async issueCredential(mandateId, label) {
      await pause();
      const mandate = find(mandateId);
      const issued = credential(label, 'active', null, 0);
      replace({ ...mandate, credentials: [...mandate.credentials, issued] });
      save();
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b % 64]).join('').slice(0, 43);
      return { id: issued.id, public_id: issued.public_id, label, token: `mtr_agt_${issued.public_id}_${secret}` };
    },
    async revokeCredential(credentialId) {
      await pause();
      const mandate = state.mandates.find((m) => m.credentials.some((c) => c.id === credentialId));
      if (mandate === undefined) throw new ApiError('CREDENTIAL_NOT_FOUND', 'No such seal.');
      replace({ ...mandate, credentials: mandate.credentials.map((c) => (c.id === credentialId ? { ...c, status: 'revoked' } : c)) });
      save();
    },
    async purchases(mandateId) {
      await pause();
      return (state.scenarios.get(mandateId) ?? []).map((s) => s.purchase);
    },
    async timeline(purchaseId) {
      await pause();
      for (const scenarios of state.scenarios.values()) {
        const scenario = scenarios.find((s) => s.purchase.purchase_id === purchaseId);
        if (scenario !== undefined) return timelineFor(scenario);
      }
      throw new ApiError('PURCHASE_NOT_FOUND', 'No such deed.');
    },
    async x402Payments(mandateId) {
      await pause();
      return (state.x402.get(mandateId) ?? []).map((x) => x.payment);
    },
    async x402Timeline(paymentId) {
      await pause();
      for (const list of state.x402.values()) {
        const found = list.find((x) => x.payment.payment_id === paymentId);
        if (found !== undefined) return found.timeline;
      }
      throw new ApiError('PAYMENT_NOT_FOUND', 'No such payment.');
    },
  };
}
