import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { env } from '@meter/config';
import { ClerkAuthenticator, clerkBackend } from '../../../adapters/auth/clerk-authenticator.ts';
import { ClerkWebhookVerifier } from '../../../adapters/auth/clerk-webhook-verifier.ts';
import { WebhookSecurityModule } from '../../../platform/security/webhooks/webhook-security.module.ts';
import {
  WEBHOOK_ROUTE_CONFIG,
  WebhookVerificationGuard,
} from '../../../platform/security/webhooks/webhook-verification.guard.ts';
import { AuthGuard } from './auth.guard.ts';
import { AUTHENTICATOR } from './authenticator.port.ts';
import { IDENTITY_REPOSITORY } from './identity.repository.ts';
import { IdentityWebhookController } from './identity-webhook.controller.ts';
import { PostgresIdentityRepository } from './postgres-identity.repository.ts';
import { UserProvisioningService } from './user-provisioning.service.ts';

/**
 * Composition root: the one place that knows Clerk is the provider. Tests
 * override `AUTHENTICATOR` and `IDENTITY_REPOSITORY`.
 */
@Module({
  imports: [WebhookSecurityModule],
  controllers: [IdentityWebhookController],
  providers: [
    {
      provide: AUTHENTICATOR,
      useFactory: () => new ClerkAuthenticator(clerkBackend(env.CLERK_SECRET_KEY ?? '', env.CLERK_JWT_KEY)),
    },
    { provide: IDENTITY_REPOSITORY, useClass: PostgresIdentityRepository },
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: WEBHOOK_ROUTE_CONFIG,
      useFactory: () => ({
        provider: 'clerk',
        verifier: new ClerkWebhookVerifier(env.CLERK_WEBHOOK_SECRET),
      }),
    },
    WebhookVerificationGuard,
    UserProvisioningService,
  ],
  exports: [AUTHENTICATOR, IDENTITY_REPOSITORY, UserProvisioningService],
})
export class IdentityModule {}
