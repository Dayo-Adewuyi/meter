import type { MeterPrincipal } from './principal.ts';

export interface IdentityRepository {
  /** Null means "no usable principal" — unknown subject or a non-active user. */
  findPrincipal(provider: string, subject: string): Promise<MeterPrincipal | null>;
}

export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');
