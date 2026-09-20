import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEventClaim, WebhookEventsRepository } from './webhook-events.repository.ts';
import { WebhookSecurityService } from './webhook-security.service.ts';
import { WebhookVerificationMiddleware } from './webhook-verification.middleware.ts';
import type { WebhookVerifier } from './webhook-verifier.port.ts';

/** Same claim semantics as PostgreSQL, without the round trip. */
function inMemoryRepository(): WebhookEventsRepository {
  const seen = new Map<string, string>();
  return {
    async claim(claim: WebhookEventClaim) {
      const key = `${claim.provider}:${claim.eventId}`;
      const existing = seen.get(key);
      if (existing === undefined) {
        seen.set(key, claim.payloadDigest);
        return 'accepted';
      }
      return existing === claim.payloadDigest ? 'duplicate' : 'conflict';
    },
  };
}

const SIGNED_AT = new Date('2026-09-20T12:00:00Z');

function verifierFor(eventId = 'evt_1'): WebhookVerifier {
  return { verify: vi.fn(async () => ({ eventId, signedAt: SIGNED_AT })) };
}

describe('webhook security service', () => {
  let service: WebhookSecurityService;
  let verifier: WebhookVerifier;

  const input = (body: string) => ({
    provider: 'clerk',
    verifier,
    rawBody: Buffer.from(body),
    headers: {},
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SIGNED_AT);
    verifier = verifierFor();
    service = new WebhookSecurityService(inMemoryRepository());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts one event, acknowledges an identical replay, and rejects ID reuse', async () => {
    await expect(service.verifyAndClaim(input('{"ok":true}'))).resolves.toBe('accepted');
    await expect(service.verifyAndClaim(input('{"ok":true}'))).resolves.toBe('duplicate');
    await expect(service.verifyAndClaim(input('{"ok":false}'))).rejects.toMatchObject({
      code: 'WEBHOOK_EVENT_CONFLICT',
    });
  });

  it('rejects a valid signature outside the five-minute replay window', async () => {
    vi.setSystemTime(new Date('2026-09-20T12:05:01Z'));
    await expect(service.verifyAndClaim(input('{}'))).rejects.toMatchObject({
      code: 'WEBHOOK_TIMESTAMP_EXPIRED',
    });
  });

  it('rejects a signature dated too far in the future', async () => {
    vi.setSystemTime(new Date('2026-09-20T11:54:59Z'));
    await expect(service.verifyAndClaim(input('{}'))).rejects.toMatchObject({
      code: 'WEBHOOK_TIMESTAMP_EXPIRED',
    });
  });

  it('refuses to persist anything when the raw body never reached the handler', async () => {
    await expect(
      service.verifyAndClaim({ provider: 'clerk', verifier, rawBody: undefined, headers: {} }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_BODY_MISSING' });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('digests the exact bytes rather than a parsed body', async () => {
    await expect(service.verifyAndClaim(input('{"a":1,"b":2}'))).resolves.toBe('accepted');
    verifier = verifierFor('evt_1');
    await expect(service.verifyAndClaim(input('{"b":2,"a":1}'))).rejects.toMatchObject({
      code: 'WEBHOOK_EVENT_CONFLICT',
    });
  });
});

describe('webhook verification middleware', () => {
  let middleware: WebhookVerificationMiddleware;
  let verifier: WebhookVerifier;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SIGNED_AT);
    verifier = verifierFor();
    middleware = new WebhookVerificationMiddleware(new WebhookSecurityService(inMemoryRepository()), {
      provider: 'clerk',
      verifier,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const request = (body: string | undefined) =>
    ({ rawBody: body === undefined ? undefined : Buffer.from(body), headers: {} }) as never;

  it('freezes the verified envelope on the request and continues', async () => {
    const next = vi.fn();
    const target = request('{"ok":true}');

    await middleware.use(target, {} as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    const verified = (target as { verifiedWebhook?: unknown }).verifiedWebhook;
    expect(verified).toEqual({ provider: 'clerk', eventId: 'evt_1', signedAt: SIGNED_AT, outcome: 'accepted' });
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it('continues on an identical replay so the handler can acknowledge it', async () => {
    const next = vi.fn();
    await middleware.use(request('{"ok":true}'), {} as never, next);
    const replay = request('{"ok":true}');

    await middleware.use(replay, {} as never, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect((replay as { verifiedWebhook?: { outcome: string } }).verifiedWebhook?.outcome).toBe('duplicate');
  });

  it('propagates rejection without calling next', async () => {
    const next = vi.fn();

    await expect(middleware.use(request(undefined), {} as never, next)).rejects.toMatchObject({
      code: 'WEBHOOK_BODY_MISSING',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
