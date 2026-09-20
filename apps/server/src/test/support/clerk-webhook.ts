import { createHmac, randomUUID } from 'node:crypto';

export const TEST_SIGNING_SECRET = `whsec_${Buffer.from('meter-test-signing-key').toString('base64')}`;

/**
 * Signs exactly the way Standard Webhooks (and therefore Clerk) does:
 * base64 HMAC-SHA256 over `id.timestampSeconds.payload`.
 */
export function signWebhook(
  payload: string,
  options: { secret?: string; eventId?: string; signedAt?: Date } = {},
): { headers: Record<string, string>; rawBody: Buffer } {
  const secret = options.secret ?? TEST_SIGNING_SECRET;
  const eventId = options.eventId ?? `msg_${randomUUID()}`;
  const seconds = Math.floor((options.signedAt ?? new Date()).getTime() / 1000);
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${eventId}.${seconds}.${payload}`).digest('base64');

  return {
    rawBody: Buffer.from(payload),
    headers: {
      'content-type': 'application/json',
      'svix-id': eventId,
      'svix-timestamp': String(seconds),
      'svix-signature': `v1,${signature}`,
    },
  };
}

export const userEvent = (type: string, data: Record<string, unknown>): string =>
  JSON.stringify({ type, object: 'event', data });
