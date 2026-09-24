import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ASSETS, fromAtomic } from '@meter/contracts';
import { type Kysely, type Selectable, sql, type Transaction, type Updateable } from 'kysely';
import { concat, type Hex, hexToBytes, keccak256, bytesToHex } from '../../../../adapters/evm/evm.ts';
import { SIGNER, type SignerPort } from '../../../../adapters/signing/signer.port.ts';
import {
  type Authorization,
  authorizationDigest,
  encodeHeader,
  type PaymentPayload,
  X402_VERSION,
} from '../../../../adapters/x402/protocol.ts';
import { DATABASE } from '../../../../platform/database/database.module.ts';
import { serializable } from '../../../../platform/database/transaction.ts';
import type { AgentsX402PaymentsTable, DB, JsonValue, X402State } from '../../../../platform/database/types.ts';
import type { AgentPrincipal } from '../../../core/authorization/agent-principal.ts';
import { AuthorizationService } from '../../../core/authorization/authorization.service.ts';
import type { Denial } from '../../../core/authorization/policy.ts';
import { digestRequest } from '../../../core/ledger/canonical-request.ts';
import { X402_CONFIG, type X402Config } from './x402.config.ts';
import { selectPayment, type X402PaymentRequest } from './x402-request.ts';

export type X402Payment = Selectable<AgentsX402PaymentsTable>;

const CANONICAL: Record<X402State, string> = {
  declined: 'declined',
  signed: 'authorized',
  settled: 'captured',
  lapsed: 'expired',
  unresolved: 'in_progress',
};

const ALLOWED: Record<X402State, readonly X402State[]> = {
  signed: ['settled', 'lapsed', 'unresolved'],
  unresolved: ['settled', 'lapsed'],
  declined: [],
  settled: [],
  lapsed: [],
};

/** keccak256("meter.x402" ‖ payment id): one payment can only ever sign one authorization (I17). */
export function nonceFor(paymentId: string): Hex {
  return bytesToHex(keccak256(concat(new TextEncoder().encode('meter.x402'), hexToBytes(paymentId.replaceAll('-', '')))));
}

export interface X402TransitionInput {
  readonly actor: string;
  readonly reason: string;
  readonly detail?: Record<string, JsonValue>;
  readonly ledgerTransactionId?: string | null;
  readonly set?: Omit<Updateable<AgentsX402PaymentsTable>, 'id' | 'state' | 'canonical_state'>;
}

/** Guarded on the expected state, one event per change, same transaction. */
export async function transitionX402(
  trx: Transaction<DB>,
  paymentId: string,
  from: X402State,
  to: X402State,
  input: X402TransitionInput,
): Promise<boolean> {
  if (!ALLOWED[from].includes(to)) throw new Error(`illegal x402 transition ${from} → ${to}`);
  const terminal = ALLOWED[to].length === 0;
  const result = await trx
    .updateTable('agents.x402_payments')
    .set({
      ...input.set,
      state: to,
      canonical_state: CANONICAL[to],
      updated_at: new Date(),
      ...(terminal ? { next_action_at: null, lease_until: null } : {}),
    })
    .where('id', '=', paymentId)
    .where('state', '=', from)
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) return false;
  await trx
    .insertInto('agents.x402_payment_events')
    .values({
      payment_id: paymentId,
      from_state: from,
      to_state: to,
      actor: input.actor,
      reason: input.reason,
      detail: JSON.stringify(input.detail ?? {}),
      ledger_transaction_id: input.ledgerTransactionId ?? null,
    })
    .execute();
  return true;
}

export interface CreateX402Result {
  readonly httpStatus: 202 | 402 | 403;
  readonly body: Record<string, unknown>;
  readonly replayed: boolean;
}

const usdc = (atomic: string | bigint) => fromAtomic(BigInt(atomic), ASSETS.USDC);

/**
 * x402 design §4.1 (TX1): decode and bind the seller's offer, run the mandate
 * policy, reserve, and sign the EIP-3009 authorization — all in one
 * SERIALIZABLE transaction. Signing is local CPU work, never a network call.
 */
