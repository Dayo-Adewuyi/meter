import type { UserRole } from '../../../platform/database/types.ts';

/**
 * The only identity the application sees (§15.2). No provider subject, session
 * or token ever reaches a handler: financial keys are Meter's own UUIDs.
 */
export interface MeterPrincipal {
  readonly userId: string;
  readonly roles: readonly UserRole[];
  readonly restrictionState: 'unrestricted' | 'restricted';
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: MeterPrincipal;
  }
}
