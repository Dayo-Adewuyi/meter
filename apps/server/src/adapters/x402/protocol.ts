import { type Hex, normalizeAddress, typedDataDigest, type Types } from '../evm/evm.ts';

/**
 * x402 v2 wire types (specs/x402-specification-v2.md) and the HTTP transport's
 * base64-JSON header codec (specs/transports-v2/http.md).
 */
export const X402_VERSION = 2;
export const HEADERS = {
  required: 'payment-required',
  signature: 'payment-signature',
  response: 'payment-response',
} as const;

export interface ResourceInfo {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface PaymentRequirements {
  readonly scheme: string;
  readonly network: string;
  /** Atomic units of `asset`, as a decimal string. */
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra?: Record<string, unknown>;
}

export interface PaymentRequired {
  readonly x402Version: number;
  readonly error?: string;
  readonly resource: ResourceInfo;
  readonly accepts: readonly PaymentRequirements[];
  readonly extensions?: Record<string, unknown>;
}

export interface Authorization {
  readonly from: Hex;
  readonly to: Hex;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: Hex;
}

export interface PaymentPayload {
  readonly x402Version: number;
  readonly resource?: ResourceInfo;
  readonly accepted: PaymentRequirements;
  readonly payload: { readonly signature: Hex; readonly authorization: Authorization };
  readonly extensions?: Record<string, unknown>;
}

export interface SettlementResponse {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly payer?: string;
  readonly transaction: string;
  readonly network: string;
  readonly amount?: string;
}

export const encodeHeader = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

export function decodeHeader<T>(value: string): T {
  const text = Buffer.from(value.trim(), 'base64').toString('utf8');
  return JSON.parse(text) as T;
}

/** Networks Meter will pay on, keyed by CAIP-2 id. The asset must be that network's USDC. */
export interface NetworkConfig {
  readonly network: string;
  readonly chainId: bigint;
  readonly usdc: Hex;
  /** EIP-712 domain of the token contract; must match what the token itself uses. */
  readonly domainName: string;
  readonly domainVersion: string;
}

export const BASE_SEPOLIA: NetworkConfig = {
  network: 'eip155:84532',
  chainId: 84532n,
  usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  domainName: 'USDC',
  domainVersion: '2',
};

export const TRANSFER_WITH_AUTHORIZATION: Types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/** The EIP-712 digest a USDC contract checks in transferWithAuthorization. */
export function authorizationDigest(network: NetworkConfig, authorization: Authorization): Uint8Array {
  return typedDataDigest(
    { name: network.domainName, version: network.domainVersion, chainId: network.chainId, verifyingContract: network.usdc },
    TRANSFER_WITH_AUTHORIZATION,
    'TransferWithAuthorization',
    authorization as unknown as Record<string, unknown>,
  );
}

export const sameAddress = (a: string, b: string): boolean => {
  try {
    return normalizeAddress(a) === normalizeAddress(b);
  } catch {
    return false;
  }
};
