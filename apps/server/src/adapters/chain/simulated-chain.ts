import { randomBytes } from 'node:crypto';
import { bytesToHex, type Hex, normalizeAddress, recoverAddress } from '../evm/evm.ts';
import { type Authorization, authorizationDigest, type NetworkConfig } from '../x402/protocol.ts';
import type { AuthorizationUse, ChainPort, SafeView } from './chain.port.ts';

type Tx =
  | { readonly kind: 'mint'; readonly hash: Hex; readonly to: Hex; readonly value: bigint }
  | { readonly kind: 'transferWithAuthorization'; readonly hash: Hex; readonly authorization: Authorization; readonly signature: Hex };

interface Receipt {
  readonly hash: Hex;
  readonly status: 'success' | 'reverted';
  readonly reason?: string;
}

interface Block {
  readonly number: bigint;
  readonly timestamp: bigint;
  readonly txs: readonly Tx[];
}

interface State {
  readonly balances: Map<Hex, bigint>;
  readonly uses: Map<string, AuthorizationUse>;
  readonly receipts: Map<Hex, Receipt & { blockNumber: bigint }>;
}

const key = (authorizer: string, nonce: string) => `${normalizeAddress(authorizer)}:${nonce.toLowerCase()}`;

/**
 * An in-process EIP-3009 USDC token on a toy chain (design §7). Transactions
 * wait in a mempool and execute only when a block is mined, against that
 * block's timestamp, exactly like the real contract: bad signatures, reused
 * nonces, windows and balances revert. `safeLag` blocks separate the tip from
 * the safe head, and `reorg` drops blocks, so finality can be tested.
 */
export class SimulatedChain implements ChainPort {
  readonly network: string;
  private blocks: Block[];
  private mempool: Tx[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly config: NetworkConfig,
    private readonly clock: () => number = Date.now,
    readonly safeLag = 2,
  ) {
    this.network = config.network;
    this.blocks = [{ number: 0n, timestamp: BigInt(Math.floor(clock() / 1000)), txs: [] }];
  }

  // ─── Writes (tests, the sandbox facilitator, sandbox funding) ───

  mint(to: string, value: bigint): Hex {
    const hash = bytesToHex(randomBytes(32));
    this.mempool.push({ kind: 'mint', hash, to: normalizeAddress(to), value });
    return hash;
  }

  submitTransferWithAuthorization(authorization: Authorization, signature: Hex): Hex {
    const hash = bytesToHex(randomBytes(32));
    this.mempool.push({ kind: 'transferWithAuthorization', hash, authorization, signature });
    return hash;
  }

  /** Includes the mempool in a new block. Timestamps strictly increase. */
  mine(): Block {
    const previous = this.blocks.at(-1)!;
    const now = BigInt(Math.floor(this.clock() / 1000));
    const block: Block = { number: previous.number + 1n, timestamp: now > previous.timestamp ? now : previous.timestamp + 1n, txs: this.mempool };
    this.mempool = [];
    this.blocks.push(block);
    return block;
  }

  /** Mines `n` empty blocks, e.g. to move a block past the safe head. */
  mineMany(n: number): void {
    for (let i = 0; i < n; i++) this.mine();
  }

  /** Drops the newest `depth` blocks; their transactions are gone, as after a reorg. */
  reorg(depth: number): void {
    this.blocks = this.blocks.slice(0, Math.max(1, this.blocks.length - depth));
  }

