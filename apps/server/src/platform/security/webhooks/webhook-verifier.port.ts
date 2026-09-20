/**
 * Provider-neutral webhook verification contract (§15.1).
 *
 * Provider SDK types stay inside `adapters`; only these Meter-owned values cross
 * into the platform.
 */
export interface VerifiedWebhookEnvelope {
  readonly eventId: string;
  readonly signedAt: Date;
}

export interface WebhookVerifier {
  verify(input: {
    rawBody: Buffer;
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }): Promise<VerifiedWebhookEnvelope>;
}

export type WebhookSecurityCode =
  | 'WEBHOOK_BODY_MISSING'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'WEBHOOK_TIMESTAMP_EXPIRED'
  | 'WEBHOOK_EVENT_CONFLICT';

export class WebhookSecurityError extends Error {
  constructor(readonly code: WebhookSecurityCode) {
    super(code);
    this.name = 'WebhookSecurityError';
  }
}
