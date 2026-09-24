import { Module } from '@nestjs/common';
import { env } from '@meter/config';
import { AuthorizationModule } from './modules/core/authorization/authorization.module.ts';
import { IdentityModule } from './modules/core/identity/identity.module.ts';
import { LedgerModule } from './modules/core/ledger/ledger.module.ts';
import { DatabaseModule } from './platform/database/database.module.ts';
import { JobsModule } from './platform/jobs/jobs.module.ts';
import { HealthController } from './platform/health.controller.ts';
import { AgentsModule } from './modules/products/agents/agents.module.ts';

/**
 * Meter Core modules (PRD §5, arch §8) register here, then vertical products
 * from `modules/products` on top of them. Dependency direction is one-way:
 * a vertical depends on core; core never depends on a vertical.
 */
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    LedgerModule,
    AuthorizationModule,
    JobsModule,
    // Stage 2 stays sandbox-only (agent-mandates §1.3): absent routes are 404s.
    ...(env.METER_AGENTS_SANDBOX ? [AgentsModule] : []),
  ],
  controllers: [HealthController],
})
export class AppModule {}
