import { BASE_SEPOLIA, type NetworkConfig } from '../../../../adapters/x402/protocol.ts';

/** Knobs for x402 payments (design §4). Sandbox compresses the waits. */
export interface X402Config {
  readonly network: NetworkConfig;
  /** maxTimeoutSeconds from the seller is clamped into this window. */
  readonly minTimeoutSeconds: number;
  readonly maxTimeoutSeconds: number;
  /** validAfter is backdated by this much to absorb clock skew. */
  readonly skewSeconds: number;
  /** How often a signed payment is checked against the chain. */
  readonly pollMs: number;
  /** After validBefore, how long an unreadable chain is tolerated before `unresolved`. */
  readonly resolveGraceMs: number;
  readonly leaseMs: number;
}

export const X402_CONFIG = Symbol('X402_CONFIG');

export const SANDBOX_X402_CONFIG: X402Config = {
  network: BASE_SEPOLIA,
  minTimeoutSeconds: 30,
  maxTimeoutSeconds: 300,
  skewSeconds: 60,
  pollMs: 2_000,
  resolveGraceMs: 60_000,
  leaseMs: 30_000,
};

export const PRODUCTION_X402_CONFIG: X402Config = { ...SANDBOX_X402_CONFIG, pollMs: 5_000, resolveGraceMs: 60 * 60_000 };
