import { type BeforeApplicationShutdown, Inject, Injectable, Optional } from '@nestjs/common';
import { env } from '@meter/config';
import { SimulatedChain } from '../../../../adapters/chain/simulated-chain.ts';
import { ASSETS, toAtomic } from '@meter/contracts';
import { SIGNER, type SignerPort } from '../../../../adapters/signing/signer.port.ts';
import { logger } from '../../../../platform/telemetry/logger.ts';
import { X402FinalizerService } from './x402-finalizer.service.ts';
import { X402ReconciliationService } from './x402-reconciliation.service.ts';

/**
 * Runs the x402 loops in the process that can see the chain. The simulated
 * chain lives in the API process's memory (the sandbox resource settles on
 * it there), so in sandbox the API owns the loops; against a real chain the
 * worker does, like every other job.
 */
@Injectable()
export class X402Runtime implements BeforeApplicationShutdown {
  private timers: ReturnType<typeof setInterval>[] = [];
  private running = new Set<Promise<unknown>>();

  constructor(
    private readonly finalizer: X402FinalizerService,
    private readonly reconciliation: X402ReconciliationService,
    @Inject(SIGNER) private readonly signer: SignerPort,
    @Optional() @Inject(SimulatedChain) private readonly simulated?: SimulatedChain,
  ) {}

  /**
   * Sandbox faucet: the simulated chain lives in memory, so after a restart,
   * or after USDC was credited by another process (demo:setup), it mints the
   * shortfall into the omnibus. Never runs against a real chain.
   */
  // ponytail: masks under-backing on the simulated chain only; a live chain gets alerts, not mints.
  async backfill(): Promise<void> {
    if (this.simulated === undefined) return;
    this.simulated.mine();
    const report = await this.reconciliation.run({ quiet: true });
    const float = toAtomic(report.float, ASSETS.USDC);
    if (float < 0n) {
      this.simulated.mint(this.signer.address, -float);
      this.simulated.mineMany(this.simulated.safeLag + 1);
      logger.info({ minted: (-float).toString() }, 'sandbox faucet backed the omnibus');
    }
  }

  start(role: 'api' | 'worker'): void {
    const owner = env.METER_X402_CHAIN === 'simulated' ? 'api' : 'worker';
    if (role !== owner) return;
    this.simulated?.start(2_000);
    void this.backfill().catch((error: unknown) => logger.error({ err: error }, 'sandbox faucet failed'));
    this.every('x402-finalizer', 1_000, () => this.finalizer.tick());
    this.every('x402-reconciliation', this.simulated === undefined ? 60_000 : 15_000, async () => {
      await this.backfill();
      return this.reconciliation.run();
    });
    logger.info({ chain: env.METER_X402_CHAIN, role }, 'x402 loops started');
  }

  private every(name: string, ms: number, run: () => Promise<unknown>): void {
    let busy = false;
    this.timers.push(
      setInterval(() => {
        if (busy) return;
        busy = true;
        const work = run()
          .catch((error: unknown) => logger.error({ err: error, loop: name }, 'x402 loop failed'))
          .finally(() => {
            busy = false;
            this.running.delete(work);
          });
        this.running.add(work);
      }, ms),
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.simulated?.stop();
    await Promise.allSettled([...this.running]);
  }
}
