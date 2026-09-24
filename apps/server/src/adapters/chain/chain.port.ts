import type { Hex } from '../evm/evm.ts';

/** What Meter reads from a chain to finalize x402 payments (design §4.3). */
export interface SafeView {
  readonly blockNumber: bigint;
  /** Chain time of the safe head, seconds. The only clock that decides a lapse. */
  readonly timestamp: bigint;
}

export interface AuthorizationUse {
  readonly nonce: Hex;
  readonly transaction: Hex;
  readonly blockNumber: bigint;
  /** From the Transfer log in the same transaction. */
  readonly to: Hex;
  readonly value: bigint;
}

export interface ChainPort {
  readonly network: string;
  safeHead(): Promise<SafeView>;
  /** The use of (authorizer, nonce) at or below the safe head, if any. */
  authorizationUse(authorizer: Hex, nonce: Hex): Promise<AuthorizationUse | null>;
  /** Every nonce of `authorizer` used at or below the safe head, for reconciliation. */
  authorizationUses(authorizer: Hex): Promise<AuthorizationUse[]>;
  /** USDC balance at the safe head, atomic units. */
  balanceOf(address: Hex): Promise<bigint>;
}

export const CHAIN = Symbol('X402_CHAIN');
