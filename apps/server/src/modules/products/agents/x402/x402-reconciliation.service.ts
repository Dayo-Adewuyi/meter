import { Inject, Injectable } from '@nestjs/common';
import { ASSETS, fromAtomic } from '@meter/contracts';
import { type Kysely, sql } from 'kysely';
import { CHAIN, type ChainPort } from '../../../../adapters/chain/chain.port.ts';
import { SIGNER, type SignerPort } from '../../../../adapters/signing/signer.port.ts';
import { DATABASE } from '../../../../platform/database/database.module.ts';
import type { DB } from '../../../../platform/database/types.ts';
import { logger } from '../../../../platform/telemetry/logger.ts';

export interface ReconciliationReport {
  readonly safeBlock: string;
  readonly onChain: string;
  readonly customerUsdc: string;
  readonly inTransit: string;
  /** on-chain − (customer USDC − in transit). Negative means customers are under-backed. */
  readonly float: string;
  readonly foreignNonces: readonly string[];
  readonly healthy: boolean;
}

/**
 * The omnibus wallet must hold what customers are owed (design §4.4). A payment
 * already spent on-chain but not yet captured is in transit. Any nonce spent
 * from the omnibus that Meter never issued is proof of key use outside policy.
 */
@Injectable()
export class X402ReconciliationService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(CHAIN) private readonly chain: ChainPort,
    @Inject(SIGNER) private readonly signer: SignerPort,
  ) {}

  /** `quiet` skips alerting, for the sandbox faucet's own pre-check. */
  async run(options: { quiet?: boolean } = {}): Promise<ReconciliationReport> {
    const safe = await this.chain.safeHead();
    const uses = await this.chain.authorizationUses(this.signer.address);
    const onChain = await this.chain.balanceOf(this.signer.address);

    const customer = await this.db
      .selectFrom('ledger.accounts as a')
      .innerJoin('ledger.balances as b', 'b.account_id', 'a.id')
      .select(sql<string>`coalesce(sum(b.posted_amount), 0)`.as('total'))
      .where('a.asset_code', '=', 'USDC')
      .where('a.purpose', 'in', ['customer_available', 'customer_reserved'])
      .executeTakeFirstOrThrow();

    const payments = uses.length === 0
      ? []
      : await this.db
          .selectFrom('agents.x402_payments')
          .select(['auth_nonce', 'state'])
          .where('auth_nonce', 'in', uses.map((use) => use.nonce.toLowerCase()))
          .execute();
    const byNonce = new Map(payments.map((p) => [p.auth_nonce, p.state]));
    let inTransit = 0n;
    const foreign: string[] = [];
    for (const use of uses) {
      const state = byNonce.get(use.nonce.toLowerCase());
      if (state === undefined) foreign.push(use.nonce);
      else if (state === 'signed' || state === 'unresolved') inTransit += use.value;
    }

    const customerUsdc = BigInt(customer.total);
    const float = onChain - (customerUsdc - inTransit);
    const money = (v: bigint) => fromAtomic(v, ASSETS.USDC);
    const report: ReconciliationReport = {
      safeBlock: safe.blockNumber.toString(),
      onChain: money(onChain),
      customerUsdc: money(customerUsdc),
      inTransit: money(inTransit),
      float: money(float),
      foreignNonces: foreign,
      healthy: float >= 0n && foreign.length === 0,
    };
    if (options.quiet === true) return report;
    if (foreign.length > 0) logger.fatal({ ...report, alert: 'x402.foreign_nonce' }, 'omnibus key used outside the policy path');
    else if (float < 0n) logger.error({ ...report, alert: 'x402.under_backed' }, 'omnibus holds less USDC than customers are owed');
    return report;
  }
}
