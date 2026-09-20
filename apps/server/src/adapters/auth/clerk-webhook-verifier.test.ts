import { describe, expect, it } from 'vitest';
import { TEST_SIGNING_SECRET, signWebhook, userEvent } from '../../test/support/clerk-webhook.ts';
import { ClerkWebhookVerifier, toExternalUserEvent } from './clerk-webhook-verifier.ts';

const verifier = new ClerkWebhookVerifier(TEST_SIGNING_SECRET);
const body = userEvent('user.created', { id: 'user_123' });

describe('clerk webhook verifier', () => {
  it('accepts a genuine signature and reports the provider event id and time', async () => {
    const signedAt = new Date();
    const { headers, rawBody } = signWebhook(body, { eventId: 'msg_abc', signedAt });

    const envelope = await verifier.verify({ rawBody, headers });

    expect(envelope.eventId).toBe('msg_abc');
    expect(Math.floor(envelope.signedAt.getTime() / 1000)).toBe(Math.floor(signedAt.getTime() / 1000));
  });

  it('rejects a payload altered after signing', async () => {
    const { headers } = signWebhook(body);

    await expect(
      verifier.verify({ rawBody: Buffer.from(userEvent('user.created', { id: 'user_evil' })), headers }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
  });

  it('rejects a signature made with a different secret', async () => {
    const other = `whsec_${Buffer.from('a-different-key').toString('base64')}`;
    const { headers, rawBody } = signWebhook(body, { secret: other });

    await expect(verifier.verify({ rawBody, headers })).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
  });

  it.each(['svix-id', 'svix-timestamp', 'svix-signature'])('rejects a missing %s header', async (drop) => {
    const { headers, rawBody } = signWebhook(body);
    const { [drop]: _removed, ...rest } = headers;

    await expect(verifier.verify({ rawBody, headers: rest })).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
  });

  it('denies every request when no signing secret is configured', async () => {
    const { headers, rawBody } = signWebhook(body);

    for (const secret of [undefined, '']) {
      await expect(new ClerkWebhookVerifier(secret).verify({ rawBody, headers })).rejects.toMatchObject({
        code: 'WEBHOOK_SIGNATURE_INVALID',
      });
    }
  });
});

describe('clerk event mapping', () => {
  it.each([
    ['user.created', 'created'],
    ['user.updated', 'updated'],
    ['user.deleted', 'deleted'],
  ])('maps %s', (type, kind) => {
    expect(toExternalUserEvent({ type, data: { id: 'user_123' } })).toEqual({
      kind,
      provider: 'clerk',
      subject: 'user_123',
      disabled: false,
    });
  });

  it.each([
    ['banned', { id: 'user_123', banned: true }],
    ['locked', { id: 'user_123', locked: true }],
  ])('treats a %s user as disabled', (_name, data) => {
    expect(toExternalUserEvent({ type: 'user.updated', data })).toMatchObject({ disabled: true });
  });

  it.each([
    ['an unhandled event type', { type: 'session.created', data: { id: 'sess_1' } }],
    ['a missing subject', { type: 'user.created', data: {} }],
    ['a non-string subject', { type: 'user.created', data: { id: 42 } }],
    ['a missing data object', { type: 'user.created' }],
    ['a non-object body', 'nope'],
    ['null', null],
  ])('ignores %s rather than guessing', (_name, input) => {
    expect(toExternalUserEvent(input)).toBeNull();
  });
});
