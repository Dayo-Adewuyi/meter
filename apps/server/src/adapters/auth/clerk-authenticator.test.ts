import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from '../../modules/core/identity/authenticator.port.ts';
import { type ClerkBackend, ClerkAuthenticator } from './clerk-authenticator.ts';

function fakeClerk() {
  return {
    verifyToken: vi.fn(),
    users: { getUser: vi.fn() },
  } satisfies ClerkBackend as ClerkBackend & {
    verifyToken: ReturnType<typeof vi.fn>;
    users: { getUser: ReturnType<typeof vi.fn> };
  };
}

describe('clerk authenticator', () => {
  it('maps verification and user fetch to Meter-owned values', async () => {
    const clerk = fakeClerk();
    const adapter = new ClerkAuthenticator(clerk);
    clerk.verifyToken.mockResolvedValue({ sub: 'user_123', sid: 'sess_1' });
    clerk.users.getUser.mockResolvedValue({ id: 'user_123', banned: false, locked: false });

    await expect(adapter.verifyToken('token')).resolves.toEqual({
      provider: 'clerk',
      subject: 'user_123',
      sessionId: 'sess_1',
    });
    await expect(adapter.fetchUser('user_123')).resolves.toEqual({
      provider: 'clerk',
      subject: 'user_123',
      disabled: false,
    });
  });

  it('treats a session-less token as valid without inventing a session id', async () => {
    const clerk = fakeClerk();
    clerk.verifyToken.mockResolvedValue({ sub: 'user_123' });

    await expect(new ClerkAuthenticator(clerk).verifyToken('token')).resolves.toMatchObject({
      sessionId: null,
    });
  });

  it.each([
    ['a rejected token', () => Promise.reject(new Error('jwt expired'))],
    ['claims without a subject', () => Promise.resolve({ sid: 'sess_1' })],
    ['an empty subject', () => Promise.resolve({ sub: '' })],
  ])('denies %s with a safe error', async (_name, outcome) => {
    const clerk = fakeClerk();
    clerk.verifyToken.mockImplementation(outcome);

    await expect(new ClerkAuthenticator(clerk).verifyToken('token')).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('never leaks the provider error for a failed token verification', async () => {
    const clerk = fakeClerk();
    const sdkError = Object.assign(new Error('clerk internals: secret sk_live_abc'), { status: 401 });
    clerk.verifyToken.mockRejectedValue(sdkError);

    const error = await new ClerkAuthenticator(clerk).verifyToken('token').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toBe('INVALID_TOKEN');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it.each([
    ['banned', { id: 'user_123', banned: true, locked: false }],
    ['locked', { id: 'user_123', banned: false, locked: true }],
  ])('reports a %s user as disabled', async (_name, user) => {
    const clerk = fakeClerk();
    clerk.users.getUser.mockResolvedValue(user);

    await expect(new ClerkAuthenticator(clerk).fetchUser('user_123')).resolves.toMatchObject({
      disabled: true,
    });
  });

  it('maps a provider API failure to an unavailable error', async () => {
    const clerk = fakeClerk();
    clerk.users.getUser.mockRejectedValue(new Error('503 from clerk'));

    await expect(new ClerkAuthenticator(clerk).fetchUser('user_123')).rejects.toMatchObject({
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
  });
});
