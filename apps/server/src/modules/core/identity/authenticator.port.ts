/**
 * Meter-owned authentication contract (§15.2). Clerk types never cross this
 * boundary: swapping providers replaces one adapter, not the identity module.
 */
export interface ExternalPrincipal {
  readonly provider: 'clerk';
  readonly subject: string;
  readonly sessionId: string | null;
}

export interface ExternalUser {
  readonly provider: 'clerk';
  readonly subject: string;
  readonly disabled: boolean;
}

export interface AuthenticatorPort {
  verifyToken(token: string): Promise<ExternalPrincipal>;
  fetchUser(subject: string): Promise<ExternalUser>;
}

export const AUTHENTICATOR = Symbol('AUTHENTICATOR');

export class AuthenticationError extends Error {
  constructor(readonly code: 'INVALID_TOKEN' | 'AUTH_PROVIDER_UNAVAILABLE') {
    super(code);
    this.name = 'AuthenticationError';
  }
}
