import { addressWord, bytesToHex, concat, type Hex, hexToBytes, keccak256, normalizeAddress, selector } from '../evm/evm.ts';
import type { NetworkConfig } from '../x402/protocol.ts';
import type { AuthorizationUse, ChainPort, SafeView } from './chain.port.ts';

const AUTHORIZATION_USED = bytesToHex(keccak256('AuthorizationUsed(address,bytes32)'));
const TRANSFER = bytesToHex(keccak256('Transfer(address,address,uint256)'));
const AUTHORIZATION_STATE = selector('authorizationState(address,bytes32)');
const BALANCE_OF = selector('balanceOf(address)');

interface Log {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
}

/**
 * ChainPort over plain JSON-RPC (design §4.3, X-09). Every read is pinned to
 * the `safe` block tag. No client library: four calls, hand-encoded.
 */
export class RpcChain implements ChainPort {
  readonly network: string;
  private id = 0;

  constructor(
    private readonly config: NetworkConfig,
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    // ponytail: log scans look back a fixed window (~11h of Base blocks); page from a stored cursor if reconciliation must see further.
    private readonly lookbackBlocks = 20_000n,
  ) {
    this.network = config.network;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`rpc ${method} HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error !== undefined || body.result === undefined) throw new Error(`rpc ${method}: ${body.error?.message ?? 'no result'}`);
    return body.result;
  }

  private call(data: Uint8Array, block: string): Promise<Hex> {
    return this.rpc<Hex>('eth_call', [{ to: this.config.usdc, data: bytesToHex(data) }, block]);
  }

  async safeHead(): Promise<SafeView> {
    const block = await this.rpc<{ number: string; timestamp: string } | null>('eth_getBlockByNumber', ['safe', false]);
    if (block === null) throw new Error('rpc returned no safe block');
    return { blockNumber: BigInt(block.number), timestamp: BigInt(block.timestamp) };
  }

  async authorizationUse(authorizer: Hex, nonce: Hex): Promise<AuthorizationUse | null> {
    const state = await this.call(concat(AUTHORIZATION_STATE, addressWord(authorizer), hexToBytes(nonce)), 'safe');
    if (BigInt(state) === 0n) return null;
    // Used at the safe head: find where, and what actually moved.
    const safe = await this.safeHead();
    const logs = await this.usedLogs(authorizer, nonce, safe.blockNumber);
    const log = logs[0];
    if (log === undefined) throw new Error(`authorizationState is set but no AuthorizationUsed log for ${nonce} in the lookback window`);
    return this.evidence(log);
  }

  async authorizationUses(authorizer: Hex): Promise<AuthorizationUse[]> {
    const safe = await this.safeHead();
    const logs = await this.usedLogs(authorizer, null, safe.blockNumber);
    return Promise.all(logs.map((log) => this.evidence(log)));
  }

  async balanceOf(address: Hex): Promise<bigint> {
    return BigInt(await this.call(concat(BALANCE_OF, addressWord(address)), 'safe'));
  }

  private usedLogs(authorizer: Hex, nonce: Hex | null, safeBlock: bigint): Promise<Log[]> {
    const from = safeBlock > this.lookbackBlocks ? safeBlock - this.lookbackBlocks : 0n;
    return this.rpc<Log[]>('eth_getLogs', [{
      address: this.config.usdc,
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${safeBlock.toString(16)}`,
      topics: [AUTHORIZATION_USED, bytesToHex(addressWord(authorizer)), nonce],
    }]);
  }

  /** The Transfer in the same transaction is the evidence of recipient and value. */
  private async evidence(used: Log): Promise<AuthorizationUse> {
    const receipt = await this.rpc<{ logs: Log[] }>('eth_getTransactionReceipt', [used.transactionHash]);
    const authorizer = normalizeAddress(`0x${used.topics[1]!.slice(26)}`);
    const transfer = receipt.logs.find(
      (log) => normalizeAddress(log.address) === this.config.usdc && log.topics[0] === TRANSFER && normalizeAddress(`0x${log.topics[1]!.slice(26)}`) === authorizer,
    );
    if (transfer === undefined) throw new Error(`no USDC Transfer from the authorizer in ${used.transactionHash}`);
    return {
      nonce: used.topics[2]!.toLowerCase() as Hex,
      transaction: used.transactionHash as Hex,
      blockNumber: BigInt(used.blockNumber),
      to: normalizeAddress(`0x${transfer.topics[2]!.slice(26)}`),
      value: BigInt(transfer.data),
    };
  }
}
