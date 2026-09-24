import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ASSETS, type AssetCode, fromAtomic } from '@meter/contracts';
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely';
import { DATABASE } from '../../../platform/database/database.module.ts';
import { serializable } from '../../../platform/database/transaction.ts';
import type { AgentsPurchasesTable, DB, DeliveryStatus, JsonValue } from '../../../platform/database/types.ts';
import type { AgentPrincipal } from '../../core/authorization/agent-principal.ts';
import { AuthorizationService } from '../../core/authorization/authorization.service.ts';
import { MandatesService } from '../../core/authorization/mandates.service.ts';
import type { Denial } from '../../core/authorization/policy.ts';
import { digestRequest } from '../../core/ledger/canonical-request.ts';
import { AGENTS_CONFIG, type AgentsConfig } from './agents.config.ts';
import type { PurchaseRequest } from './airtime-request.ts';
import { CANONICAL_STATE, assertTransition, isTerminal } from './purchase-state.ts';

export type Purchase = Selectable<AgentsPurchasesTable>;

export interface CreatePurchaseResult {
  readonly httpStatus: 202 | 402 | 403;
  readonly body: Record<string, unknown>;
  readonly replayed: boolean;
}

export interface TransitionInput {
  readonly actor: string;
  readonly reason: string;
  readonly detail?: Record<string, JsonValue>;
  readonly ledgerTransactionId?: string | null;
  readonly set?: Omit<Updateable<AgentsPurchasesTable>, 'id' | 'delivery_status' | 'canonical_state'>;
}

/**
 * The one way a purchase changes status: guarded on the expected status, with
 * exactly one event in the same transaction (§3.2). A lost race returns false
 * and changes nothing.
 */
export async function transition(
  trx: Transaction<DB>,
  purchaseId: string,
  from: DeliveryStatus,
  to: DeliveryStatus,
  input: TransitionInput,
): Promise<boolean> {
  assertTransition(from, to);
  const result = await trx
    .updateTable('agents.purchases')
    .set({
      ...input.set,
      delivery_status: to,
      canonical_state: CANONICAL_STATE[to],
      updated_at: new Date(),
      ...(isTerminal(to) ? { next_action_at: null, lease_until: null } : {}),
    })
    .where('id', '=', purchaseId)
    .where('delivery_status', '=', from)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) return false;
  await trx
    .insertInto('agents.purchase_events')
    .values({
      purchase_id: purchaseId,
      from_status: from,
      to_status: to,
      actor: input.actor,
      reason: input.reason,
      detail: JSON.stringify(input.detail ?? {}),
      ledger_transaction_id: input.ledgerTransactionId ?? null,
    })
    .execute();
  return true;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

