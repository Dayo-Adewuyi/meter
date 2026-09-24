import { describe, expect, it } from 'vitest';
import { bytesToHex, keccak256 } from '../evm/evm.ts';
import { BASE_SEPOLIA } from '../x402/protocol.ts';
import { RpcChain } from './base-rpc-chain.ts';

const OMNIBUS = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const NONCE = bytesToHex(keccak256('nonce'));
const word = (hex: string) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;
const TX = `0x${'ab'.repeat(32)}`;

/** A recorded-fixture node: answers by method, records what was asked. */
function node(answers: Record<string, (params: any[]) => unknown>) {
  const calls: { method: string; params: any[] }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { method, params, id } = JSON.parse(String(init.body));
    calls.push({ method, params });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: answers[method]!(params) }));
  }) as unknown as typeof fetch;
  return { chain: new RpcChain(BASE_SEPOLIA, 'https://rpc.example', fetchImpl), calls };
}

describe('JSON-RPC chain adapter', () => {
  it('reads state at the safe tag and builds evidence from the Transfer log', async () => {
    const { chain, calls } = node({
      eth_call: ([call]) => (call.data.startsWith('0xe94a0102') ? word('1') : word('0f4240')),
      eth_getBlockByNumber: () => ({ number: '0x10', timestamp: '0x68d3c1e0' }),
      eth_getLogs: () => [{ address: BASE_SEPOLIA.usdc, topics: ['0x', word(OMNIBUS.slice(2)), NONCE], data: '0x', blockNumber: '0x0f', transactionHash: TX }],
      eth_getTransactionReceipt: () => ({
        logs: [
          {
            address: BASE_SEPOLIA.usdc,
            topics: [bytesToHex(keccak256('Transfer(address,address,uint256)')), word(OMNIBUS.slice(2)), word(SELLER.slice(2))],
            data: word('0186a0'),
            blockNumber: '0x0f',
            transactionHash: TX,
          },
        ],
      }),
    });

    await expect(chain.authorizationUse(OMNIBUS, NONCE)).resolves.toEqual({ nonce: NONCE, transaction: TX, blockNumber: 15n, to: SELLER, value: 100_000n });
    await expect(chain.balanceOf(OMNIBUS)).resolves.toBe(1_000_000n);
    const state = calls.find((c) => c.method === 'eth_call')!;
    expect(state.params[1]).toBe('safe');
    expect(state.params[0].data).toBe(`0xe94a0102${word(OMNIBUS.slice(2)).slice(2)}${NONCE.slice(2)}`);
    expect(calls.find((c) => c.method === 'eth_getLogs')!.params[0].toBlock).toBe('0x10');
  });

  it('reports an unused nonce without scanning logs', async () => {
    const { chain, calls } = node({ eth_call: () => word('0') });
    await expect(chain.authorizationUse(OMNIBUS, NONCE)).resolves.toBeNull();
    expect(calls.map((c) => c.method)).toEqual(['eth_call']);
  });
});
