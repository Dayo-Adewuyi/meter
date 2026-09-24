import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ASSETS, decimalString, fromAtomic, toAtomic } from '@meter/contracts';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { DATABASE } from '../../../platform/database/database.module.ts';
import { serializable } from '../../../platform/database/transaction.ts';
import type { DB } from '../../../platform/database/types.ts';
import { CREDENTIAL_SCOPES, MandatesService } from '../../core/authorization/mandates.service.ts';
import type { MeterPrincipal } from '../../core/identity/principal.ts';
import { ensureCustomerAccounts } from '../../core/ledger/accounts.ts';
import { CreditDebitService } from '../../core/ledger/credit-debit.service.ts';
import { normalizeNigerianMobile } from './airtime-request.ts';
import { PurchasesService } from './purchases.service.ts';
import { buildTimeline } from './timeline.ts';
import { idempotencyKey, parse } from './validation.ts';

const THIRTY_DAYS = 30 * 86_400_000;

const naira = decimalString.transform((value, ctx) => {
  try {
    const atomic = toAtomic(value, ASSETS.NGN);
    if (atomic > 0n) return atomic;
  } catch {
    // fall through
  }
  ctx.addIssue({ code: 'custom', message: 'must be a positive NGN amount with at most 2 decimals' });
  return 0n;
});

const futureDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value)).refine((date) => date > new Date(), 'must be in the future');

const createMandateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    per_transaction_limit: naira,
    daily_limit: naira,
    lifetime_limit: naira,
    velocity: z.object({ max_count: z.int().positive(), window_secs: z.int().positive() }),
    max_in_flight: z.int().positive().optional(),
    duplicate_window_secs: z.int().nonnegative().optional(),
    allowed_categories: z.array(z.literal('airtime')).min(1),
    allowed_destinations: z
      .array(z.string().transform((value, ctx) => {
        const normalized = normalizeNigerianMobile(value);
        if (normalized === null) ctx.addIssue({ code: 'custom', message: 'must be a valid Nigerian mobile number' });
        return normalized ?? '';
      }))
      .min(1)
      .nullable()
      .default(null),
    expires_at: futureDate.optional(),
  })
  .strict()
  .refine((m) => m.per_transaction_limit <= m.daily_limit && m.daily_limit <= m.lifetime_limit, {
    message: 'limits must satisfy per_transaction ≤ daily ≤ lifetime',
  });

const issueCredentialSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(CREDENTIAL_SCOPES)).min(1).default([...CREDENTIAL_SCOPES]),
    expires_at: futureDate.optional(),
  })
  .strict();

const revokeSchema = z.object({ reason: z.string().trim().min(1).max(280).default('revoked by owner') }).strict();

const creditSchema = z.object({ amount: naira }).strict();

const resolveSchema = z
  .object({
    outcome: z.enum(['delivered', 'rejected']),
    reason: z.string().trim().min(1).max(280),
    evidence: z.string().trim().min(1).max(280),
    provider_reference: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.uuid().optional(),
});

const owner = (request: FastifyRequest): MeterPrincipal => request.principal!;

