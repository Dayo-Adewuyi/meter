import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * The few EVM primitives x402 needs (design §8): keccak, EIP-55 addresses,
 * EIP-712 typed-data hashing, recoverable signatures and ABI words. Hand-written
 * over audited @noble primitives instead of a full EVM toolkit.
 */

export type Hex = `0x${string}`;

export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) throw new Error(`not hex: ${hex}`);
  return Uint8Array.from(Buffer.from(body, 'hex'));
}

export const bytesToHex = (bytes: Uint8Array): Hex => `0x${Buffer.from(bytes).toString('hex')}`;

export const keccak256 = (data: Uint8Array | string): Uint8Array =>
  keccak_256(typeof data === 'string' ? new TextEncoder().encode(data) : data);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A 32-byte big-endian ABI word. */
export function word(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new RangeError('uint256 out of range');
  return hexToBytes(value.toString(16).padStart(64, '0'));
}

export function addressWord(address: string): Uint8Array {
  return concat(new Uint8Array(12), hexToBytes(normalizeAddress(address)));
}

/** Lower-cased, validated 20-byte address. Checksum is verified when mixed-case. */
export function normalizeAddress(address: string): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an address: ${address}`);
  const lower = address.toLowerCase() as Hex;
  if (address !== lower && address !== address.slice(0, 2) + address.slice(2).toUpperCase() && checksumAddress(lower) !== address) {
    throw new Error(`bad address checksum: ${address}`);
  }
  return lower;
}

/** EIP-55 mixed-case checksum. */
export function checksumAddress(address: string): Hex {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak256(lower)).toString('hex');
  return `0x${Array.from(lower, (c, i) => (parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c)).join('')}`;
}

export function addressOf(privateKey: Uint8Array): Hex {
  const publicKey = secp256k1.getPublicKey(privateKey, false).slice(1);
  return checksumAddress(bytesToHex(keccak256(publicKey).slice(12)));
}

// ─── EIP-712 ───────────────────────────────────────────────────────────────

export interface TypedField {
  readonly name: string;
  readonly type: string;
}
export type Types = Record<string, readonly TypedField[]>;

/** Struct types referenced by `primary`, primary first, the rest sorted (EIP-712 encodeType). */
function dependencies(types: Types, primary: string, found = new Set<string>()): string[] {
  if (found.has(primary) || types[primary] === undefined) return [];
  found.add(primary);
  for (const field of types[primary]) dependencies(types, field.type, found);
  return [...found];
}

export function encodeType(types: Types, primary: string): string {
  const [head, ...rest] = dependencies(types, primary);
  return [head!, ...rest.sort()]
    .map((name) => `${name}(${types[name]!.map((f) => `${f.type} ${f.name}`).join(',')})`)
    .join('');
}

export const typeHash = (types: Types, primary: string) => keccak256(encodeType(types, primary));

function encodeValue(types: Types, type: string, value: unknown): Uint8Array {
  if (types[type] !== undefined) return hashStruct(types, type, value as Record<string, unknown>);
  if (type === 'string') return keccak256(String(value));
  if (type === 'bytes') return keccak256(hexToBytes(String(value)));
  if (type === 'address') return addressWord(String(value));
  if (type === 'bool') return word(value ? 1n : 0n);
  if (/^uint\d+$/.test(type)) return word(BigInt(value as bigint | string | number));
  if (/^bytes32$/.test(type)) {
    const bytes = hexToBytes(String(value));
    if (bytes.length !== 32) throw new Error('bytes32 must be 32 bytes');
    return bytes;
  }
  // ponytail: no arrays, intN or bytesN<32; add when a signed type needs them.
  throw new Error(`unsupported EIP-712 type ${type}`);
}

export function hashStruct(types: Types, primary: string, data: Record<string, unknown>): Uint8Array {
  return keccak256(concat(typeHash(types, primary), ...types[primary]!.map((f) => encodeValue(types, f.type, data[f.name]))));
}

export interface Domain {
  readonly name?: string;
  readonly version?: string;
  readonly chainId?: bigint;
  readonly verifyingContract?: string;
}

export function domainSeparator(domain: Domain): Uint8Array {
  const fields: TypedField[] = [
    ...(domain.name === undefined ? [] : [{ name: 'name', type: 'string' }]),
    ...(domain.version === undefined ? [] : [{ name: 'version', type: 'string' }]),
    ...(domain.chainId === undefined ? [] : [{ name: 'chainId', type: 'uint256' }]),
    ...(domain.verifyingContract === undefined ? [] : [{ name: 'verifyingContract', type: 'address' }]),
  ];
  return hashStruct({ EIP712Domain: fields }, 'EIP712Domain', domain as Record<string, unknown>);
}

/** keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(message)). */
export function typedDataDigest(domain: Domain, types: Types, primary: string, message: Record<string, unknown>): Uint8Array {
  return keccak256(concat(new Uint8Array([0x19, 0x01]), domainSeparator(domain), hashStruct(types, primary, message)));
}

// ─── Signatures ────────────────────────────────────────────────────────────

/** 65-byte r ‖ s ‖ v with v ∈ {27, 28}, low-s, deterministic k (RFC 6979). */
export function signDigest(digest: Uint8Array, privateKey: Uint8Array): Hex {
  const recovered = secp256k1.sign(digest, privateKey, { prehash: false, format: 'recovered', lowS: true });
  return bytesToHex(concat(recovered.slice(1, 65), new Uint8Array([27 + recovered[0]!])));
}

export function recoverAddress(digest: Uint8Array, signature: string): Hex {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 65) throw new Error('signature must be 65 bytes');
  const v = bytes[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error('bad recovery id');
  const publicKey = secp256k1.recoverPublicKey(concat(new Uint8Array([recovery]), bytes.slice(0, 64)), digest, { prehash: false });
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false).slice(1);
  return checksumAddress(bytesToHex(keccak256(uncompressed).slice(12)));
}

/** The first four bytes of keccak256(signature), e.g. "balanceOf(address)". */
export const selector = (signature: string): Uint8Array => keccak256(signature).slice(0, 4);
