import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { CHAIN, type ChainPort } from '../../../../adapters/chain/chain.port.ts';
import type { Hex } from '../../../../adapters/evm/evm.ts';
import { sameAddress } from '../../../../adapters/x402/protocol.ts';
import { DATABASE } from '../../../../platform/database/database.module.ts';
import { serializable } from '../../../../platform/database/transaction.ts';
import type { DB } from '../../../../platform/database/types.ts';
import { logger } from '../../../../platform/telemetry/logger.ts';
import { AuthorizationService } from '../../../core/authorization/authorization.service.ts';
import { X402_CONFIG, type X402Config } from './x402.config.ts';
import { transitionX402, type X402Payment } from './x402-payments.service.ts';

const WORKER = 'worker';

export type X402Resolution = { outcome: 'settled' | 'lapsed'; reason: string; evidence: string };

/**
 * Finalizes signed x402 payments from the chain (design §4.3). The chain is
 * the only witness: the agent, the seller and the facilitator are never
 * believed. Reads happen at the safe head, and a lapse is judged by the safe
 * head's own timestamp, never by our clock.
 */
@Injectable()
export class X402FinalizerService {
  clock: () => Date = () => new Date();

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(X402_CONFIG) private readonly config: X402Config,
    @Inject(CHAIN) private readonly chain: ChainPort,
    private readonly authorization: AuthorizationService,
  ) {}

  async tick(limit = 20): Promise<number> {
    const now = this.clock();
    const { rows } = await sql<X402Payment>`
      update agents.x402_payments p
         set lease_until = ${new Date(now.getTime() + this.config.leaseMs)}
       where p.id in (
         select id from agents.x402_payments
          where state = 'signed'
            and next_action_at <= ${now}
            and (lease_until is null or lease_until < ${now})
          order by next_action_at
          for update skip locked
          limit ${limit})
      returning *`.execute(this.db);
    for (const payment of rows) {
      await this.check(payment).catch((error: unknown) =>
        logger.error({ err: error, payment_id: payment.id }, 'x402 check failed; lease expiry will retry'),
      );
    }
    return rows.length;
  }

  /** One chain reading, then at most one transaction. Never a network call inside it. */
  async check(payment: X402Payment): Promise<void> {
    const now = this.clock();
    let reading: { safe: { blockNumber: bigint; timestamp: bigint }; use: Awaited<ReturnType<ChainPort['authorizationUse']>> };
    try {
      // Head first, then the use. The use is read at a safe head at least as new as `safe`,
      // so "unused" covers every block up to `safe` and a lapse judged by `safe` is sound.
      // (Read the other way round, a use landing between the two reads would be missed.)
      const safe = await this.chain.safeHead();
      reading = { safe, use: await this.chain.authorizationUse(payment.auth_from as Hex, payment.auth_nonce as Hex) };
    } catch (error) {
      await this.unreadable(payment, now, error as Error);
      return;
    }

    const { use, safe } = reading;
    if (use !== null) {
      // The token only executes what was signed; anything else means a broken token or a forged reading.
      if (!sameAddress(use.to, payment.pay_to) || use.value !== BigInt(payment.amount)) {
        logger.fatal({ payment_id: payment.id, use: { ...use, value: use.value.toString() }, alert: 'x402.settlement_mismatch' }, 'on-chain transfer does not match the signed authorization');
        await serializable(this.db, (trx) =>
          transitionX402(trx, payment.id, 'signed', 'unresolved', {
            actor: WORKER,
            reason: 'settlement_mismatch',
            detail: { transaction: use.transaction, to: use.to, value: use.value.toString() },
          }),
        );
        return;
      }
      await this.settle(payment, 'signed', { actor: WORKER, reason: 'authorization_used_at_safe_head', transaction: use.transaction, blockNumber: use.blockNumber, value: use.value });
      return;
    }

    // EIP-3009 requires block.timestamp < validBefore. Every block after the safe head is
    // later still, so once the safe head reaches validBefore the nonce can never be used.
    if (safe.timestamp >= BigInt(payment.valid_before!)) {
      await this.lapse(payment, 'signed', { actor: WORKER, reason: 'expired_unused_at_safe_head', detail: { safe_block: safe.blockNumber.toString(), safe_timestamp: safe.timestamp.toString() } });
      return;
    }

    await this.reschedule(payment, now);
  }

  private async settle(
    payment: X402Payment,
    from: 'signed' | 'unresolved',
    input: { actor: string; reason: string; transaction: string; blockNumber: bigint | null; value: bigint; evidence?: string },
  ): Promise<boolean> {
    return serializable(this.db, async (trx) => {
      const locked = await trx.selectFrom('agents.x402_payments').select(['state', 'authorization_id']).where('id', '=', payment.id).forUpdate().executeTakeFirstOrThrow();
      if (locked.state !== from) return false;
      const capture = await this.authorization.captureInTransaction(trx, locked.authorization_id!);
      return transitionX402(trx, payment.id, from, 'settled', {
        actor: input.actor,
        reason: input.reason,
        ledgerTransactionId: capture.ledgerTransactionId,
        detail: { transaction: input.transaction, block: input.blockNumber?.toString() ?? null, value: input.value.toString(), ...(input.evidence === undefined ? {} : { evidence: input.evidence }) },
        set: { settlement_tx: input.transaction, settlement_block: input.blockNumber?.toString() ?? null, settled_value: input.value.toString() },
      });
    });
  }

  private async lapse(payment: X402Payment, from: 'signed' | 'unresolved', input: { actor: string; reason: string; detail: Record<string, string> }): Promise<boolean> {
    return serializable(this.db, async (trx) => {
      const locked = await trx.selectFrom('agents.x402_payments').select(['state', 'authorization_id']).where('id', '=', payment.id).forUpdate().executeTakeFirstOrThrow();
      if (locked.state !== from) return false;
      const release = await this.authorization.releaseInTransaction(trx, locked.authorization_id!, 'expired');
      return transitionX402(trx, payment.id, from, 'lapsed', { ...input, ledgerTransactionId: release.ledgerTransactionId });
    });
  }

  private async reschedule(payment: X402Payment, now: Date): Promise<void> {
    // Check again soon, and never later than the moment it could lapse.
    const lapseAt = Number(payment.valid_before) * 1000 + 1_000;
    const next = Math.min(now.getTime() + this.config.pollMs, Math.max(lapseAt, now.getTime() + 250));
    await this.db
      .updateTable('agents.x402_payments')
      .set({ next_action_at: new Date(next), lease_until: null, check_attempts: payment.check_attempts + 1, updated_at: now })
      .where('id', '=', payment.id)
      .where('state', '=', 'signed')
      .execute();
  }

  /** The chain could not be read. Hold; after the deadline, a human decides. */
  private async unreadable(payment: X402Payment, now: Date, error: Error): Promise<void> {
    logger.warn({ payment_id: payment.id, err: error.message }, 'x402 chain read failed');
    if (payment.resolve_deadline_at !== null && now >= payment.resolve_deadline_at) {
      await serializable(this.db, (trx) =>
        transitionX402(trx, payment.id, 'signed', 'unresolved', { actor: WORKER, reason: 'chain_unreadable_past_deadline', detail: { error: error.message.slice(0, 200) } }),
      );
      logger.error({ payment_id: payment.id, alert: 'x402.payment_unresolved' }, 'x402 payment unresolved: operator review required');
      return;
    }
    await this.reschedule(payment, now);
  }

  /**
   * Operator resolution of an `unresolved` payment, with evidence (a tx hash or
   * a statement reference). The chain reading is repeated first: an operator
   * may not release what the chain shows as spent.
   */
  async resolve(operatorId: string, paymentId: string, resolution: X402Resolution): Promise<boolean> {
    const payment = await this.db.selectFrom('agents.x402_payments').selectAll().where('id', '=', paymentId).executeTakeFirst();
    if (payment === undefined || payment.state !== 'unresolved') return false;
    if (resolution.outcome === 'lapsed') {
      const use = await this.chain.authorizationUse(payment.auth_from as Hex, payment.auth_nonce as Hex);
      if (use !== null) throw new Error('the chain shows this authorization used; it cannot be released');
      return this.lapse(payment, 'unresolved', { actor: `operator:${operatorId}`, reason: resolution.reason, detail: { evidence: resolution.evidence } });
    }
    return this.settle(payment, 'unresolved', { actor: `operator:${operatorId}`, reason: resolution.reason, transaction: resolution.evidence, blockNumber: null, value: BigInt(payment.amount), evidence: resolution.evidence });
  }
}