@Injectable()
export class PurchasesService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(AGENTS_CONFIG) private readonly config: AgentsConfig,
    private readonly authorization: AuthorizationService,
    private readonly mandates: MandatesService,
  ) {}

  /**
   * TX1 (§2.2): claim the idempotency key, evaluate policy, reserve, and write
   * the purchase as the durable intent the finalizer picks up — all or nothing.
   */
  async create(agent: AgentPrincipal, idempotencyKey: string, request: PurchaseRequest): Promise<CreatePurchaseResult> {
    const requestDigest = digestRequest(request);
    try {
      return await this.createOnce(agent, idempotencyKey, request, requestDigest);
    } catch (error) {
      // A concurrent request with the same key won the insert: replay it.
      if (!isUniqueViolation(error)) throw error;
      return this.createOnce(agent, idempotencyKey, request, requestDigest);
    }
  }

  private createOnce(
    agent: AgentPrincipal,
    idempotencyKey: string,
    request: PurchaseRequest,
    requestDigest: string,
  ): Promise<CreatePurchaseResult> {
    return serializable(this.db, async (trx) => {
      const existing = await trx
        .selectFrom('agents.purchases')
        .selectAll()
        .where('credential_id', '=', agent.credentialId)
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.request_digest !== requestDigest) {
          throw new ConflictException({
            error: { code: 'IDEMPOTENCY_CONFLICT', message: 'This Idempotency-Key was used with a different request.' },
          });
        }
        return { ...(await this.responseFor(trx, existing)), replayed: true };
      }

      const correlationId = crypto.randomUUID();
      const outcome = await this.authorization.authorizeInTransaction(trx, {
        credentialId: agent.credentialId,
        request: {
          category: request.category,
          destination: request.destination,
          amount: request.amount,
          confirmDuplicate: request.confirm_duplicate,
        },
        requestDigest,
        correlationId,
        holdTtlMs: this.config.holdTtlMs,
      });

      const status: DeliveryStatus = outcome.authorization === null ? 'declined' : 'pending_dispatch';
      const purchase = await trx
        .insertInto('agents.purchases')
        .values({
          credential_id: agent.credentialId,
          idempotency_key: idempotencyKey,
          request_digest: requestDigest,
          authorization_id: outcome.authorization?.id ?? null,
          decision_id: outcome.decisionId,
          category: request.category,
          network: request.network,
          destination: request.destination,
          amount: request.amount.toString(),
          asset_code: 'NGN',
          intent: request.intent,
          canonical_state: CANONICAL_STATE[status],
          delivery_status: status,
          next_action_at: status === 'pending_dispatch' ? new Date() : null,
          correlation_id: correlationId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('agents.purchase_events')
        .values({
          purchase_id: purchase.id,
          from_status: null,
          to_status: status,
          actor: `agent:${agent.credentialId}`,
          reason: outcome.denial?.code ?? 'authorized',
          detail: JSON.stringify({ intent: request.intent }),
          ledger_transaction_id: outcome.authorization?.ledgerTransactionId ?? null,
        })
        .execute();

      return {
        ...this.render(purchase, outcome.denial === null ? null : { ...outcome.denial }, outcome.decisionId),
        replayed: false,
      };
    });
  }

  private async responseFor(db: Kysely<DB>, purchase: Purchase): Promise<Omit<CreatePurchaseResult, 'replayed'>> {
    const decision = await db
      .selectFrom('authz.decisions')
      .select(['id', 'evaluated'])
      .where('id', '=', purchase.decision_id)
      .executeTakeFirstOrThrow();
    const denial = (decision.evaluated as { denial: Denial | null }).denial;
    return this.render(purchase, denial, decision.id);
  }

  /** The original TX1 answer, rebuilt from rows so a replay is byte-for-byte the same shape. */
  private render(purchase: Purchase, denial: Denial | null, decisionId: string): Omit<CreatePurchaseResult, 'replayed'> {
    if (denial === null) {
      return {
        httpStatus: 202,
        body: { purchase_id: purchase.id, status: 'processing', canonical_state: 'authorized', decision_id: decisionId },
      };
    }
    return {
      httpStatus: denial.code === 'INSUFFICIENT_FUNDS' ? 402 : 403,
      body: { error: { ...denial, decision_id: decisionId, purchase_id: purchase.id } },
    };
  }

  async getForAgent(agent: AgentPrincipal, purchaseId: string) {
    const purchase = await this.db
      .selectFrom('agents.purchases')
      .selectAll()
      .where('id', '=', purchaseId)
      .where('credential_id', '=', agent.credentialId)
      .executeTakeFirst();
    if (purchase === undefined) throw new NotFoundException({ error: { code: 'PURCHASE_NOT_FOUND' } });
    return present(purchase);
  }

  async listForAgent(agent: AgentPrincipal, limit: number, before?: string) {
    let query = this.db
      .selectFrom('agents.purchases')
      .selectAll()
      .where('credential_id', '=', agent.credentialId)
      .orderBy('id', 'desc')
      .limit(limit);
    // uuidv7 ids sort by creation time, so the id is the cursor.
    if (before !== undefined) query = query.where('id', '<', before);
    const rows = await query.execute();
    return {
      purchases: rows.map(present),
      next_cursor: rows.length === limit ? rows.at(-1)!.id : null,
    };
  }

  /**
   * Pre-dispatch expiry (§5.5): purchase → expired, hold → expired, ledger
   * release, in the caller's transaction. Anything already dispatching is left
   * alone: value may be in flight.
   */
  async expireInTransaction(trx: Transaction<DB>, purchase: Pick<Purchase, 'id' | 'authorization_id'>, actor: string, reason: string): Promise<boolean> {
    const locked = await trx
      .selectFrom('agents.purchases')
      .select(['id', 'delivery_status'])
      .where('id', '=', purchase.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (locked.delivery_status !== 'pending_dispatch') return false;
    const release = await this.authorization.releaseInTransaction(trx, purchase.authorization_id!, 'expired');
    return transition(trx, purchase.id, 'pending_dispatch', 'expired', {
      actor,
      reason,
      detail: { released: release.amountAtomic },
      ledgerTransactionId: release.ledgerTransactionId,
    });
  }

  private async expireUndispatched(trx: Transaction<DB>, credentialIds: readonly string[], actor: string, reason: string) {
    if (credentialIds.length === 0) return 0;
    const pending = await trx
      .selectFrom('agents.purchases')
      .select(['id', 'authorization_id'])
      .where('credential_id', 'in', credentialIds)
      .where('delivery_status', '=', 'pending_dispatch')
      .orderBy('id')
      .execute();
    let expired = 0;
    for (const purchase of pending) {
      if (await this.expireInTransaction(trx, purchase, actor, reason)) expired++;
    }
    return expired;
  }

  /**
   * TX3 (§5.3): the one place a definitive answer moves money. Locks the
   * purchase, confirms it is still `from`, then captures or releases and
   * records the transition — or does nothing if another actor got there first.
   */
  async settleInTransaction(
    trx: Transaction<DB>,
    purchaseId: string,
    from: DeliveryStatus,
    outcome: { kind: 'delivered'; providerReference: string | null } | { kind: 'rejected'; code: string },
    input: Omit<TransitionInput, 'ledgerTransactionId'>,
  ): Promise<boolean> {
    const locked = await trx
      .selectFrom('agents.purchases')
      .select(['delivery_status', 'authorization_id'])
      .where('id', '=', purchaseId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (locked.delivery_status !== from) return false;

    if (outcome.kind === 'delivered') {
      const capture = await this.authorization.captureInTransaction(trx, locked.authorization_id!);
      return transition(trx, purchaseId, from, 'delivered', {
        ...input,
        ledgerTransactionId: capture.ledgerTransactionId,
        detail: { ...input.detail, captured: capture.amountAtomic },
        set: { ...input.set, provider_reference: outcome.providerReference },
      });
    }
    const release = await this.authorization.releaseInTransaction(trx, locked.authorization_id!, 'released');
    return transition(trx, purchaseId, from, 'rejected', {
      ...input,
      ledgerTransactionId: release.ledgerTransactionId,
      detail: { ...input.detail, code: outcome.code, released: release.amountAtomic },
    });
  }

  /**
   * An operator closes an `unresolved` purchase with evidence (§5.4, §8.3),
   * through the same TX3 path as the finalizer.
   */
  async operatorResolve(
    operatorId: string,
    purchaseId: string,
    resolution: { outcome: 'delivered' | 'rejected'; reason: string; evidence: string; providerReference?: string },
  ) {
    const exists = await this.db.selectFrom('agents.purchases').select('id').where('id', '=', purchaseId).executeTakeFirst();
    if (exists === undefined) throw new NotFoundException({ error: { code: 'PURCHASE_NOT_FOUND' } });
    const settled = await serializable(this.db, (trx) =>
      this.settleInTransaction(
        trx,
        purchaseId,
        'unresolved',
        resolution.outcome === 'delivered'
          ? { kind: 'delivered', providerReference: resolution.providerReference ?? null }
          : { kind: 'rejected', code: 'OPERATOR_REJECTED' },
        { actor: `operator:${operatorId}`, reason: resolution.reason, detail: { evidence: resolution.evidence } },
      ),
    );
    if (!settled) {
      throw new ConflictException({ error: { code: 'PURCHASE_NOT_UNRESOLVED', message: 'Only an unresolved purchase can be resolved by an operator.' } });
    }
    const purchase = await this.db.selectFrom('agents.purchases').selectAll().where('id', '=', purchaseId).executeTakeFirstOrThrow();
    return present(purchase);
  }

  /** Revocation and its pre-dispatch expiry commit together (§5.5, I14, I15). */
  async revokeCredential(ownerId: string, credentialId: string) {
    return serializable(this.db, async (trx) => {
      await this.mandates.revokeCredentialInTransaction(trx, ownerId, credentialId);
      const expired = await this.expireUndispatched(trx, [credentialId], `owner:${ownerId}`, 'CREDENTIAL_REVOKED');
      return { credential_id: credentialId, status: 'revoked', expired_purchases: expired };
    });
  }

  async revokeMandate(ownerId: string, mandateId: string, reason: string) {
    return serializable(this.db, async (trx) => {
      const credentialIds = await this.mandates.revokeMandateInTransaction(trx, ownerId, mandateId, reason);
      const expired = await this.expireUndispatched(trx, credentialIds, `owner:${ownerId}`, 'MANDATE_REVOKED');
      return { mandate_id: mandateId, status: 'revoked', expired_purchases: expired };
    });
  }
}

/** What an agent (or the MCP tool) sees for one purchase. */
export function present(purchase: Purchase) {
  const asset = ASSETS[purchase.asset_code as AssetCode];
  const amount = fromAtomic(BigInt(purchase.amount), asset);
  const status =
    purchase.delivery_status === 'delivered' || purchase.delivery_status === 'declined' || purchase.delivery_status === 'expired'
      ? purchase.delivery_status
      : purchase.delivery_status === 'rejected'
        ? 'failed'
        : 'processing';
  return {
    purchase_id: purchase.id,
    status,
    delivery_status: purchase.delivery_status,
    canonical_state: purchase.canonical_state,
    category: purchase.category,
    network: purchase.network,
    destination: purchase.destination,
    amount,
    asset: purchase.asset_code,
    amount_charged: purchase.delivery_status === 'delivered' ? amount : '0.00',
    amount_released: ['rejected', 'expired'].includes(purchase.delivery_status) ? amount : '0.00',
    amount_held: status === 'processing' ? amount : '0.00',
    provider_reference: purchase.provider_reference,
    intent: purchase.intent,
    created_at: purchase.created_at,
    updated_at: purchase.updated_at,
  };
}