@Injectable()
export class X402PaymentsService {
  /** Replaced in tests to move time without sleeping. */
  clock: () => Date = () => new Date();

  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(X402_CONFIG) private readonly config: X402Config,
    @Inject(SIGNER) private readonly signer: SignerPort,
    private readonly authorization: AuthorizationService,
  ) {}

  get payer(): Hex {
    return this.signer.address;
  }

  async create(agent: AgentPrincipal, idempotencyKey: string, request: X402PaymentRequest): Promise<CreateX402Result> {
    // Before any transaction: a payment Meter cannot make is not a policy decision.
    const selected = selectPayment(request, this.config.network, { min: this.config.minTimeoutSeconds, max: this.config.maxTimeoutSeconds });
    const requestDigest = digestRequest(request);
    try {
      return await this.createOnce(agent, idempotencyKey, request, requestDigest, selected);
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      return this.createOnce(agent, idempotencyKey, request, requestDigest, selected);
    }
  }

  private createOnce(
    agent: AgentPrincipal,
    idempotencyKey: string,
    request: X402PaymentRequest,
    requestDigest: string,
    selected: ReturnType<typeof selectPayment>,
  ): Promise<CreateX402Result> {
    return serializable(this.db, async (trx) => {
      const existing = await trx
        .selectFrom('agents.x402_payments')
        .selectAll()
        .where('credential_id', '=', agent.credentialId)
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (existing !== undefined) {
        if (existing.request_digest !== requestDigest) {
          throw new ConflictException({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'This Idempotency-Key was used with a different request.' } });
        }
        return { ...(await this.responseFor(trx, existing)), replayed: true };
      }

      const now = this.clock();
      const correlationId = crypto.randomUUID();
      const outcome = await this.authorization.authorizeInTransaction(trx, {
        credentialId: agent.credentialId,
        request: {
          category: 'x402',
          destination: selected.origin,
          counterparty: selected.payTo,
          duplicateKey: `${request.method} ${request.resource_url}`,
          amount: selected.amount,
          confirmDuplicate: request.confirm_duplicate,
        },
        requestDigest,
        correlationId,
        // The hold lives as long as the authorization can be executed, plus the grace to observe it.
        holdTtlMs: selected.timeoutSeconds * 1000 + this.config.resolveGraceMs,
        now,
      });

      const { rows } = await sql<{ id: string }>`select uuidv7() as id`.execute(trx);
      const paymentId = rows[0]!.id;
      const base = {
        id: paymentId,
        credential_id: agent.credentialId,
        idempotency_key: idempotencyKey,
        request_digest: requestDigest,
        decision_id: outcome.decisionId,
        network: this.config.network.network,
        asset: this.config.network.usdc,
        pay_to: selected.payTo,
        amount: selected.amount.toString(),
        asset_code: 'USDC' as const,
        resource_url: request.resource_url,
        resource_origin: selected.origin,
        method: request.method,
        intent: request.intent,
        correlation_id: correlationId,
      };

      if (outcome.authorization === null) {
        await trx.insertInto('agents.x402_payments').values({ ...base, authorization_id: null, state: 'declined', canonical_state: CANONICAL.declined, auth_from: null, auth_nonce: null, valid_after: null, valid_before: null, signature: null, payment_payload: null }).execute();
        await this.event(trx, paymentId, null, 'declined', `agent:${agent.credentialId}`, outcome.denial!.code, { intent: request.intent }, null);
        return { ...this.render(paymentId, null, outcome.denial, outcome.decisionId), replayed: false };
      }

      const seconds = Math.floor(now.getTime() / 1000);
      const authorization: Authorization = {
        from: this.signer.address,
        to: selected.payTo as Hex,
        value: selected.amount.toString(),
        validAfter: String(seconds - this.config.skewSeconds),
        validBefore: String(seconds + selected.timeoutSeconds),
        nonce: nonceFor(paymentId),
      };
      const signature = this.signer.sign(authorizationDigest(this.config.network, authorization));
      const payload: PaymentPayload = {
        x402Version: X402_VERSION,
        resource: selected.required.resource,
        accepted: selected.requirements,
        payload: { signature, authorization },
      };
      const validBefore = new Date(Number(authorization.validBefore) * 1000);
      const row = await trx
        .insertInto('agents.x402_payments')
        .values({
          ...base,
          authorization_id: outcome.authorization.id,
          state: 'signed',
          canonical_state: CANONICAL.signed,
          auth_from: authorization.from.toLowerCase(),
          auth_nonce: authorization.nonce,
          valid_after: authorization.validAfter,
          valid_before: authorization.validBefore,
          signature,
          payment_payload: encodeHeader(payload),
          next_action_at: new Date(now.getTime() + this.config.pollMs),
          resolve_deadline_at: new Date(validBefore.getTime() + this.config.resolveGraceMs),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.event(trx, paymentId, null, 'signed', `agent:${agent.credentialId}`, 'authorized', {
        intent: request.intent,
        nonce: authorization.nonce,
        valid_before: authorization.validBefore,
      }, outcome.authorization.ledgerTransactionId);
      return { ...this.render(paymentId, row, null, outcome.decisionId), replayed: false };
    });
  }

  private async event(trx: Transaction<DB>, paymentId: string, from: X402State | null, to: X402State, actor: string, reason: string, detail: Record<string, JsonValue>, ledgerTransactionId: string | null) {
    await trx
      .insertInto('agents.x402_payment_events')
      .values({ payment_id: paymentId, from_state: from, to_state: to, actor, reason, detail: JSON.stringify(detail), ledger_transaction_id: ledgerTransactionId })
      .execute();
  }

  private async responseFor(db: Kysely<DB>, payment: X402Payment): Promise<Omit<CreateX402Result, 'replayed'>> {
    const decision = await db.selectFrom('authz.decisions').select(['id', 'evaluated']).where('id', '=', payment.decision_id).executeTakeFirstOrThrow();
    const denial = (decision.evaluated as { denial: Denial | null }).denial;
    return this.render(payment.id, payment.state === 'declined' ? null : payment, denial, decision.id);
  }

  /** A replay returns the very same signed payload (I17). */
  private render(paymentId: string, row: X402Payment | null, denial: Denial | null, decisionId: string): Omit<CreateX402Result, 'replayed'> {
    if (row === null || denial !== null) {
      return {
        httpStatus: denial?.code === 'INSUFFICIENT_FUNDS' ? 402 : 403,
        body: { error: { ...denial, decision_id: decisionId, payment_id: paymentId } },
      };
    }
    return {
      httpStatus: 202,
      body: {
        payment_id: paymentId,
        status: 'signed',
        payment_signature: row.payment_payload,
        amount: usdc(row.amount),
        asset: 'USDC',
        network: row.network,
        pay_to: row.pay_to,
        valid_before: new Date(Number(row.valid_before) * 1000).toISOString(),
        decision_id: decisionId,
      },
    };
  }

  async getForAgent(agent: AgentPrincipal, paymentId: string) {
    const row = await this.db
      .selectFrom('agents.x402_payments')
      .selectAll()
      .where('id', '=', paymentId)
      .where('credential_id', '=', agent.credentialId)
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundException({ error: { code: 'PAYMENT_NOT_FOUND' } });
    return presentX402(row);
  }

  /**
   * The agent passes on the PAYMENT-RESPONSE it got. It is a hint only: it
   * brings the next chain check forward and never changes state (I19).
   */
  async hint(agent: AgentPrincipal, paymentId: string, paymentResponse: string | undefined) {
    const result = await this.db
      .updateTable('agents.x402_payments')
      .set({ next_action_at: this.clock() })
      .where('id', '=', paymentId)
      .where('credential_id', '=', agent.credentialId)
      .where('state', '=', 'signed')
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return this.getForAgent(agent, paymentId); // 404s if not theirs
    // Recorded for the chronicle; the state it names is unchanged.
    await this.db
      .insertInto('agents.x402_payment_events')
      .values({
        payment_id: paymentId,
        from_state: null,
        to_state: 'signed',
        actor: `agent:${agent.credentialId}`,
        reason: 'settlement_hint',
        detail: JSON.stringify({ payment_response: (paymentResponse ?? '').slice(0, 2048) }),
        ledger_transaction_id: null,
      })
      .execute();
    return this.getForAgent(agent, paymentId);
  }
}

export function presentX402(row: X402Payment) {
  const status =
    row.state === 'settled' ? 'settled' : row.state === 'lapsed' ? 'lapsed' : row.state === 'declined' ? 'declined' : 'pending';
  return {
    payment_id: row.id,
    status,
    state: row.state,
    canonical_state: row.canonical_state,
    amount: usdc(row.amount),
    asset: 'USDC',
    network: row.network,
    pay_to: row.pay_to,
    resource_url: row.resource_url,
    method: row.method,
    intent: row.intent,
    amount_charged: row.state === 'settled' ? usdc(row.amount) : '0.000000',
    amount_released: row.state === 'lapsed' ? usdc(row.amount) : '0.000000',
    valid_before: row.valid_before === null ? null : new Date(Number(row.valid_before) * 1000).toISOString(),
    settlement_tx: row.settlement_tx,
    settlement_block: row.settlement_block,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
