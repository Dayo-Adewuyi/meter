import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withMigratedDb } from '../../../test/support/database.ts';
import { PostgresWebhookEventsRepository } from './webhook-events.repository.ts';
import { WebhookSecurityService } from './webhook-security.service.ts';
import type { WebhookVerifier } from './webhook-verifier.port.ts';

const digest = (body: string) => createHash('sha256').update(Buffer.from(body)).digest('hex');

function verifier(eventId: string, signedAt: Date): WebhookVerifier {
  return { verify: async () => ({ eventId, signedAt }) };
}

describe('webhook replay protection', () => {
  it('claims an event once and stores the provider timestamp and digest', async () => {
    await withMigratedDb(async (db) => {
      const signedAt = new Date();
      const service = new WebhookSecurityService(new PostgresWebhookEventsRepository(db));
      const input = (body: string) => ({
        provider: 'clerk',
        verifier: verifier('evt_pg_1', signedAt),
        rawBody: Buffer.from(body),
        headers: {},
      });

      await expect(service.verifyAndClaim(input('{"ok":true}'))).resolves.toBe('accepted');
      await expect(service.verifyAndClaim(input('{"ok":true}'))).resolves.toBe('duplicate');
      await expect(service.verifyAndClaim(input('{"ok":false}'))).rejects.toMatchObject({
        code: 'WEBHOOK_EVENT_CONFLICT',
      });

      const rows = await db
        .selectFrom('operations.external_events')
        .selectAll()
        .where('provider', '=', 'clerk')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        external_id: 'evt_pg_1',
        payload_digest: digest('{"ok":true}'),
        status: 'verified',
      });
      expect(rows[0]?.provider_event_at.toISOString()).toBe(signedAt.toISOString());
    });
  }, 60_000);

  it('lets only one of several concurrent deliveries claim the event', async () => {
    await withMigratedDb(async (db) => {
      const service = new WebhookSecurityService(new PostgresWebhookEventsRepository(db));
      const input = () => ({
        provider: 'clerk',
        verifier: verifier('evt_pg_2', new Date()),
        rawBody: Buffer.from('{"ok":true}'),
        headers: {},
      });

      const outcomes = await Promise.all(Array.from({ length: 8 }, () => service.verifyAndClaim(input())));

      expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(7);
    });
  }, 60_000);

  it('rejects a status outside the processing lifecycle', async () => {
    await withMigratedDb(async (db) => {
      await expect(
        db
          .insertInto('operations.external_events')
          .values({
            provider: 'clerk',
            external_id: 'evt_pg_3',
            payload_digest: digest('{}'),
            provider_event_at: new Date(),
            // Deliberately invalid: the check constraint must reject it.
            status: 'mystery' as never,
          })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    });
  }, 60_000);
});
