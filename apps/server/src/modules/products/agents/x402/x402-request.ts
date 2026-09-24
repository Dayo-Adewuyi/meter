import { ASSETS, toAtomic } from '@meter/contracts';
import { z } from 'zod';
import { normalizeAddress } from '../../../../adapters/evm/evm.ts';
import { decodeHeader, type NetworkConfig, type PaymentRequired, type PaymentRequirements, X402_VERSION } from '../../../../adapters/x402/protocol.ts';

export class X402RequestError extends Error {
  constructor(
    readonly code: 'X402_UNSUPPORTED' | 'X402_RESOURCE_MISMATCH' | 'X402_PRICE_ABOVE_MAX' | 'X402_MALFORMED',
    message: string,
  ) {
    super(message);
  }
}

const usdc = z.string().transform((value, ctx) => {
  try {
    const atomic = toAtomic(value, ASSETS.USDC);
    if (atomic > 0n) return atomic;
  } catch {
    // fall through
  }
  ctx.addIssue({ code: 'custom', message: 'must be a positive USDC amount with at most 6 decimals' });
  return 0n;
});

export const x402PaymentRequestSchema = z
  .object({
    /** The PAYMENT-REQUIRED header value exactly as the resource sent it. */
    payment_required: z.string().min(1).max(16_384),
    resource_url: z.url({ protocol: /^https?$/ }),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    intent: z.string().trim().min(1).max(280),
    max_amount: usdc.optional(),
    confirm_duplicate: z.boolean().default(false),
  })
  .strict();

export type X402PaymentRequest = z.output<typeof x402PaymentRequestSchema>;

export interface SelectedPayment {
  readonly required: PaymentRequired;
  readonly requirements: PaymentRequirements;
  readonly amount: bigint;
  readonly payTo: string;
  readonly origin: string;
  readonly timeoutSeconds: number;
}

/**
 * Design §4.1 steps 1–2: decode, pick the one offer Meter can pay, and bind it
 * to the request the agent is actually making. Nothing here is trusted: the
 * header is written by the seller.
 */
export function selectPayment(request: X402PaymentRequest, network: NetworkConfig, clamp: { min: number; max: number }): SelectedPayment {
  let required: PaymentRequired;
  try {
    required = decodeHeader<PaymentRequired>(request.payment_required);
  } catch {
    throw new X402RequestError('X402_MALFORMED', 'PAYMENT-REQUIRED is not base64 JSON.');
  }
  if (required?.x402Version !== X402_VERSION || !Array.isArray(required.accepts) || typeof required.resource?.url !== 'string') {
    throw new X402RequestError('X402_UNSUPPORTED', `Only x402 version ${X402_VERSION} is supported.`);
  }

  const requirements = required.accepts.find((offer) => {
    try {
      return (
        offer.scheme === 'exact' &&
        offer.network === network.network &&
        normalizeAddress(offer.asset) === network.usdc &&
        (offer.extra?.name === undefined || offer.extra.name === network.domainName) &&
        (offer.extra?.version === undefined || offer.extra.version === network.domainVersion)
      );
    } catch {
      return false;
    }
  });
  if (requirements === undefined) {
    throw new X402RequestError('X402_UNSUPPORTED', `No offer is payable: Meter pays "exact" USDC on ${network.network}.`);
  }

  let payTo: string;
  try {
    payTo = normalizeAddress(requirements.payTo);
  } catch {
    throw new X402RequestError('X402_MALFORMED', 'payTo is not an address.');
  }
  if (!/^\d{1,30}$/.test(requirements.amount) || BigInt(requirements.amount) <= 0n) {
    throw new X402RequestError('X402_MALFORMED', 'amount must be a positive integer of atomic units.');
  }
  const amount = BigInt(requirements.amount);

  // The seller names the resource; it must be the one the agent is calling.
  let declared: URL;
  const called = new URL(request.resource_url);
  try {
    declared = new URL(required.resource.url);
  } catch {
    throw new X402RequestError('X402_MALFORMED', 'resource.url is not a URL.');
  }
  if (declared.origin !== called.origin || declared.pathname !== called.pathname) {
    throw new X402RequestError('X402_RESOURCE_MISMATCH', `The seller asked payment for ${declared.origin}${declared.pathname}, not the resource being called.`);
  }
  if (request.max_amount !== undefined && amount > request.max_amount) {
    throw new X402RequestError('X402_PRICE_ABOVE_MAX', 'The price is above the maximum this call allows.');
  }

  const timeout = Number.isFinite(requirements.maxTimeoutSeconds) ? Math.floor(requirements.maxTimeoutSeconds) : clamp.max;
  return {
    required,
    requirements,
    amount,
    payTo,
    origin: called.origin,
    timeoutSeconds: Math.min(clamp.max, Math.max(clamp.min, timeout)),
  };
}
