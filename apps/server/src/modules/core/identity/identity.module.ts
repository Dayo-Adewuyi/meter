import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { env } from '@meter/config';
import { ClerkAuthenticator, clerkBackend } from '../../../adapters/auth/clerk-authenticator.ts';
import { AuthGuard } from './auth.guard.ts';
import { AUTHENTICATOR } from './authenticator.port.ts';
import { IDENTITY_REPOSITORY } from './identity.repository.ts';
import { PostgresIdentityRepository } from './postgres-identity.repository.ts';

/**
 * Composition root: the one place that knows Clerk is the provider. Tests
 * override `AUTHENTICATOR` and `IDENTITY_REPOSITORY`.
 */
@Module({
  providers: [
    {
      provide: AUTHENTICATOR,
      useFactory: () => new ClerkAuthenticator(clerkBackend(env.CLERK_SECRET_KEY ?? '', env.CLERK_JWT_KEY)),
    },
    { provide: IDENTITY_REPOSITORY, useClass: PostgresIdentityRepository },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AUTHENTICATOR, IDENTITY_REPOSITORY],
})
export class IdentityModule {}
