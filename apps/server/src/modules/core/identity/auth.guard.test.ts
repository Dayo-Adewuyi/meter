import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from './auth.guard.ts';
import {
  AuthenticationError,
  type AuthenticatorPort,
  type ExternalPrincipal,
} from './authenticator.port.ts';
import type { IdentityRepository } from './identity.repository.ts';
import type { MeterPrincipal } from './principal.ts';
import { PUBLIC_ROUTE } from './public-route.ts';

const INTERNAL_USER_ID = '0199a1b2-c3d4-7000-8000-00000000abcd';

const PRINCIPAL: MeterPrincipal = {
  userId: INTERNAL_USER_ID,
  roles: ['customer'],
  restrictionState: 'unrestricted',
};

function contextWith(authorization: string | undefined, isPublic = false) {
  const request: Record<string, unknown> = { headers: { authorization } };
  const handler = () => undefined;
  if (isPublic) Reflect.defineMetadata(PUBLIC_ROUTE, true, handler);
  return {
    request,
    context: {
      getHandler: () => handler,
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}

function guardWith(overrides: {
  authenticator?: Partial<AuthenticatorPort>;
  identities?: Partial<IdentityRepository>;
} = {}) {
  const authenticator: AuthenticatorPort = {
    verifyToken: async (): Promise<ExternalPrincipal> => ({
      provider: 'clerk',
      subject: 'user_123',
      sessionId: 'sess_1',
    }),
    fetchUser: async () => ({ provider: 'clerk', subject: 'user_123', disabled: false }),
    ...overrides.authenticator,
  };
  const identities: IdentityRepository = {
    findPrincipal: async () => PRINCIPAL,
    ...overrides.identities,
  };
  return new AuthGuard(new Reflector(), authenticator, identities);
}

describe('auth guard', () => {
  it.each([
    ['missing header', undefined, 'UNAUTHENTICATED'],
    ['non-bearer header', 'Basic abc', 'UNAUTHENTICATED'],
    ['empty bearer token', 'Bearer ', 'UNAUTHENTICATED'],
    ['two bearer tokens', 'Bearer a b', 'UNAUTHENTICATED'],
  ])('denies %s', async (_name, authorization, code) => {
    const { context } = contextWith(authorization as string | undefined);
    await expect(guardWith().canActivate(context)).rejects.toMatchObject({ code });
  });

  it('denies an unknown subject', async () => {
    const { context } = contextWith('Bearer valid');
    const guard = guardWith({ identities: { findPrincipal: async () => null } });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });

  it('accepts a lowercase scheme, because HTTP schemes are case-insensitive', async () => {
    const { context, request } = contextWith('bearer valid');

    await expect(guardWith().canActivate(context)).resolves.toBe(true);
    expect(request.principal).toEqual(PRINCIPAL);
  });

  it('attaches only the Meter principal', async () => {
    const { context, request } = contextWith('Bearer valid');

    await expect(guardWith().canActivate(context)).resolves.toBe(true);
    expect(request.principal).toEqual({
      userId: INTERNAL_USER_ID,
      roles: ['customer'],
      restrictionState: 'unrestricted',
    });
    expect(request.principal).not.toHaveProperty('clerk');
    expect(request.principal).not.toHaveProperty('subject');
    expect(Object.isFrozen(request.principal)).toBe(true);
  });

  it('bypasses only routes annotated public, without looking up an identity', async () => {
    const findPrincipal = vi.fn();
    const { context, request } = contextWith(undefined, true);

    await expect(guardWith({ identities: { findPrincipal } }).canActivate(context)).resolves.toBe(true);
    expect(findPrincipal).not.toHaveBeenCalled();
    expect(request.principal).toBeUndefined();
  });

  it('denies a token the provider rejects', async () => {
    const { context } = contextWith('Bearer bad');
    const guard = guardWith({
      authenticator: {
        verifyToken: async () => {
          throw new AuthenticationError('INVALID_TOKEN');
        },
      },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('reports a provider outage as unavailable rather than letting the request through', async () => {
    const { context } = contextWith('Bearer valid');
    const guard = guardWith({
      authenticator: {
        verifyToken: async () => {
          throw new AuthenticationError('AUTH_PROVIDER_UNAVAILABLE');
        },
      },
    });

    const error = await guard.canActivate(context).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
    expect((error as { getStatus: () => number }).getStatus()).toBe(503);
  });

  it('never treats a repository failure as an unrestricted principal', async () => {
    const { context, request } = contextWith('Bearer valid');
    const guard = guardWith({
      identities: {
        findPrincipal: async () => {
          throw new Error('connection terminated');
        },
      },
    });

    await expect(guard.canActivate(context)).rejects.toThrow('connection terminated');
    expect(request.principal).toBeUndefined();
  });
});
