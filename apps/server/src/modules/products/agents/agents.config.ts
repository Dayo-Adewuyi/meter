/** Timing knobs (agent-mandates §5.4, §5.5). Sandbox compresses them for the demo. */
export interface AgentsConfig {
  readonly holdTtlMs: number;
  readonly requeryDelaysMs: readonly number[];
  readonly notFoundGraceMs: number;
  readonly resolveDeadlineMs: number;
  readonly leaseMs: number;
  readonly maxSendAttempts: number;
  readonly notSentRetryMs: number;
}

export const AGENTS_CONFIG = Symbol('AGENTS_CONFIG');

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

export const PRODUCTION_AGENTS_CONFIG: AgentsConfig = {
  holdTtlMs: 10 * MINUTE,
  requeryDelaysMs: [15 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 30 * MINUTE],
  notFoundGraceMs: 5 * MINUTE,
  resolveDeadlineMs: 24 * 60 * MINUTE,
  leaseMs: 30 * SECOND,
  maxSendAttempts: 3,
  notSentRetryMs: 2 * SECOND,
};

export const SANDBOX_AGENTS_CONFIG: AgentsConfig = {
  holdTtlMs: 30 * SECOND,
  requeryDelaysMs: [2 * SECOND, 4 * SECOND, 8 * SECOND, 15 * SECOND],
  notFoundGraceMs: 10 * SECOND,
  resolveDeadlineMs: 60 * SECOND,
  leaseMs: 30 * SECOND,
  maxSendAttempts: 3,
  notSentRetryMs: 1 * SECOND,
};

/** The last delay repeats once the schedule runs out. */
export function requeryDelay(config: AgentsConfig, attempt: number): number {
  const delays = config.requeryDelaysMs;
  return delays[Math.min(attempt, delays.length - 1)]!;
}
