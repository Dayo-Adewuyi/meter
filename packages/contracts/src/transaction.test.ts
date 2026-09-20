import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isTerminal,
  reservesMaximum,
  TERMINAL_STATES,
  TRANSACTION_FLOW,
  type TransactionState,
} from './transaction.ts';

describe('canonical transaction model', () => {
  it('walks the normal flow end to end', () => {
    for (let i = 0; i < TRANSACTION_FLOW.length - 1; i++) {
      expect(canTransition(TRANSACTION_FLOW[i]!, TRANSACTION_FLOW[i + 1]!)).toBe(true);
    }
  });

  it('never skips a step or runs backwards', () => {
    expect(canTransition('quoted', 'captured')).toBe(false);
    expect(canTransition('authorized', 'settled')).toBe(false);
    expect(canTransition('captured', 'authorized')).toBe(false);
  });

  it('lets nothing leave a terminal state', () => {
    const every: TransactionState[] = [...TRANSACTION_FLOW, ...TERMINAL_STATES];
    for (const from of every.filter(isTerminal)) {
      for (const to of every) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('refuses refund-shaped exits before anything was captured', () => {
    for (const from of ['quoted', 'authorized', 'in_progress'] as const) {
      for (const to of ['refunded', 'reversed', 'disputed', 'partially_captured'] as const) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
    expect(canTransition('captured', 'refunded')).toBe(true);
    expect(canTransition('settled', 'refunded')).toBe(false); // settled is terminal
  });

  it('allows decline, expiry and failure before capture', () => {
    expect(canTransition('quoted', 'expired')).toBe(true);
    expect(canTransition('authorized', 'declined')).toBe(true);
    expect(canTransition('in_progress', 'failed')).toBe(true);
  });

  it('reserves a maximum for every primitive except fixed (§7.3)', () => {
    expect(reservesMaximum('fixed')).toBe(false);
    for (const p of ['measured', 'time_based', 'composite'] as const) {
      expect(reservesMaximum(p)).toBe(true);
    }
  });
});
