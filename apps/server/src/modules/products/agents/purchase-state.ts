import type { DeliveryStatus } from '../../../platform/database/types.ts';

/** delivery_status → PRD §7.2 canonical state (agent-mandates §5.1). */
export const CANONICAL_STATE: Record<DeliveryStatus, string> = {
  declined: 'declined',
  pending_dispatch: 'authorized',
  dispatching: 'in_progress',
  awaiting_confirmation: 'in_progress',
  unresolved: 'in_progress',
  delivered: 'captured',
  rejected: 'failed',
  expired: 'expired',
};

const ALLOWED: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  pending_dispatch: ['dispatching', 'expired'],
  dispatching: ['delivered', 'rejected', 'awaiting_confirmation', 'pending_dispatch'],
  awaiting_confirmation: ['delivered', 'rejected', 'unresolved'],
  unresolved: ['delivered', 'rejected'],
  declined: [],
  delivered: [],
  rejected: [],
  expired: [],
};

export const ACTIVE_STATUSES = ['pending_dispatch', 'dispatching', 'awaiting_confirmation'] as const;

export function isTerminal(status: DeliveryStatus): boolean {
  return ALLOWED[status].length === 0;
}

/** Anything outside §5.1 is a programming error, not a runtime condition. */
export function assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!ALLOWED[from].includes(to)) throw new Error(`illegal purchase transition ${from} → ${to}`);
}
