import { type BeforeApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import {
  type AirtimeRequest,
  type RequeryOutcome,
  type SendOutcome,
  VAS_PROVIDER,
  type VasProvider,
} from '../../../adapters/vas/vas-provider.port.ts';
import { DATABASE } from '../../../platform/database/database.module.ts';
import { serializable } from '../../../platform/database/transaction.ts';
import type { DB, JsonValue } from '../../../platform/database/types.ts';
import { logger } from '../../../platform/telemetry/logger.ts';
import { AGENTS_CONFIG, type AgentsConfig, requeryDelay } from './agents.config.ts';
import { maskPhone } from './airtime-request.ts';
import { type Purchase, PurchasesService, transition } from './purchases.service.ts';

const WORKER = 'worker';
const CONCURRENCY = 4;

function airtimeRequest(purchase: Purchase): AirtimeRequest {
  return {
    requestId: purchase.id,
    network: purchase.network,
    destination: purchase.destination,
    amountAtomic: BigInt(purchase.amount),
    correlationId: purchase.correlation_id,
  };
}

/** Stored and logged provider outcome: no raw bodies, no full phone numbers (§9.3). */
function redact(outcome: SendOutcome | RequeryOutcome, call: 'send' | 'requery', at: Date): Record<string, JsonValue> {
  const { kind } = outcome;
  return {
    call,
    kind,
    at: at.toISOString(),
    ...('code' in outcome ? { code: outcome.code } : {}),
    ...('reason' in outcome ? { reason: outcome.reason } : {}),
    ...('providerReference' in outcome && outcome.providerReference !== undefined
      ? { provider_reference: outcome.providerReference }
      : {}),
  };
}

const addMs = (date: Date, ms: number) => new Date(date.getTime() + ms);

/**
 * Drives authorized purchases to a terminal state (§5.3–§5.5). The rule it
 * exists to enforce: a network call never happens inside a database
 * transaction, and no money moves on a guess.
 */
@Injectable()
export class FinalizerService implements BeforeApplicationShutdown {
  /** Replaced in tests to move time without sleeping. */
  clock: () => Date = () => new Date();
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(AGENTS_CONFIG) private readonly config: AgentsConfig,
    @Inject(VAS_PROVIDER) private readonly provider: VasProvider,
    private readonly purchases: PurchasesService,
  ) {}

  /** Worker loops (§11.1): finalizer every 500 ms, hold sweeper every 5 s. */
  start(): void {
    const loop = (name: string, everyMs: number, run: () => Promise<number>) => {
      let busy = false;
      this.timers.push(
        setInterval(() => {
          if (busy || this.stopping) return;
          busy = true;
          const work = run()
            .catch((error: unknown) => logger.error({ err: error, loop: name }, 'agents loop failed'))
            .finally(() => {
              busy = false;
              this.running.delete(work);
            });
          this.running.add(work);
        }, everyMs),
      );
    };
    loop('agents-finalizer', 500, () => this.tick());
    loop('authz-hold-sweeper', 5_000, () => this.sweep());
    logger.info({ provider: this.provider.name }, 'agents finalizer started');
  }

  /** Stop claiming, let in-flight work finish; anything abandoned is recovered by lease expiry. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    await Promise.allSettled([...this.running]);
  }

  /** One finalizer pass: claim due rows, process each with bounded concurrency. */
  async tick(): Promise<number> {
    const claimed = await this.claim(10);
    const queue = [...claimed];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          await this.process(next).catch((error: unknown) =>
            logger.error({ err: error, purchase_id: next!.id }, 'purchase processing failed; lease expiry will retry'),
          );
        }
      }),
    );
    return claimed.length;
  }

  async claim(limit: number): Promise<Purchase[]> {
    const now = this.clock();
    const { rows } = await sql<Purchase>`
      update agents.purchases p
         set lease_until = ${addMs(now, this.config.leaseMs)}
       where p.id in (
         select id from agents.purchases
          where delivery_status in ('pending_dispatch', 'dispatching', 'awaiting_confirmation')
            and next_action_at <= ${now}
            and (lease_until is null or lease_until < ${now})
          order by next_action_at
          for update skip locked
          limit ${limit})
      returning *`.execute(this.db);
    return rows;
  }

  async process(purchase: Purchase): Promise<void> {
    switch (purchase.delivery_status) {
      case 'pending_dispatch':
        return this.dispatch(purchase);
      case 'dispatching':
        return this.recoverAfterCrash(purchase);
      case 'awaiting_confirmation':
        return this.requery(purchase);
      default:
        return;
    }
  }

  /** Revalidate, write ahead, send, record. */
  private async dispatch(claimed: Purchase): Promise<void> {
    const dispatched = await serializable(this.db, async (trx) => {
      const now = this.clock();
      const row = await trx
        .selectFrom('agents.purchases as p')
        .innerJoin('authz.authorizations as a', 'a.id', 'p.authorization_id')
        .innerJoin('authz.agent_credentials as c', 'c.id', 'p.credential_id')
        .innerJoin('authz.mandates as m', 'm.id', 'a.mandate_id')
        .selectAll('p')
        .select([
          'a.hold_expires_at',
          'c.status as credential_status',
          'c.expires_at as credential_expires_at',
          'm.status as mandate_status',
          'm.expires_at as mandate_expires_at',
        ])
        .where('p.id', '=', claimed.id)
        .forUpdate('p')
        .executeTakeFirstOrThrow();
      if (row.delivery_status !== 'pending_dispatch') return null;

      // Pre-dispatch revalidation (§5.3 step 2): authority must still hold at send time.
      const invalid =
        row.credential_status !== 'active' ? 'CREDENTIAL_REVOKED'
        : row.credential_expires_at <= now ? 'CREDENTIAL_EXPIRED'
        : row.mandate_status !== 'active' ? 'MANDATE_REVOKED'
        : row.mandate_expires_at <= now ? 'MANDATE_EXPIRED'
        : row.hold_expires_at <= now ? 'HOLD_EXPIRED'
        : null;
      if (invalid !== null) {
        await this.purchases.expireInTransaction(trx, row, WORKER, invalid);
        return null;
      }

      // Write-ahead (§5.3 step 3): committed before any byte leaves.
      const sendAttempts = row.send_attempts + 1;
      await transition(trx, row.id, 'pending_dispatch', 'dispatching', {
        actor: WORKER,
        reason: 'write_ahead',
        detail: { send_attempt: sendAttempts },
        set: {
          send_attempts: sendAttempts,
          dispatch_started_at: row.dispatch_started_at ?? now,
          resolve_deadline_at: row.resolve_deadline_at ?? addMs(now, this.config.resolveDeadlineMs),
          lease_until: addMs(now, this.config.leaseMs),
          next_action_at: now,
        },
      });
      return { ...row, send_attempts: sendAttempts };
    });
    if (dispatched === null) return;

    let outcome: SendOutcome;
    try {
      outcome = await this.provider.sendAirtime(airtimeRequest(dispatched));
    } catch (error) {
      // An adapter that throws has not classified the call: that is ambiguity.
      outcome = { kind: 'unknown', reason: `adapter error: ${(error as Error).message}` };
    }
    await this.recordSend(dispatched, outcome);
  }

  private async recordSend(purchase: Purchase, outcome: SendOutcome): Promise<void> {
    const now = this.clock();
    const provider = redact(outcome, 'send', now);
    logger.info({ purchase_id: purchase.id, destination: maskPhone(purchase.destination), provider }, 'provider send');
    const common = { actor: WORKER, detail: { provider }, set: { last_provider_outcome: JSON.stringify(provider) } };

    await serializable(this.db, async (trx) => {
      switch (outcome.kind) {
        case 'delivered':
          await this.purchases.settleInTransaction(trx, purchase.id, 'dispatching', { kind: 'delivered', providerReference: outcome.providerReference }, { ...common, reason: 'provider_delivered' });
          return;
        case 'rejected':
          await this.purchases.settleInTransaction(trx, purchase.id, 'dispatching', { kind: 'rejected', code: outcome.code }, { ...common, reason: 'provider_rejected' });
          return;
        case 'not_sent':
          // Nothing left the process, so retrying or releasing are both safe.
          if (purchase.send_attempts >= this.config.maxSendAttempts) {
            await this.purchases.settleInTransaction(trx, purchase.id, 'dispatching', { kind: 'rejected', code: 'PROVIDER_UNREACHABLE' }, { ...common, reason: 'provider_unreachable' });
          } else {
            await transition(trx, purchase.id, 'dispatching', 'pending_dispatch', {
              ...common,
              reason: 'provider_not_sent',
              set: { ...common.set, lease_until: null, next_action_at: addMs(now, this.config.notSentRetryMs) },
            });
          }
          return;
        case 'unknown':
          // Hold. Only a definitive requery answer or an operator moves money now.
          await transition(trx, purchase.id, 'dispatching', 'awaiting_confirmation', {
            ...common,
            reason: 'provider_outcome_unknown',
            set: {
              ...common.set,
              provider_reference: outcome.providerReference ?? null,
              requery_attempts: 0,
              lease_until: null,
              next_action_at: addMs(now, requeryDelay(this.config, 0)),
            },
          });
          return;
      }
    });
  }

  /**
   * A `dispatching` row with an expired lease: a worker died after write-ahead.
   * The request may or may not have reached the provider. Never resend;
   * requery is always safe (§5.3).
   */
  private async recoverAfterCrash(purchase: Purchase): Promise<void> {
    await serializable(this.db, (trx) =>
      transition(trx, purchase.id, 'dispatching', 'awaiting_confirmation', {
        actor: WORKER,
        reason: 'recovered_after_lease_expiry',
        set: { lease_until: null, requery_attempts: 0, next_action_at: this.clock() },
      }),
    );
  }

  private async requery(purchase: Purchase): Promise<void> {
    let outcome: RequeryOutcome;
    try {
      outcome = await this.provider.requery(airtimeRequest(purchase));
    } catch (error) {
      outcome = { kind: 'unknown', reason: `adapter error: ${(error as Error).message}` };
    }
    const now = this.clock();
    const provider = redact(outcome, 'requery', now);
    logger.info({ purchase_id: purchase.id, destination: maskPhone(purchase.destination), provider }, 'provider requery');
    const common = { actor: WORKER, detail: { provider }, set: { last_provider_outcome: JSON.stringify(provider) } };

    await serializable(this.db, async (trx) => {
      const row = await trx
        .selectFrom('agents.purchases')
        .selectAll()
        .where('id', '=', purchase.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.delivery_status !== 'awaiting_confirmation') return;

      const neverReceived =
        outcome.kind === 'not_found' &&
        row.dispatch_started_at !== null &&
        now.getTime() - row.dispatch_started_at.getTime() > this.config.notFoundGraceMs;

      if (outcome.kind === 'delivered') {
        await this.purchases.settleInTransaction(trx, row.id, 'awaiting_confirmation', { kind: 'delivered', providerReference: outcome.providerReference }, { ...common, reason: 'provider_delivered' });
      } else if (outcome.kind === 'rejected' || neverReceived) {
        const code = outcome.kind === 'rejected' ? outcome.code : 'NEVER_RECEIVED';
        await this.purchases.settleInTransaction(trx, row.id, 'awaiting_confirmation', { kind: 'rejected', code }, { ...common, reason: 'provider_rejected' });
      } else if (row.resolve_deadline_at !== null && now >= row.resolve_deadline_at) {
        // Still held. A human decides, with evidence (§5.4).
        await transition(trx, row.id, 'awaiting_confirmation', 'unresolved', {
          ...common,
          reason: 'resolve_deadline_passed',
          set: { ...common.set, lease_until: null, next_action_at: null },
        });
        logger.error({ purchase_id: row.id, alert: 'agents.purchase_unresolved' }, 'purchase unresolved: operator review required');
      } else {
        // pending, unknown, or not_found inside the grace period: ask again later.
        await trx
          .updateTable('agents.purchases')
          .set({
            requery_attempts: row.requery_attempts + 1,
            next_action_at: addMs(now, requeryDelay(this.config, row.requery_attempts + 1)),
            lease_until: null,
            last_provider_outcome: JSON.stringify(provider),
            updated_at: now,
          })
          .where('id', '=', row.id)
          .execute();
        // Not a status change, but the timeline must show every provider answer (§9.4).
        await trx
          .insertInto('agents.purchase_events')
          .values({
            purchase_id: row.id,
            from_status: 'awaiting_confirmation',
            to_status: 'awaiting_confirmation',
            actor: WORKER,
            reason: `requery_${outcome.kind}`,
            detail: JSON.stringify({ provider }),
            ledger_transaction_id: null,
          })
          .execute();
      }
    });
  }

  /** Hold sweeper (§5.5): expires undispatched holds. Never touches anything dispatched. */
  async sweep(): Promise<number> {
    const now = this.clock();
    const due = await this.db
      .selectFrom('agents.purchases as p')
      .innerJoin('authz.authorizations as a', 'a.id', 'p.authorization_id')
      .select(['p.id', 'p.authorization_id'])
      .where('p.delivery_status', '=', 'pending_dispatch')
      .where('a.hold_expires_at', '<=', now)
      .limit(100)
      .execute();
    let expired = 0;
    for (const purchase of due) {
      const done = await serializable(this.db, (trx) =>
        this.purchases.expireInTransaction(trx, purchase, WORKER, 'HOLD_EXPIRED'),
      );
      if (done) expired++;
    }
    return expired;
  }
}
