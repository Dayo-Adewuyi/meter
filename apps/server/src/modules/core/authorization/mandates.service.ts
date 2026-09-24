import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ASSETS, type AssetCode, fromAtomic } from '@meter/contracts';
import type { Kysely, Transaction } from 'kysely';
import { DATABASE } from '../../../platform/database/database.module.ts';
import { serializable } from '../../../platform/database/transaction.ts';
import type { AuthzMandatesTable, DB } from '../../../platform/database/types.ts';
import { ensureCustomerAccounts } from '../ledger/accounts.ts';
import { postedAmount } from '../ledger/credit-debit.service.ts';
import { exposureSince, inFlightCount, lagosDay } from './authorization.service.ts';
import { CREDENTIAL_PEPPER } from './agent-principal.ts';
import { issueToken } from './credential-token.ts';

export interface CreateMandateInput {
  readonly name: string;
  readonly assetCode: AssetCode;
  readonly perTransactionLimit: bigint;
  readonly dailyLimit: bigint;
  readonly lifetimeLimit: bigint;
  readonly velocityMaxCount: number;
  readonly velocityWindowSecs: number;
  readonly maxInFlight?: number;
  readonly duplicateWindowSecs?: number;
  readonly allowedCategories: readonly string[];
  readonly allowedDestinations: readonly string[] | null;
  readonly allowedCounterparties?: readonly string[] | null;
  readonly expiresAt: Date;
}

export interface IssueCredentialInput {
  readonly label: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
}

export const CREDENTIAL_SCOPES = ['purchases:create', 'purchases:read'] as const;

type MandateRow = Awaited<ReturnType<MandatesService['findOwned']>>;

