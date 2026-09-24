import { Module } from '@nestjs/common';
import { env } from '@meter/config';
import { SimulatedVasProvider } from '../../../adapters/vas/simulated-vas-provider.ts';
import { VAS_PROVIDER } from '../../../adapters/vas/vas-provider.port.ts';
import { AuthorizationModule } from '../../core/authorization/authorization.module.ts';
import { LedgerModule } from '../../core/ledger/ledger.module.ts';
import { AgentController } from './agent.controller.ts';
import { AGENTS_CONFIG, PRODUCTION_AGENTS_CONFIG, SANDBOX_AGENTS_CONFIG } from './agents.config.ts';
import { FinalizerService } from './finalizer.service.ts';
import { OwnerController } from './owner.controller.ts';
import { PurchasesService } from './purchases.service.ts';

/**
 * Meter Agents airtime vertical (agent-mandates §2.1). Registered only when
 * METER_AGENTS_SANDBOX=true; the simulator is the only provider until a real
 * adapter lands.
 */
@Module({
  imports: [AuthorizationModule, LedgerModule],
  controllers: [AgentController, OwnerController],
  providers: [
    { provide: AGENTS_CONFIG, useFactory: () => (env.METER_AGENTS_SANDBOX ? SANDBOX_AGENTS_CONFIG : PRODUCTION_AGENTS_CONFIG) },
    { provide: VAS_PROVIDER, useFactory: () => new SimulatedVasProvider() },
    PurchasesService,
    FinalizerService,
  ],
  exports: [PurchasesService, FinalizerService],
})
export class AgentsModule {}
