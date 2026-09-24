import { describe, expect, it } from 'vitest';
import { bytesToHex, type Hex, keccak256 } from '../evm/evm.ts';
import { LocalKeySigner } from '../signing/signer.port.ts';
import { type Authorization, authorizationDigest, BASE_SEPOLIA } from '../x402/protocol.ts';
import { SimulatedChain } from './simulated-chain.ts';

const payer = new LocalKeySigner(bytesToHex(keccak256('payer')));
const other = new LocalKeySigner(bytesToHex(keccak256('other')));
const SELLER = '0x00000000000000000000000000000000000000aa' as Hex;

function setup() {
  let now = 1_800_000_000_000;
  const chain = new SimulatedChain(BASE_SEPOLIA, () => now, 2);
  chain.mint(payer.address, 1_000_000n);
  chain.mine();
  const t = Number(chain.latestTimestamp());
  const auth = (overrides: Partial<Authorization> = {}): Authorization => ({
    from: payer.address,
    to: SELLER,
    value: '100000',
    validAfter: String(t - 60),
    validBefore: String(t + 120),
    nonce: bytesToHex(keccak256(`n${Math.random()}`)),
    ...overrides,
  });
  const sign = (a: Authorization, signer = payer) => signer.sign(authorizationDigest(BASE_SEPOLIA, a));
  return { chain, auth, sign, advance: (seconds: number) => (now += seconds * 1000) };
}

describe('simulated EIP-3009 chain', () => {
  it('executes a valid authorization once, visible at the safe head only after the lag', async () => {
    const { chain, auth, sign } = setup();
    const a = auth();
    const tx = chain.submitTransferWithAuthorization(a, sign(a));
    chain.mine();

    expect(chain.receipt(tx)?.status).toBe('success');
    expect(chain.nonceUsedAtTip(payer.address, a.nonce)).toBe(true);
    await expect(chain.authorizationUse(payer.address, a.nonce)).resolves.toBeNull();
    chain.mineMany(2);
    await expect(chain.authorizationUse(payer.address, a.nonce)).resolves.toMatchObject({ transaction: tx, value: 100_000n, to: SELLER });
    await expect(chain.balanceOf(SELLER)).resolves.toBe(100_000n);

    const replay = chain.submitTransferWithAuthorization(a, sign(a));
    chain.mine();
    expect(chain.receipt(replay)).toMatchObject({ status: 'reverted', reason: 'authorization is used or canceled' });
  });

  it('reverts wrong signers, expired windows and overdrafts', () => {
    const { chain, auth, sign, advance } = setup();
    const forged = auth();
    const late = auth();
    const big = auth({ value: '5000000' });
    const txs = [
      chain.submitTransferWithAuthorization(forged, sign(forged, other)),
      chain.submitTransferWithAuthorization(big, sign(big)),
    ];
    chain.mine();
    advance(200);
    const lateTx = chain.submitTransferWithAuthorization(late, sign(late));
    chain.mine();
    expect(txs.map((t) => chain.receipt(t)?.reason)).toEqual(['invalid signature', 'transfer amount exceeds balance']);
    expect(chain.receipt(lateTx)?.reason).toBe('authorization is expired');
    expect(chain.balanceAtTip(payer.address)).toBe(1_000_000n);
  });

  it('forgets a use that a reorg removes before it reached the safe head', async () => {
    const { chain, auth, sign } = setup();
    const a = auth();
    chain.submitTransferWithAuthorization(a, sign(a));
    chain.mine();
    chain.reorg(1);
    chain.mineMany(3);
    await expect(chain.authorizationUse(payer.address, a.nonce)).resolves.toBeNull();
    expect(chain.balanceAtTip(payer.address)).toBe(1_000_000n);
  });
});
