import { Inject, Injectable, type NestMiddleware, type RawBodyRequest } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { WebhookSecurityService } from './webhook-security.service.ts';
import type { WebhookVerifier } from './webhook-verifier.port.ts';

export interface WebhookRouteConfig {
  readonly provider: string;
  readonly verifier: WebhookVerifier;
}

export const WEBHOOK_ROUTE_CONFIG = Symbol('WEBHOOK_ROUTE_CONFIG');

export interface VerifiedWebhook {
  readonly provider: string;
  readonly eventId: string;
  readonly signedAt: Date;
  readonly outcome: 'accepted' | 'duplicate';
}

declare module 'fastify' {
  interface FastifyRequest {
    verifiedWebhook?: VerifiedWebhook;
  }
}

/**
 * Every provider webhook route shares this middleware: verify, window-check and
 * claim before any handler sees the payload (§15.1). Failures propagate to the
 * Nest exception layer; `next()` runs only for accepted or identical replays.
 */
@Injectable()
export class WebhookVerificationMiddleware implements NestMiddleware {
  constructor(
    private readonly security: WebhookSecurityService,
    @Inject(WEBHOOK_ROUTE_CONFIG) private readonly config: WebhookRouteConfig,
  ) {}

  async use(
    request: RawBodyRequest<FastifyRequest>,
    _response: FastifyReply,
    next: () => void,
  ): Promise<void> {
    const { outcome, envelope } = await this.security.authorize({
      provider: this.config.provider,
      verifier: this.config.verifier,
      rawBody: request.rawBody,
      headers: request.headers,
    });

    request.verifiedWebhook = Object.freeze({
      provider: this.config.provider,
      eventId: envelope.eventId,
      signedAt: envelope.signedAt,
      outcome,
    });
    next();
  }
}
