import { normalizeAddress, recoverAddress } from '../evm/evm.ts';
import type { SimulatedChain } from '../chain/simulated-chain.ts';
import { authorizationDigest, type NetworkConfig, type PaymentPayload, type PaymentRequirements, sameAddress, type SettlementResponse, X402_VERSION } from './protocol.ts';

/** The seller side's facilitator (x402 v2 §/verify, /settle). Only the sandbox resource uses it. */
export interface VerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: string;
}

export interface FacilitatorPort {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse>;
}

export const FACILITATOR = Symbol('X402_FACILITATOR');

/** The spec's EIP-3009 verification steps, against the simulated chain. */
export class SimulatedFacilitator implements FacilitatorPort {
  constructor(
    private readonly chain: SimulatedChain,
    private readonly network: NetworkConfig,
  ) {}

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const a = payload.payload?.authorization;
    const fail = (invalidReason: string): VerifyResponse => ({ isValid: false, invalidReason, ...(a?.from === undefined ? {} : { payer: a.from }) });
    if (payload.x402Version !== X402_VERSION) return fail('invalid_x402_version');
    if (a === undefined || typeof payload.payload.signature !== 'string') return fail('invalid_payload');
    if (requirements.scheme !== 'exact' || payload.accepted?.scheme !== 'exact') return fail('unsupported_scheme');
    if (requirements.network !== this.network.network || payload.accepted.network !== requirements.network) return fail('invalid_network');
    if (!sameAddress(requirements.asset, this.network.usdc)) return fail('invalid_payment_requirements');
    try {
      const signer = recoverAddress(authorizationDigest(this.network, a), payload.payload.signature);
      if (normalizeAddress(signer) !== normalizeAddress(a.from)) return fail('invalid_exact_evm_payload_signature');
    } catch {
      return fail('invalid_exact_evm_payload_signature');
    }
    if (!sameAddress(a.to, requirements.payTo)) return fail('invalid_exact_evm_payload_recipient_mismatch');
    if (BigInt(a.value) !== BigInt(requirements.amount)) return fail('invalid_exact_evm_payload_authorization_value_mismatch');
    const now = this.chain.latestTimestamp();
    if (BigInt(a.validBefore) <= now + 6n) return fail('invalid_exact_evm_payload_authorization_valid_before');
    if (BigInt(a.validAfter) > now) return fail('invalid_exact_evm_payload_authorization_valid_after');
    const reason = this.chain.simulate(a, payload.payload.signature);
    if (reason === 'transfer amount exceeds balance') return fail('insufficient_funds');
    if (reason !== null) return fail('invalid_transaction_state');
    return { isValid: true, payer: a.from };
  }

  /** Submits and waits for inclusion, as a real facilitator waits for the receipt. */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse> {
    const a = payload.payload.authorization;
    const base = { network: requirements.network, payer: a.from };
    const verified = await this.verify(payload, requirements);
    if (!verified.isValid) return { ...base, success: false, errorReason: verified.invalidReason ?? 'invalid_payload', transaction: '' };
    const transaction = this.chain.submitTransferWithAuthorization(a, payload.payload.signature);
    this.chain.mine();
    const receipt = this.chain.receipt(transaction);
    return receipt?.status === 'success'
      ? { ...base, success: true, transaction, amount: a.value }
      : { ...base, success: false, errorReason: 'invalid_transaction_state', transaction };
  }
}

/** A real facilitator over HTTP (e.g. the public testnet one), for live mode. */
export class HttpFacilitator implements FacilitatorPort {
  constructor(private readonly baseUrl: string) {}

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.post('verify', payload, requirements);
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettlementResponse> {
    return this.post('settle', payload, requirements);
  }

  private async post<T>(path: string, paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements }),
      signal: AbortSignal.timeout(20_000),
    });
    return (await response.json()) as T;
  }
}