/** Owner routes (§8.1): a Clerk session, via the global `AuthGuard`. */
@Controller()
export class OwnerController {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly mandates: MandatesService,
    private readonly purchases: PurchasesService,
    private readonly credits: CreditDebitService,
  ) {}

  @Post('mandates')
  create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createMandateSchema, body);
    return this.mandates.create(owner(request).userId, {
      name: input.name,
      assetCode: 'NGN',
      perTransactionLimit: input.per_transaction_limit,
      dailyLimit: input.daily_limit,
      lifetimeLimit: input.lifetime_limit,
      velocityMaxCount: input.velocity.max_count,
      velocityWindowSecs: input.velocity.window_secs,
      ...(input.max_in_flight === undefined ? {} : { maxInFlight: input.max_in_flight }),
      ...(input.duplicate_window_secs === undefined ? {} : { duplicateWindowSecs: input.duplicate_window_secs }),
      allowedCategories: input.allowed_categories,
      allowedDestinations: input.allowed_destinations,
      expiresAt: input.expires_at ?? new Date(Date.now() + THIRTY_DAYS),
    });
  }

  @Get('mandates')
  async list(@Req() request: FastifyRequest) {
    return { mandates: await this.mandates.list(owner(request).userId) };
  }

  @Get('mandates/:id')
  get(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.mandates.get(owner(request).userId, id);
  }

  @Get('mandates/:id/purchases')
  purchasesForMandate(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string, @Query() query: unknown) {
    const { limit, before } = parse(listQuery, query);
    return this.purchases.listForMandate(owner(request).userId, id, limit, before);
  }

  /** The owner's NGN balance: what agents can draw on, and what is held for purchases in flight. */
  @Get('balance')
  async balance(@Req() request: FastifyRequest) {
    const userId = owner(request).userId;
    const rows = await this.db
      .selectFrom('ledger.accounts as a')
      .leftJoin('ledger.balances as b', 'b.account_id', 'a.id')
      .select(['a.purpose', 'b.posted_amount'])
      .where('a.owner_type', '=', 'customer')
      .where('a.owner_id', '=', userId)
      .where('a.asset_code', '=', 'NGN')
      .execute();
    const amount = (purpose: string) =>
      fromAtomic(BigInt(rows.find((row) => row.purpose === purpose)?.posted_amount ?? '0'), ASSETS.NGN);
    return { asset: 'NGN', available: amount('customer_available'), reserved: amount('customer_reserved') };
  }

  @Post('mandates/:id/revoke')
  @HttpCode(200)
  revokeMandate(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const { reason } = parse(revokeSchema, body);
    return this.purchases.revokeMandate(owner(request).userId, id, reason);
  }

  @Post('mandates/:id/credentials')
  issueCredential(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const input = parse(issueCredentialSchema, body);
    return this.mandates.issueCredential(owner(request).userId, id, {
      label: input.label,
      scopes: input.scopes,
      expiresAt: input.expires_at ?? new Date(Date.now() + THIRTY_DAYS),
    });
  }

  @Post('credentials/:id/revoke')
  @HttpCode(200)
  revokeCredential(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.purchases.revokeCredential(owner(request).userId, id);
  }

  @Get('purchases/:id/timeline')
  async timeline(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    const principal = owner(request);
    const timeline = await buildTimeline(this.db, id);
    // Another owner's purchase is indistinguishable from a missing one; operators see all.
    if (timeline === null || (timeline.owner_id !== principal.userId && !principal.roles.includes('operator'))) {
      throw new NotFoundException({ error: { code: 'PURCHASE_NOT_FOUND' } });
    }
    return timeline;
  }

  /** Sandbox only: the whole module is absent unless METER_AGENTS_SANDBOX=true. */
  @Post('sandbox/credit')
  async credit(@Req() request: FastifyRequest, @Headers('idempotency-key') key: unknown, @Body() body: unknown) {
    const idempotency = idempotencyKey(key);
    const { amount } = parse(creditSchema, body);
    const userId = owner(request).userId;
    const accounts = await serializable(this.db, (trx) => ensureCustomerAccounts(trx, userId, 'NGN'));
    const result = await this.credits.credit({
      idempotencyScope: 'sandbox.credit',
      idempotencyKey: `${userId}:${idempotency}`,
      correlationId: crypto.randomUUID(),
      availableAccountId: accounts.available,
      assetCode: 'NGN',
      amountAtomic: amount,
      metadata: { source: 'sandbox' },
    });
    return { transaction_id: result.transactionId, amount: fromAtomic(BigInt(result.amountAtomic), ASSETS.NGN), replayed: result.replayed };
  }

  @Post('operator/purchases/:id/resolve')
  @HttpCode(200)
  resolve(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const principal = owner(request);
    if (!principal.roles.includes('operator')) {
      throw new ForbiddenException({ error: { code: 'OPERATOR_ROLE_REQUIRED' } });
    }
    const input = parse(resolveSchema, body);
    return this.purchases.operatorResolve(principal.userId, id, {
      outcome: input.outcome,
      reason: input.reason,
      evidence: input.evidence,
      ...(input.provider_reference === undefined ? {} : { providerReference: input.provider_reference }),
    });
  }
}
