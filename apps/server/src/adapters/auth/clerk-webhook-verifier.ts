import { verifyWebhook } from '@clerk/backend/webhooks';
import type { ExternalUserEvent } from '../../modules/core/identity/external-user-event.ts';
import {
  type VerifiedWebhookEnvelope,
  WebhookSecurityError,
  type WebhookVerifier,
} from '../../platform/security/webhooks/webhook-verifier.port.ts';

/** Clerk signs with Standard Webhooks and sends these headers. */
const EVENT_ID_HEADER = 'svix-id';
const TIMESTAMP_HEADER = 'svix-timestamp';

function toHeaders(source: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  return headers;
}

/**
 * The only Clerk-specific webhook code. It hands back Meter-owned values, so
 * the shared replay-claim policy stays provider-neutral (§15.1).
 */
export class ClerkWebhookVerifier implements WebhookVerifier {
  constructor(private readonly signingSecret: string | undefined) {}

  async verify(input: {
    rawBody: Buffer;
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }): Promise<VerifiedWebhookEnvelope> {
    // No secret configured means no request can be trusted — deny, rather than
    // failing open or crashing the whole app at boot.
    if (this.signingSecret === undefined || this.signingSecret.length === 0) {
      throw new WebhookSecurityError('WEBHOOK_SIGNATURE_INVALID');
    }

    const headers = toHeaders(input.headers);
    try {
      await verifyWebhook(
        new Request('https://meter.internal/webhooks/clerk', {
          method: 'POST',
          headers,
          body: input.rawBody,
        }),
        { signingSecret: this.signingSecret },
      );
    } catch {
      // The provider's message can echo signature material; never forward it.
      throw new WebhookSecurityError('WEBHOOK_SIGNATURE_INVALID');
    }

    const eventId = headers.get(EVENT_ID_HEADER)?.trim();
    const timestamp = Number(headers.get(TIMESTAMP_HEADER)?.trim());
    if (eventId === undefined || eventId.length === 0 || !Number.isFinite(timestamp)) {
      throw new WebhookSecurityError('WEBHOOK_SIGNATURE_INVALID');
    }
    return { eventId, signedAt: new Date(timestamp * 1000) };
  }
}

const EVENT_KINDS: Readonly<Record<string, ExternalUserEvent['kind']>> = {
  'user.created': 'created',
  'user.updated': 'updated',
  'user.deleted': 'deleted',
};

/**
 * Translates a Clerk event body into Meter's own shape. Returns null for
 * anything this system does not act on, so an unknown event is acknowledged
 * rather than retried forever.
 */
export function toExternalUserEvent(body: unknown): ExternalUserEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const { type, data } = body as { type?: unknown; data?: unknown };
  if (typeof type !== 'string') return null;

  const kind = EVENT_KINDS[type];
  if (kind === undefined) return null;
  if (typeof data !== 'object' || data === null) return null;

  const { id, banned, locked } = data as { id?: unknown; banned?: unknown; locked?: unknown };
  if (typeof id !== 'string' || id.length === 0) return null;

  return { kind, provider: 'clerk', subject: id, disabled: banned === true || locked === true };
}
