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
import { RpcChain } from '../../../adapters/chain/base-rpc-chain.ts';
import { CHAIN } from '../../../adapters/chain/chain.port.ts';
import { SimulatedChain } from '../../../adapters/chain/simulated-chain.ts';
import { LocalKeySigner, SANDBOX_SIGNER_KEY, SIGNER } from '../../../adapters/signing/signer.port.ts';
import { FACILITATOR, HttpFacilitator, SimulatedFacilitator } from '../../../adapters/x402/facilitator.port.ts';
import { SandboxOracleController } from './x402/sandbox-oracle.controller.ts';
import { PRODUCTION_X402_CONFIG, SANDBOX_X402_CONFIG, X402_CONFIG } from './x402/x402.config.ts';
import { AgentX402Controller, OwnerX402Controller } from './x402/x402.controller.ts';
import { X402FinalizerService } from './x402/x402-finalizer.service.ts';
import { X402PaymentsService } from './x402/x402-payments.service.ts';
import { X402ReconciliationService } from './x402/x402-reconciliation.service.ts';
import { X402Runtime } from './x402/x402-runtime.service.ts';

const simulated = env.METER_X402_CHAIN === 'simulated';
const x402Config = env.METER_AGENTS_SANDBOX ? SANDBOX_X402_CONFIG : PRODUCTION_X402_CONFIG;

/**
 * Meter Agents airtime vertical (agent-mandates §2.1). Registered only when
 * METER_AGENTS_SANDBOX=true; the simulator is the only provider until a real
 * adapter lands.
 */
@Module({
  imports: [AuthorizationModule, LedgerModule],
  controllers: [AgentController, OwnerController, AgentX402Controller, OwnerX402Controller, SandboxOracleController],
  providers: [
    { provide: AGENTS_CONFIG, useFactory: () => (env.METER_AGENTS_SANDBOX ? SANDBOX_AGENTS_CONFIG : PRODUCTION_AGENTS_CONFIG) },
    { provide: VAS_PROVIDER, useFactory: () => new SimulatedVasProvider() },
    PurchasesService,
    FinalizerService,
    { provide: X402_CONFIG, useValue: x402Config },
    // The sandbox key is public and only ever signs on the simulated chain (config refuses it live).
    { provide: SIGNER, useFactory: () => new LocalKeySigner(env.METER_X402_SIGNER_KEY ?? SANDBOX_SIGNER_KEY) },
    ...(simulated ? [{ provide: SimulatedChain, useFactory: () => new SimulatedChain(x402Config.network) }] : []),
    {
      provide: CHAIN,
      useFactory: (chain?: SimulatedChain) => chain ?? new RpcChain(x402Config.network, env.METER_X402_RPC_URL!),
      inject: simulated ? [SimulatedChain] : [],
    },
    {
      provide: FACILITATOR,
      useFactory: (chain?: SimulatedChain) => (chain === undefined ? new HttpFacilitator(env.METER_X402_FACILITATOR_URL) : new SimulatedFacilitator(chain, x402Config.network)),
      inject: simulated ? [SimulatedChain] : [],
    },
    X402PaymentsService,
    X402FinalizerService,
    X402ReconciliationService,
    X402Runtime,
  ],
  exports: [PurchasesService, FinalizerService, X402Runtime, SIGNER, ...(simulated ? [SimulatedChain] : [])],
})
export class AgentsModule {}
