import { Inject, Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module.ts';
import type { DB } from '../../database/types.ts';

export interface WebhookEventClaim {
  readonly provider: string;
  readonly eventId: string;
  readonly payloadDigest: string;
  readonly providerEventAt: Date;
}

/** `duplicate` is the same bytes arriving twice; `conflict` is event-ID reuse. */
export type WebhookClaimOutcome = 'accepted' | 'duplicate' | 'conflict';

export interface WebhookEventsRepository {
  claim(claim: WebhookEventClaim): Promise<WebhookClaimOutcome>;
}

export const WEBHOOK_EVENTS_REPOSITORY = Symbol('WEBHOOK_EVENTS_REPOSITORY');

@Injectable()
export class PostgresWebhookEventsRepository implements WebhookEventsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async claim(claim: WebhookEventClaim): Promise<WebhookClaimOutcome> {
    const inserted = await this.db
      .insertInto('operations.external_events')
      .values({
        provider: claim.provider,
        external_id: claim.eventId,
        payload_digest: claim.payloadDigest,
        provider_event_at: claim.providerEventAt,
      })
      .onConflict((conflict) => conflict.columns(['provider', 'external_id']).doNothing())
      .returning('external_id')
      .executeTakeFirst();
    if (inserted !== undefined) return 'accepted';

    const existing = await this.db
      .selectFrom('operations.external_events')
      .select('payload_digest')
      .where('provider', '=', claim.provider)
      .where('external_id', '=', claim.eventId)
      .executeTakeFirstOrThrow();
    return existing.payload_digest === claim.payloadDigest ? 'duplicate' : 'conflict';
  }
}
