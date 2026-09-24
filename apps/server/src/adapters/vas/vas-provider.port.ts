/**
 * Value-added-services provider port (agent-mandates §9.1). No provider type
 * leaves `adapters/vas`: the finalizer sees only these four-way outcomes.
 */
export interface AirtimeRequest {
  /** The purchase id. Providers that honor request ids dedupe on it. */
  readonly requestId: string;
  readonly network: 'mtn' | 'airtel' | 'glo' | '9mobile';
  /** E.164, e.g. +2348030000000. */
  readonly destination: string;
  readonly amountAtomic: bigint;
  readonly correlationId: string;
}

export type VasRejectCode =
  | 'INVALID_NUMBER'
  | 'PRODUCT_UNAVAILABLE'
  | 'PROVIDER_BALANCE_INSUFFICIENT'
  | 'NEVER_RECEIVED'
  | 'PROVIDER_UNREACHABLE';

export interface DeliveryEvidence {
  readonly providerStatus: string;
  readonly deliveredAt?: string;
}

/**
 * The adapter must never turn ambiguity into a definite answer (§5.2):
 * releasing on a guess refunds value that may still be delivered; capturing on
 * a guess charges for value that may never arrive. Only holding is safe.
 */
export type SendOutcome =
  | { kind: 'delivered'; providerReference: string; evidence: DeliveryEvidence }
  | { kind: 'rejected'; code: VasRejectCode; providerReference?: string }
  | { kind: 'not_sent'; reason: string }
  | { kind: 'unknown'; reason: string; providerReference?: string };

export type RequeryOutcome =
  | { kind: 'delivered'; providerReference: string; evidence: DeliveryEvidence }
  | { kind: 'rejected'; code: VasRejectCode }
  | { kind: 'pending' }
  | { kind: 'not_found' }
  | { kind: 'unknown'; reason: string };

export interface VasProvider {
  readonly name: string;
  /** Never retried inside the adapter: only the finalizer knows whether a retry is safe. */
  sendAirtime(request: AirtimeRequest): Promise<SendOutcome>;
  /**
   * Looks the request up by `request.requestId`. Takes the whole request, not
   * just the id, so a stateless adapter (or a restarted simulator) can answer.
   */
  requery(request: AirtimeRequest): Promise<RequeryOutcome>;
}

export const VAS_PROVIDER = Symbol('VAS_PROVIDER');
