import { Body, Controller, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { toExternalUserEvent } from '../../../adapters/auth/clerk-webhook-verifier.ts';
import { WebhookVerificationGuard } from '../../../platform/security/webhooks/webhook-verification.guard.ts';
import { Public } from './public-route.ts';
import type { ProvisioningOutcome } from './external-user-event.ts';
import { UserProvisioningService } from './user-provisioning.service.ts';

@Controller('webhooks/clerk')
@UseGuards(WebhookVerificationGuard)
export class IdentityWebhookController {
  constructor(private readonly provisioning: UserProvisioningService) {}

  /**
   * Public because a webhook carries a signature, not a bearer token. The
   * signature was checked by `WebhookVerificationGuard` over the exact raw
   * bytes before this ran.
   */
  @Public()
  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<{ status: ProvisioningOutcome | 'ignored' }> {
    // Refuse to act on an unverified body even if the middleware were ever
    // unwired: this route must never be a way to create users without a
    // signature.
    if (request.verifiedWebhook?.provider !== 'clerk') {
      throw new UnauthorizedException({ code: 'WEBHOOK_NOT_VERIFIED' });
    }

    const event = toExternalUserEvent(body);
    if (event === null) return { status: 'ignored' };
    return { status: await this.provisioning.apply(event) };
  }
}
