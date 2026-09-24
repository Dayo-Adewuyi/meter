import { Injectable } from '@nestjs/common';
import type { AssetCode } from '@meter/contracts';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { DB } from '../../../platform/database/types.ts';
import { canonicalJson } from '../ledger/canonical-request.ts';
import { SYSTEM_ACCOUNT_IDS } from '../ledger/account-taxonomy.ts';
import { postedAmount } from '../ledger/credit-debit.service.ts';
import { ReservationService } from '../ledger/reservation.service.ts';
import {
  type CheckRecord,
  type Denial,
  type MandateFacts,
  type PolicyRequest,
  evaluatePolicy,
} from './policy.ts';

export interface AuthorizeInput {
  readonly credentialId: string;
  readonly request: PolicyRequest;
  readonly requestDigest: string;
  readonly correlationId: string;
  readonly holdTtlMs: number;
  readonly now?: Date;
}

export interface AuthorizeOutcome {
  readonly decisionId: string;
  readonly mandateId: string | null;
  readonly checks: readonly CheckRecord[];
  readonly denial: Denial | null;
  readonly authorization: {
    readonly id: string;
    readonly reservationId: string;
    readonly ledgerTransactionId: string;
    readonly holdExpiresAt: Date;
  } | null;
}

export interface FinalizeOutcome {
  readonly ledgerTransactionId: string;
  readonly amountAtomic: string;
}

type Db = Kysely<DB> | Transaction<DB>;

/** Start of `now`'s calendar day and of the next one, in Africa/Lagos (§6.2). */
export async function lagosDay(db: Db, now: Date): Promise<{ start: Date; next: Date }> {
  const { rows } = await sql<{ start: Date; next: Date }>`
    select (date_trunc('day', ${now}::timestamptz at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') as start,
           ((date_trunc('day', ${now}::timestamptz at time zone 'Africa/Lagos') + interval '1 day') at time zone 'Africa/Lagos') as next
  `.execute(db);
  return rows[0]!;
}

/**
 * Exposure = held + captured over authorizations created since `since`
 * (§6.2). Derived on every read: there is no counter to drift.
 */
export async function exposureSince(db: Db, mandateId: string, since: Date | null): Promise<bigint> {
  let query = db
    .selectFrom('authz.authorizations')
    .select(
      sql<string>`coalesce(sum(case state when 'authorized' then amount when 'captured' then captured_amount else 0 end), 0)`.as(
        'exposure',
      ),
    )
    .where('mandate_id', '=', mandateId);
  if (since !== null) query = query.where('created_at', '>=', since);
  return BigInt((await query.executeTakeFirstOrThrow()).exposure);
}

async function countAuthorizations(
  db: Db,
  mandateId: string,
  filter: { since?: Date; states?: readonly string[]; destination?: string; amount?: bigint },
): Promise<number> {
  let query = db
    .selectFrom('authz.authorizations')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('mandate_id', '=', mandateId);
  if (filter.since !== undefined) query = query.where('created_at', '>', filter.since);
  if (filter.states !== undefined) query = query.where('state', 'in', filter.states as never);
  if (filter.destination !== undefined) query = query.where('destination', '=', filter.destination);
  if (filter.amount !== undefined) query = query.where('amount', '=', filter.amount.toString());
  return Number((await query.executeTakeFirstOrThrow()).count);
}

export async function inFlightCount(db: Db, mandateId: string): Promise<number> {
  return countAuthorizations(db, mandateId, { states: ['authorized'] });
}

const secondsBefore = (now: Date, seconds: number) => new Date(now.getTime() - seconds * 1000);

/**
 * Core of W4-04: policy decision and funds reservation in the caller's
 * SERIALIZABLE transaction. Product-agnostic: it never learns what is bought.
 */
@Injectable()
export class AuthorizationService {
  constructor(private readonly reservations: ReservationService) {}

