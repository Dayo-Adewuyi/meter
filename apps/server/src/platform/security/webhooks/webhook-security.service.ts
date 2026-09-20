import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  WEBHOOK_EVENTS_REPOSITORY,
  type WebhookEventsRepository,
} from './webhook-events.repository.ts';
import {
  type VerifiedWebhookEnvelope,
  WebhookSecurityError,
  type WebhookVerifier,
} from './webhook-verifier.port.ts';

/** Signatures stay valid for five minutes either side of now (§15.1). */
const REPLAY_WINDOW_MS = 300_000;

export interface WebhookSecurityInput {
  readonly provider: string;
  readonly verifier: WebhookVerifier;
  readonly rawBody: Buffer | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface WebhookAuthorization {
  readonly outcome: 'accepted' | 'duplicate';
  readonly envelope: VerifiedWebhookEnvelope;
}

@Injectable()
export class WebhookSecurityService {
  constructor(
    @Inject(WEBHOOK_EVENTS_REPOSITORY) private readonly events: WebhookEventsRepository,
  ) {}

  async verifyAndClaim(input: WebhookSecurityInput): Promise<'accepted' | 'duplicate'> {
    return (await this.authorize(input)).outcome;
  }

  /** Same policy as `verifyAndClaim`, keeping the envelope for the middleware. */
  async authorize(input: WebhookSecurityInput): Promise<WebhookAuthorization> {
    const { rawBody } = input;
    // A parsed body cannot be re-serialized to the signed bytes.
    if (rawBody === undefined || rawBody.length === 0) {
      throw new WebhookSecurityError('WEBHOOK_BODY_MISSING');
    }

    const envelope = await input.verifier.verify({ rawBody, headers: input.headers });
    if (Math.abs(Date.now() - envelope.signedAt.getTime()) > REPLAY_WINDOW_MS) {
      throw new WebhookSecurityError('WEBHOOK_TIMESTAMP_EXPIRED');
    }

    const outcome = await this.events.claim({
      provider: input.provider,
      eventId: envelope.eventId,
      payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
      providerEventAt: envelope.signedAt,
    });
    if (outcome === 'conflict') throw new WebhookSecurityError('WEBHOOK_EVENT_CONFLICT');

    return { outcome, envelope };
  }
}