  /** Background block production for the running sandbox (Base: ~2 s blocks). */
  start(intervalMs = 2_000): void {
    this.timer ??= setInterval(() => this.mine(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // ─── Reads at the tip (the facilitator's view) ───

  latestTimestamp(): bigint {
    return this.blocks.at(-1)!.timestamp;
  }

  balanceAtTip(address: string): bigint {
    return this.stateAt(this.blocks.length - 1).balances.get(normalizeAddress(address)) ?? 0n;
  }

  nonceUsedAtTip(authorizer: string, nonce: string): boolean {
    return this.stateAt(this.blocks.length - 1).uses.has(key(authorizer, nonce));
  }

  receipt(hash: Hex): (Receipt & { blockNumber: bigint }) | null {
    return this.stateAt(this.blocks.length - 1).receipts.get(hash) ?? null;
  }

  /** The contract's own checks, against `timestamp` and a state, with no side effects. */
  check(state: State, timestamp: bigint, authorization: Authorization, signature: Hex): string | null {
    let signer: Hex;
    try {
      signer = recoverAddress(authorizationDigest(this.config, authorization), signature);
    } catch {
      return 'invalid signature';
    }
    if (normalizeAddress(signer) !== normalizeAddress(authorization.from)) return 'invalid signature';
    if (timestamp <= BigInt(authorization.validAfter)) return 'authorization is not yet valid';
    if (timestamp >= BigInt(authorization.validBefore)) return 'authorization is expired';
    if (state.uses.has(key(authorization.from, authorization.nonce))) return 'authorization is used or canceled';
    if ((state.balances.get(normalizeAddress(authorization.from)) ?? 0n) < BigInt(authorization.value)) return 'transfer amount exceeds balance';
    return null;
  }

  /** Would this authorization succeed in the next block? (facilitator /verify) */
  simulate(authorization: Authorization, signature: Hex): string | null {
    return this.check(this.stateAt(this.blocks.length - 1), this.latestTimestamp() + 1n, authorization, signature);
  }

  // ─── ChainPort (reads at the safe head) ───

  private safeIndex(): number {
    return Math.max(0, this.blocks.length - 1 - this.safeLag);
  }

  async safeHead(): Promise<SafeView> {
    const block = this.blocks[this.safeIndex()]!;
    return { blockNumber: block.number, timestamp: block.timestamp };
  }

  async authorizationUse(authorizer: Hex, nonce: Hex): Promise<AuthorizationUse | null> {
    return this.stateAt(this.safeIndex()).uses.get(key(authorizer, nonce)) ?? null;
  }

  async authorizationUses(authorizer: Hex): Promise<AuthorizationUse[]> {
    const prefix = `${normalizeAddress(authorizer)}:`;
    return [...this.stateAt(this.safeIndex()).uses].filter(([k]) => k.startsWith(prefix)).map(([, use]) => use);
  }

  async balanceOf(address: Hex): Promise<bigint> {
    return this.stateAt(this.safeIndex()).balances.get(normalizeAddress(address)) ?? 0n;
  }

  // ponytail: replays from genesis on every read; fine for a sandbox chain of thousands of blocks.
  private stateAt(index: number): State {
    const state: State = { balances: new Map(), uses: new Map(), receipts: new Map() };
    for (const block of this.blocks.slice(0, index + 1)) {
      for (const tx of block.txs) {
        if (tx.kind === 'mint') {
          state.balances.set(tx.to, (state.balances.get(tx.to) ?? 0n) + tx.value);
          state.receipts.set(tx.hash, { hash: tx.hash, status: 'success', blockNumber: block.number });
          continue;
        }
        const { authorization: a, signature } = tx;
        const reason = this.check(state, block.timestamp, a, signature);
        if (reason !== null) {
          state.receipts.set(tx.hash, { hash: tx.hash, status: 'reverted', reason, blockNumber: block.number });
          continue;
        }
        const from = normalizeAddress(a.from);
        const to = normalizeAddress(a.to);
        const value = BigInt(a.value);
        state.balances.set(from, state.balances.get(from)! - value);
        state.balances.set(to, (state.balances.get(to) ?? 0n) + value);
        state.uses.set(key(from, a.nonce), { nonce: a.nonce.toLowerCase() as Hex, transaction: tx.hash, blockNumber: block.number, to, value });
        state.receipts.set(tx.hash, { hash: tx.hash, status: 'success', blockNumber: block.number });
      }
    }
    return state;
  }
}