  async authorizeInTransaction(trx: Transaction<DB>, input: AuthorizeInput): Promise<AuthorizeOutcome> {
    const now = input.now ?? new Date();

    // Lock order is fixed everywhere: credential → mandate → authorization → ledger (§4).
    const credential = await trx
      .selectFrom('authz.agent_credentials')
      .select(['id', 'mandate_id', 'status', 'expires_at', 'scopes'])
      .where('id', '=', input.credentialId)
      .forUpdate()
      .executeTakeFirst();
    const mandate = credential === undefined
      ? undefined
      : await trx
          .selectFrom('authz.mandates')
          .selectAll()
          .where('id', '=', credential.mandate_id)
          .forUpdate()
          .executeTakeFirst();

    const day = await lagosDay(trx, now);
    const mandateId = mandate?.id ?? null;
    const { request } = input;
    const { checks, denial } = await evaluatePolicy(
      {
        credential: credential ?? null,
        mandate: (mandate as MandateFacts | undefined) ?? null,
        now,
        dayResetsAt: day.next,
        ownerActive: async () => {
          const owner = await trx
            .selectFrom('identity.users')
            .select('status')
            .where('id', '=', mandate!.owner_id)
            .executeTakeFirst();
          // W1-07 owns real restriction state; until then active means unrestricted.
          return owner?.status === 'active';
        },
        duplicates: () =>
          countAuthorizations(trx, mandate!.id, {
            since: secondsBefore(now, mandate!.duplicate_window_secs),
            states: ['authorized', 'captured'],
            destination: request.destination,
            amount: request.amount,
          }),
        velocityCount: () =>
          countAuthorizations(trx, mandate!.id, { since: secondsBefore(now, mandate!.velocity_window_secs) }),
        inFlight: () => inFlightCount(trx, mandate!.id),
        exposureToday: () => exposureSince(trx, mandate!.id, day.start),
        exposureLifetime: () => exposureSince(trx, mandate!.id, null),
        available: () => postedAmount(trx, mandate!.available_account_id),
      },
      request,
    );

    if (denial !== null) {
      const decision = await trx
        .insertInto('authz.decisions')
        .values({
          mandate_id: mandateId,
          credential_id: credential?.id ?? null,
          outcome: 'declined',
          reason_code: denial.code,
          evaluated: canonicalJson({ checks, denial }),
          request_digest: input.requestDigest,
          authorization_id: null,
          correlation_id: input.correlationId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { decisionId: decision.id, mandateId, checks, denial, authorization: null };
    }

    const { rows } = await sql<{ id: string }>`select uuidv7() as id`.execute(trx);
    const authorizationId = rows[0]!.id;
    const reservation = await this.reservations.reserveInTransaction(trx, {
      idempotencyScope: 'authz.reserve',
      idempotencyKey: authorizationId,
      correlationId: input.correlationId,
      availableAccountId: mandate!.available_account_id,
      reservedAccountId: mandate!.reserved_account_id,
      assetCode: mandate!.asset_code as AssetCode,
      amountAtomic: request.amount,
      metadata: { authorizationId, mandateId },
    });
    const holdExpiresAt = new Date(now.getTime() + input.holdTtlMs);
    await trx
      .insertInto('authz.authorizations')
      .values({
        id: authorizationId,
        mandate_id: mandate!.id,
        credential_id: credential!.id,
        reservation_id: reservation.reservationId,
        asset_code: mandate!.asset_code,
        amount: request.amount.toString(),
        category: request.category,
        destination: request.destination,
        hold_expires_at: holdExpiresAt,
        correlation_id: input.correlationId,
        created_at: now,
      })
      .execute();
    const decision = await trx
      .insertInto('authz.decisions')
      .values({
        mandate_id: mandate!.id,
        credential_id: credential!.id,
        outcome: 'approved',
        reason_code: null,
        evaluated: canonicalJson({ checks, denial: null }),
        request_digest: input.requestDigest,
        authorization_id: authorizationId,
        correlation_id: input.correlationId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return {
      decisionId: decision.id,
      mandateId,
      checks,
      denial: null,
      authorization: {
        id: authorizationId,
        reservationId: reservation.reservationId,
        ledgerTransactionId: reservation.transactionId,
        holdExpiresAt,
      },
    };
  }

  /** Delivered: reserved → provider_payable. */
  async captureInTransaction(trx: Transaction<DB>, authorizationId: string): Promise<FinalizeOutcome> {
    const authorization = await this.lockOpen(trx, authorizationId);
    const capture = await this.reservations.captureInTransaction(trx, {
      // Shared with release: a hold can be captured or released, never both (I10).
      idempotencyScope: 'authz.finalize',
      idempotencyKey: authorizationId,
      correlationId: authorization.correlation_id,
      reservationId: authorization.reservation_id,
      destinationAccountId: SYSTEM_ACCOUNT_IDS.provider_payable,
      amountAtomic: BigInt(authorization.amount),
    });
    await this.close(trx, authorizationId, 'captured', capture.capturedAmountAtomic);
    return { ledgerTransactionId: capture.transactionId, amountAtomic: capture.capturedAmountAtomic };
  }

  /** Rejected or expired: reserved → available, and the budget comes back too. */
  async releaseInTransaction(
    trx: Transaction<DB>,
    authorizationId: string,
    finalState: 'released' | 'expired',
  ): Promise<FinalizeOutcome> {
    const authorization = await this.lockOpen(trx, authorizationId);
    const release = await this.reservations.releaseInTransaction(trx, {
      idempotencyScope: 'authz.finalize',
      idempotencyKey: authorizationId,
      correlationId: authorization.correlation_id,
      reservationId: authorization.reservation_id,
    });
    await this.close(trx, authorizationId, finalState, '0');
    return { ledgerTransactionId: release.transactionId, amountAtomic: release.releasedAmountAtomic };
  }

  private async lockOpen(trx: Transaction<DB>, authorizationId: string) {
    const authorization = await trx
      .selectFrom('authz.authorizations')
      .select(['reservation_id', 'amount', 'correlation_id', 'state'])
      .where('id', '=', authorizationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (authorization.state !== 'authorized') {
      throw new Error(`authorization ${authorizationId} is already ${authorization.state}`);
    }
    return authorization;
  }

  private async close(
    trx: Transaction<DB>,
    authorizationId: string,
    state: 'captured' | 'released' | 'expired',
    capturedAmount: string,
  ): Promise<void> {
    await trx
      .updateTable('authz.authorizations')
      .set({ state, captured_amount: capturedAmount, finalized_at: new Date() })
      .where('id', '=', authorizationId)
      .where('state', '=', 'authorized')
      .executeTakeFirstOrThrow();
  }
}
