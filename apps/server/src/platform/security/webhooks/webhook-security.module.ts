import { Module } from '@nestjs/common';
import {
  PostgresWebhookEventsRepository,
  WEBHOOK_EVENTS_REPOSITORY,
} from './webhook-events.repository.ts';
import { WebhookSecurityService } from './webhook-security.service.ts';

/** Provider-neutral: adapters supply a `WebhookVerifier` per route. */
@Module({
  providers: [
    { provide: WEBHOOK_EVENTS_REPOSITORY, useClass: PostgresWebhookEventsRepository },
    WebhookSecurityService,
  ],
  exports: [WebhookSecurityService],
})
export class WebhookSecurityModule {}
