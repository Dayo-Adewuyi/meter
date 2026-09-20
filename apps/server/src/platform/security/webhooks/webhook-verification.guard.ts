import {
  BadRequestException,
  type CanActivate,
  ConflictException,
  type ExecutionContext,
  type HttpException,
  Inject,
  Injectable,
  type RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { WebhookSecurityService } from './webhook-security.service.ts';
import { type WebhookSecurityCode, WebhookSecurityError, type WebhookVerifier } from './webhook-verifier.port.ts';

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

function httpFor(code: WebhookSecurityCode): HttpException {
  switch (code) {
    case 'WEBHOOK_BODY_MISSING':
      return new BadRequestException({ code });
    // Reusing an event ID for different bytes is a conflict, not a bad
    // signature: the provider should stop, not re-sign and retry.
    case 'WEBHOOK_EVENT_CONFLICT':
      return new ConflictException({ code });
    default:
      return new UnauthorizedException({ code });
  }
}

/**
 * Verify, window-check and claim before any handler sees the payload (§15.1).
 *
 * A guard rather than middleware on purpose: on Fastify, an error thrown from
 * Nest middleware never reaches the exception layer — it dies inside the filter
 * (`Reply is not a constructor`) and the request hangs until it times out. A
 * guard runs inside the request pipeline, so a rejection becomes a real status.
 */
@Injectable()
export class WebhookVerificationGuard implements CanActivate {
  constructor(
    private readonly security: WebhookSecurityService,
    @Inject(WEBHOOK_ROUTE_CONFIG) private readonly config: WebhookRouteConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RawBodyRequest<FastifyRequest>>();

    let authorized;
    try {
      authorized = await this.security.authorize({
        provider: this.config.provider,
        verifier: this.config.verifier,
        rawBody: request.rawBody,
        headers: request.headers,
      });
    } catch (error) {
      if (error instanceof WebhookSecurityError) throw httpFor(error.code);
      throw error;
    }

    request.verifiedWebhook = Object.freeze({
      provider: this.config.provider,
      eventId: authorized.envelope.eventId,
      signedAt: authorized.envelope.signedAt,
      outcome: authorized.outcome,
    });
    // An identical replay still reaches the handler, which must be idempotent.
    return true;
  }
}