/** Owner-side mandate and credential management (AG2, AG3). */
@Injectable()
export class MandatesService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(CREDENTIAL_PEPPER) private readonly pepper: string,
  ) {}

  async create(ownerId: string, input: CreateMandateInput) {
    const id = await serializable(this.db, async (trx) => {
      const accounts = await ensureCustomerAccounts(trx, ownerId, input.assetCode);
      const row = await trx
        .insertInto('authz.mandates')
        .values({
          owner_id: ownerId,
          name: input.name,
          asset_code: input.assetCode,
          available_account_id: accounts.available,
          reserved_account_id: accounts.reserved,
          per_transaction_limit: input.perTransactionLimit.toString(),
          daily_limit: input.dailyLimit.toString(),
          lifetime_limit: input.lifetimeLimit.toString(),
          velocity_max_count: input.velocityMaxCount,
          velocity_window_secs: input.velocityWindowSecs,
          ...(input.maxInFlight === undefined ? {} : { max_in_flight: input.maxInFlight }),
          ...(input.duplicateWindowSecs === undefined ? {} : { duplicate_window_secs: input.duplicateWindowSecs }),
          allowed_categories: [...input.allowedCategories],
          allowed_destinations: input.allowedDestinations === null ? null : [...input.allowedDestinations],
          allowed_counterparties: input.allowedCounterparties == null ? null : input.allowedCounterparties.map((a) => a.toLowerCase()),
          expires_at: input.expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    return this.get(ownerId, id);
  }

  async list(ownerId: string) {
    const rows = await this.db
      .selectFrom('authz.mandates')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'desc')
      .execute();
    return Promise.all(rows.map((row) => this.present(row)));
  }

  async get(ownerId: string, mandateId: string) {
    return this.present(await this.findOwned(this.db, ownerId, mandateId));
  }

  async issueCredential(ownerId: string, mandateId: string, input: IssueCredentialInput) {
    const mandate = await this.findOwned(this.db, ownerId, mandateId);
    if (mandate.status !== 'active') throw new NotFoundException({ code: 'MANDATE_REVOKED' });
    const issued = issueToken(this.pepper);
    const row = await this.db
      .insertInto('authz.agent_credentials')
      .values({
        mandate_id: mandateId,
        public_id: issued.publicId,
        secret_hash: issued.secretHash,
        label: input.label,
        scopes: [...input.scopes],
        expires_at: input.expiresAt,
      })
      .returning(['id', 'public_id', 'label', 'scopes', 'expires_at', 'created_at'])
      .executeTakeFirstOrThrow();
    // Returned once, here. Only the hash is stored.
    return { ...row, mandate_id: mandateId, token: issued.token };
  }

  /**
   * Revokes the mandate and every credential under it. Returns the credential
   * ids so the caller can expire their undispatched purchases in this same
   * transaction (§5.5).
   */
  async revokeMandateInTransaction(
    trx: Transaction<DB>,
    ownerId: string,
    mandateId: string,
    reason: string,
  ): Promise<string[]> {
    // credential → mandate, same order as authorization.
    const credentials = await trx
      .selectFrom('authz.agent_credentials')
      .select('id')
      .where('mandate_id', '=', mandateId)
      .orderBy('id')
      .forUpdate()
      .execute();
    const mandate = await this.findOwned(trx, ownerId, mandateId, true);
    const now = new Date();
    await trx
      .updateTable('authz.agent_credentials')
      .set({ status: 'revoked', revoked_at: now })
      .where('mandate_id', '=', mandateId)
      .where('status', '=', 'active')
      .execute();
    if (mandate.status === 'active') {
      await trx
        .updateTable('authz.mandates')
        .set({ status: 'revoked', revoked_at: now, revoked_reason: reason, updated_at: now })
        .where('id', '=', mandateId)
        .execute();
    }
    return credentials.map((credential) => credential.id);
  }

  async revokeCredentialInTransaction(trx: Transaction<DB>, ownerId: string, credentialId: string): Promise<void> {
    const credential = await trx
      .selectFrom('authz.agent_credentials as c')
      .innerJoin('authz.mandates as m', 'm.id', 'c.mandate_id')
      .select(['c.id', 'c.status'])
      .where('c.id', '=', credentialId)
      .where('m.owner_id', '=', ownerId)
      .forUpdate('c')
      .executeTakeFirst();
    if (credential === undefined) throw new NotFoundException({ code: 'CREDENTIAL_NOT_FOUND' });
    if (credential.status === 'revoked') return;
    await trx
      .updateTable('authz.agent_credentials')
      .set({ status: 'revoked', revoked_at: new Date() })
      .where('id', '=', credentialId)
      .execute();
  }

  /**
   * What the agent may spend right now: the smallest of balance and every
   * remaining limit, each broken out so the agent can say which one binds.
   */
  async spendingPower(mandateId: string) {
    const mandate = await this.db
      .selectFrom('authz.mandates')
      .selectAll()
      .where('id', '=', mandateId)
      .executeTakeFirstOrThrow();
    const usage = await this.usage(mandate);
    const available = await postedAmount(this.db, mandate.available_account_id);
    const asset = ASSETS[mandate.asset_code as AssetCode];
    const candidates = {
      available_balance: available,
      per_transaction_limit: BigInt(mandate.per_transaction_limit),
      daily_limit: usage.dailyRemaining,
      lifetime_limit: usage.lifetimeRemaining,
    };
    const [binding, amount] = Object.entries(candidates).reduce((min, entry) => (entry[1] < min[1] ? entry : min));
    const active = mandate.status === 'active' && mandate.expires_at > new Date();
    return {
      mandate_id: mandate.id,
      asset: mandate.asset_code,
      spendable: fromAtomic(active ? amount : 0n, asset),
      binding_limit: active ? binding : 'mandate_inactive',
      limits: Object.fromEntries(
        Object.entries(candidates).map(([name, value]) => [name, fromAtomic(value, asset)]),
      ),
      in_flight: usage.inFlight,
      max_in_flight: mandate.max_in_flight,
      daily_resets_at: usage.dayResetsAt.toISOString(),
      allowed_categories: mandate.allowed_categories,
    };
  }

  private async usage(mandate: Pick<AuthzMandatesTable, 'daily_limit' | 'lifetime_limit'> & { id: string }) {
    const now = new Date();
    const day = await lagosDay(this.db, now);
    const today = await exposureSince(this.db, mandate.id, day.start);
    const lifetime = await exposureSince(this.db, mandate.id, null);
    const clamp = (value: bigint) => (value > 0n ? value : 0n);
    return {
      today,
      lifetime,
      dailyRemaining: clamp(BigInt(mandate.daily_limit) - today),
      lifetimeRemaining: clamp(BigInt(mandate.lifetime_limit) - lifetime),
      inFlight: await inFlightCount(this.db, mandate.id),
      dayResetsAt: day.next,
    };
  }

  private async findOwned(db: Kysely<DB> | Transaction<DB>, ownerId: string, mandateId: string, lock = false) {
    let query = db.selectFrom('authz.mandates').selectAll().where('id', '=', mandateId).where('owner_id', '=', ownerId);
    if (lock) query = query.forUpdate();
    const mandate = await query.executeTakeFirst();
    // Another owner's mandate is indistinguishable from a missing one.
    if (mandate === undefined) throw new NotFoundException({ code: 'MANDATE_NOT_FOUND' });
    return mandate;
  }

  private async present(mandate: MandateRow) {
    const asset = ASSETS[mandate.asset_code as AssetCode];
    const money = (value: string | bigint) => fromAtomic(BigInt(value), asset);
    const usage = await this.usage(mandate);
    const credentials = await this.db
      .selectFrom('authz.agent_credentials')
      .select(['id', 'public_id', 'label', 'scopes', 'status', 'expires_at', 'last_used_at', 'created_at'])
      .where('mandate_id', '=', mandate.id)
      .orderBy('created_at')
      .execute();
    return {
      id: mandate.id,
      name: mandate.name,
      asset: mandate.asset_code,
      status: mandate.status,
      expires_at: mandate.expires_at,
      revoked_at: mandate.revoked_at,
      limits: {
        per_transaction: money(mandate.per_transaction_limit),
        daily: money(mandate.daily_limit),
        lifetime: money(mandate.lifetime_limit),
        velocity: { max_count: mandate.velocity_max_count, window_secs: mandate.velocity_window_secs },
        max_in_flight: mandate.max_in_flight,
        duplicate_window_secs: mandate.duplicate_window_secs,
        allowed_categories: mandate.allowed_categories,
        allowed_destinations: mandate.allowed_destinations,
        allowed_counterparties: mandate.allowed_counterparties,
      },
      exposure: {
        today: money(usage.today),
        lifetime: money(usage.lifetime),
        daily_remaining: money(usage.dailyRemaining),
        lifetime_remaining: money(usage.lifetimeRemaining),
        in_flight: usage.inFlight,
        daily_resets_at: usage.dayResetsAt.toISOString(),
      },
      credentials,
      created_at: mandate.created_at,
    };
  }
}
