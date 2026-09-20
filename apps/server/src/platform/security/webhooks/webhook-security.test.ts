import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEventClaim, WebhookEventsRepository } from './webhook-events.repository.ts';
import { WebhookSecurityService } from './webhook-security.service.ts';
import { WebhookVerificationGuard } from './webhook-verification.guard.ts';
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

describe('webhook verification guard', () => {
  let guard: WebhookVerificationGuard;
  let verifier: WebhookVerifier;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SIGNED_AT);
    verifier = verifierFor();
    guard = new WebhookVerificationGuard(new WebhookSecurityService(inMemoryRepository()), {
      provider: 'clerk',
      verifier,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const contextFor = (body: string | undefined) => {
    const request: Record<string, unknown> = {
      rawBody: body === undefined ? undefined : Buffer.from(body),
      headers: {},
    };
    return {
      request,
      context: { switchToHttp: () => ({ getRequest: () => request }) } as never,
    };
  };

  it('freezes the verified envelope on the request and admits it', async () => {
    const { context, request } = contextFor('{"ok":true}');

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.verifiedWebhook).toEqual({
      provider: 'clerk',
      eventId: 'evt_1',
      signedAt: SIGNED_AT,
      outcome: 'accepted',
    });
    expect(Object.isFrozen(request.verifiedWebhook)).toBe(true);
  });

  it('admits an identical replay so the handler can acknowledge it', async () => {
    await guard.canActivate(contextFor('{"ok":true}').context);
    const replay = contextFor('{"ok":true}');

    await expect(guard.canActivate(replay.context)).resolves.toBe(true);
    expect((replay.request.verifiedWebhook as { outcome: string }).outcome).toBe('duplicate');
  });

  it.each([
    ['a missing raw body', undefined, 400, 'WEBHOOK_BODY_MISSING'],
    ['a reused event id', '{"ok":false}', 409, 'WEBHOOK_EVENT_CONFLICT'],
  ])('turns %s into a real status rather than hanging', async (_name, body, status, code) => {
    if (body !== undefined) await guard.canActivate(contextFor('{"ok":true}').context);
    const { context, request } = contextFor(body);

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect((error as { getStatus: () => number }).getStatus()).toBe(status);
    expect((error as { getResponse: () => unknown }).getResponse()).toEqual({ code });
    expect(request.verifiedWebhook).toBeUndefined();
  });

  it('rejects a stale signature with 401', async () => {
    vi.setSystemTime(new Date('2026-09-20T12:05:01Z'));
    const { context } = contextFor('{}');

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect((error as { getStatus: () => number }).getStatus()).toBe(401);
    expect((error as { getResponse: () => unknown }).getResponse()).toEqual({
      code: 'WEBHOOK_TIMESTAMP_EXPIRED',
    });
  });
});
