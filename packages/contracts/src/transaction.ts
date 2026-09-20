/**
 * The canonical transaction model (PRD §7). One model for every vertical:
 * Meter AI, Agents, Providers, Content, Sessions, Physical. A vertical supplies
 * the unit being metered and the delivery evidence; it does not get its own
 * states, its own money path, or its own idea of what "captured" means.
 */

/** §7.2 normal progression. Order is the progression. */
export const TRANSACTION_FLOW = [
  'quoted',
  'authorized',
  'in_progress',
  'captured',
  'settlement_pending',
  'settled',
] as const;

/** §7.2 exceptional terminal states. */
export const TERMINAL_STATES = [
  'declined',
  'expired',
  'failed',
  'partially_captured',
  'reversed',
  'refunded',
  'disputed',
] as const;

export type TransactionState = (typeof TRANSACTION_FLOW)[number] | (typeof TERMINAL_STATES)[number];

/** States in which value has actually been taken from the buyer. */
const CAPTURED: ReadonlySet<TransactionState> = new Set([
  'captured',
  'settlement_pending',
  'settled',
  'partially_captured',
]);

/** Exceptional exits that are only meaningful once value was captured (§10.2). */
const REQUIRES_CAPTURE: ReadonlySet<TransactionState> = new Set([
  'partially_captured',
  'reversed',
  'refunded',
  'disputed',
]);

export function isTerminal(state: TransactionState): boolean {
  return (TERMINAL_STATES as readonly TransactionState[]).includes(state) || state === 'settled';
}

/**
 * ponytail: the PRD fixes the normal chain and the terminal set, not the full
 * edge list. This encodes the two rules that protect money — no movement out of a
 * terminal state, and no refund-shaped exit before capture — and leaves the
 * finer per-flow edges to the module that owns the flow.
 */
export function canTransition(from: TransactionState, to: TransactionState): boolean {
  if (from === to || isTerminal(from)) return false;

  const next = TRANSACTION_FLOW.indexOf(from as (typeof TRANSACTION_FLOW)[number]);
  if (TRANSACTION_FLOW[next + 1] === to) return true;

  if (!(TERMINAL_STATES as readonly TransactionState[]).includes(to)) return false;
  return REQUIRES_CAPTURE.has(to) ? CAPTURED.has(from) : true;
}

/**
 * §7.3. What a vertical meters differs; how much must be reserved does not.
 * Everything but `fixed` reserves a maximum and releases the unused remainder.
 */
export const PRICING_PRIMITIVES = ['fixed', 'measured', 'time_based', 'composite'] as const;
export type PricingPrimitive = (typeof PRICING_PRIMITIVES)[number];

export function reservesMaximum(primitive: PricingPrimitive): boolean {
  return primitive !== 'fixed';
}

/** §5 vertical products. Stage 1 ships `ai`; the rest are gated on exit criteria. */
export const PRODUCTS = ['ai', 'agents', 'providers', 'content', 'sessions', 'physical'] as const;
export type Product = (typeof PRODUCTS)[number];
