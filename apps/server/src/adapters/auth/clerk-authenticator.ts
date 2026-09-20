import { createClerkClient, verifyToken } from '@clerk/backend';
import {
  AuthenticationError,
  type AuthenticatorPort,
  type ExternalPrincipal,
  type ExternalUser,
} from '../../modules/core/identity/authenticator.port.ts';

/** The only Clerk surface Meter uses, narrowed so tests can supply a fake. */
export interface ClerkBackend {
  verifyToken(token: string): Promise<{ sub?: string | null; sid?: string | null }>;
  users: { getUser(userId: string): Promise<{ id: string; banned?: boolean; locked?: boolean }> };
}

export function clerkBackend(secretKey: string, jwtKey?: string): ClerkBackend {
  const keys = { secretKey, ...(jwtKey === undefined ? {} : { jwtKey }) };
  const client = createClerkClient(keys);
  return {
    verifyToken: (token) => verifyToken(token, keys),
    users: { getUser: (userId) => client.users.getUser(userId) },
  };
}

export class ClerkAuthenticator implements AuthenticatorPort {
  constructor(private readonly clerk: ClerkBackend) {}

  async verifyToken(token: string): Promise<ExternalPrincipal> {
    let claims: { sub?: string | null; sid?: string | null };
    try {
      claims = await this.clerk.verifyToken(token);
    } catch {
      // Malformed, expired, or wrong-key tokens are all one safe denial: the
      // provider's message can carry key material and is never forwarded.
      throw new AuthenticationError('INVALID_TOKEN');
    }

    if (typeof claims?.sub !== 'string' || claims.sub.length === 0) {
      throw new AuthenticationError('INVALID_TOKEN');
    }
    return {
      provider: 'clerk',
      subject: claims.sub,
      sessionId: typeof claims.sid === 'string' && claims.sid.length > 0 ? claims.sid : null,
    };
  }

  async fetchUser(subject: string): Promise<ExternalUser> {
    try {
      const user = await this.clerk.users.getUser(subject);
      return {
        provider: 'clerk',
        subject: user.id,
        disabled: user.banned === true || user.locked === true,
      };
    } catch {
      throw new AuthenticationError('AUTH_PROVIDER_UNAVAILABLE');
    }
  }
}
