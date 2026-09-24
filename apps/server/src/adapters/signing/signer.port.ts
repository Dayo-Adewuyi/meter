import { addressOf, type Hex, hexToBytes, keccak256, signDigest } from '../evm/evm.ts';

/**
 * Signs EIP-712 digests for the omnibus wallet (x402 design §3.1). The only
 * holder of key material; production swaps this for a KMS/HSM signer.
 */
export interface SignerPort {
  readonly address: Hex;
  sign(digest: Uint8Array): Hex;
}

export const SIGNER = Symbol('X402_SIGNER');

export class LocalKeySigner implements SignerPort {
  readonly address: Hex;
  readonly #key: Uint8Array;

  constructor(privateKeyHex: string) {
    this.#key = hexToBytes(privateKeyHex);
    if (this.#key.length !== 32) throw new Error('signer key must be 32 bytes');
    this.address = addressOf(this.#key);
  }

  sign(digest: Uint8Array): Hex {
    return signDigest(digest, this.#key);
  }
}

// ponytail: a fixed, public sandbox key for the simulated chain only; boot refuses it off-sandbox.
export const SANDBOX_SIGNER_KEY = `0x${Buffer.from(keccak256('meter.sandbox.x402.omnibus')).toString('hex')}`;
