import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import {
  AUTHENTICATOR,
  AuthenticationError,
  type AuthenticatorPort,
} from './authenticator.port.ts';
import { IDENTITY_REPOSITORY, type IdentityRepository } from './identity.repository.ts';
import { PUBLIC_ROUTE } from './public-route.ts';

export type AuthDenialCode = 'UNAUTHENTICATED' | 'INVALID_TOKEN' | 'IDENTITY_NOT_FOUND';

export class AuthDeniedError extends UnauthorizedException {
  constructor(readonly code: AuthDenialCode) {
    super({ code });
  }
}

export class AuthProviderUnavailableError extends ServiceUnavailableException {
  readonly code = 'AUTH_PROVIDER_UNAVAILABLE';

  constructor() {
    super({ code: 'AUTH_PROVIDER_UNAVAILABLE' });
  }
}

/** Exactly one case-insensitive Bearer scheme with a non-empty token. */
function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  return /^bearer (\S+)$/i.exec(header.trim())?.[1] ?? null;
}

/**
 * Registered as `APP_GUARD`, so every route is authenticated unless it is
 * annotated `@Public()` (§15.2). Deny by default is the point: a new controller
 * is protected before anyone remembers to protect it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: AuthenticatorPort,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: IdentityRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = bearerToken(request.headers.authorization);
    if (token === null) throw new AuthDeniedError('UNAUTHENTICATED');

    let external;
    try {
      external = await this.authenticator.verifyToken(token);
    } catch (error) {
      if (error instanceof AuthenticationError && error.code === 'AUTH_PROVIDER_UNAVAILABLE') {
        // Never fail open: an outage denies rather than admits.
        throw new AuthProviderUnavailableError();
      }
      throw new AuthDeniedError('INVALID_TOKEN');
    }

    const principal = await this.identities.findPrincipal(external.provider, external.subject);
    if (principal === null) throw new AuthDeniedError('IDENTITY_NOT_FOUND');

    request.principal = Object.freeze(principal);
    return true;
  }
}
