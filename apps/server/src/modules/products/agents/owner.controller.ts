import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ASSETS, type AssetCode, decimalString, fromAtomic, toAtomic } from '@meter/contracts';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { SimulatedChain } from '../../../adapters/chain/simulated-chain.ts';
import { SIGNER, type SignerPort } from '../../../adapters/signing/signer.port.ts';
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

const futureDate = z.iso.datetime({ offset: true }).transform((value) => new Date(value)).refine((date) => date > new Date(), 'must be in the future');

const positive = (value: string, asset: AssetCode): bigint | null => {
  try {
    const atomic = toAtomic(value, ASSETS[asset]);
    return atomic > 0n ? atomic : null;
  } catch {
    return null;
  }
};

const originOf = (value: string): string | null => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
};

/**
 * A covenant has one asset: airtime is bought in NGN, x402 resources are paid
 * in USDC. Limits parse in that asset's precision; destinations are phone
 * numbers for airtime and https origins for x402.
 */
const createMandateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    asset: z.enum(['NGN', 'USDC']).default('NGN'),
    per_transaction_limit: decimalString,
    daily_limit: decimalString,
    lifetime_limit: decimalString,
    velocity: z.object({ max_count: z.int().positive(), window_secs: z.int().positive() }),
    max_in_flight: z.int().positive().optional(),
    duplicate_window_secs: z.int().nonnegative().optional(),
    allowed_categories: z.array(z.enum(['airtime', 'x402'])).min(1),
    allowed_destinations: z.array(z.string().trim().min(1)).min(1).nullable().default(null),
    allowed_counterparties: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be an address')).min(1).nullable().default(null),
    expires_at: futureDate.optional(),
  })
  .strict()
  .transform((m, ctx) => {
    const x402 = m.allowed_categories.includes('x402');
    if (x402 && m.allowed_categories.includes('airtime')) ctx.addIssue({ code: 'custom', path: ['allowed_categories'], message: 'airtime and x402 need separate covenants (NGN and USDC)' });
    if (x402 !== (m.asset === 'USDC')) ctx.addIssue({ code: 'custom', path: ['asset'], message: 'x402 covenants are USDC; airtime covenants are NGN' });
    if (!x402 && m.allowed_counterparties !== null) ctx.addIssue({ code: 'custom', path: ['allowed_counterparties'], message: 'counterparties apply to x402 only' });
    const limits = [m.per_transaction_limit, m.daily_limit, m.lifetime_limit].map((v) => positive(v, m.asset));
    limits.forEach((limit, i) => {
      if (limit === null) ctx.addIssue({ code: 'custom', path: [['per_transaction_limit', 'daily_limit', 'lifetime_limit'][i]!], message: `must be a positive ${m.asset} amount` });
    });
    const destinations = m.allowed_destinations?.map((value, i) => {
      const normalized = x402 ? originOf(value) : normalizeNigerianMobile(value);
      if (normalized === null) ctx.addIssue({ code: 'custom', path: ['allowed_destinations', i], message: x402 ? 'must be an http(s) origin' : 'must be a valid Nigerian mobile number' });
      return normalized ?? '';
    }) ?? null;
    const [perTransaction = 0n, daily = 0n, lifetime = 0n] = limits.map((l) => l ?? 0n);
    if (limits.every((l) => l !== null) && !(perTransaction <= daily && daily <= lifetime)) {
      ctx.addIssue({ code: 'custom', message: 'limits must satisfy per_transaction ≤ daily ≤ lifetime' });
    }
    return { ...m, perTransaction, daily, lifetime, destinations };
  });

const issueCredentialSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(CREDENTIAL_SCOPES)).min(1).default([...CREDENTIAL_SCOPES]),
    expires_at: futureDate.optional(),
  })
  .strict();

const revokeSchema = z.object({ reason: z.string().trim().min(1).max(280).default('revoked by owner') }).strict();

const creditSchema = z
  .object({ amount: decimalString, asset: z.enum(['NGN', 'USDC']).default('NGN') })
  .strict()
  .transform((c, ctx) => {
    const amount = positive(c.amount, c.asset);
    if (amount === null) ctx.addIssue({ code: 'custom', path: ['amount'], message: `must be a positive ${c.asset} amount` });
    return { asset: c.asset, amount: amount ?? 0n };
  });

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
    @Inject(SIGNER) private readonly signer: SignerPort,
    @Optional() @Inject(SimulatedChain) private readonly chain?: SimulatedChain,
  ) {}

  @Post('mandates')
  create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createMandateSchema, body);
    return this.mandates.create(owner(request).userId, {
      name: input.name,
      assetCode: input.asset,
      perTransactionLimit: input.perTransaction,
      dailyLimit: input.daily,
      lifetimeLimit: input.lifetime,
      velocityMaxCount: input.velocity.max_count,
      velocityWindowSecs: input.velocity.window_secs,
      ...(input.max_in_flight === undefined ? {} : { maxInFlight: input.max_in_flight }),
      ...(input.duplicate_window_secs === undefined ? {} : { duplicateWindowSecs: input.duplicate_window_secs }),
      allowedCategories: input.allowed_categories,
      allowedDestinations: input.destinations,
      allowedCounterparties: input.allowed_counterparties,
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

  /** The owner's balances: what agents can draw on, and what is held for purchases in flight. NGN first. */
  @Get('balance')
  async balance(@Req() request: FastifyRequest) {
    const userId = owner(request).userId;
    const rows = await this.db
      .selectFrom('ledger.accounts as a')
      .leftJoin('ledger.balances as b', 'b.account_id', 'a.id')
      .select(['a.asset_code', 'a.purpose', 'b.posted_amount'])
      .where('a.owner_type', '=', 'customer')
      .where('a.owner_id', '=', userId)
      .execute();
    const amount = (asset: AssetCode, purpose: string) =>
      fromAtomic(BigInt(rows.find((row) => row.asset_code === asset && row.purpose === purpose)?.posted_amount ?? '0'), ASSETS[asset]);
    const assets = (['NGN', 'USDC'] as const).filter((asset) => asset === 'NGN' || rows.some((row) => row.asset_code === asset));
    const balances = assets.map((asset) => ({ asset, available: amount(asset, 'customer_available'), reserved: amount(asset, 'customer_reserved') }));
    return { ...balances[0]!, balances };
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
    const { amount, asset } = parse(creditSchema, body);
    const userId = owner(request).userId;
    // USDC in the ledger must be backed by USDC in the omnibus wallet (x402 design §4.4).
    if (asset === 'USDC' && this.chain === undefined) {
      throw new BadRequestException({
        error: { code: 'FUND_ON_CHAIN', message: `On a live chain, fund the omnibus ${this.signer.address} with testnet USDC; the ledger is not credited on its own.` },
      });
    }
    const accounts = await serializable(this.db, (trx) => ensureCustomerAccounts(trx, userId, asset));
    const result = await this.credits.credit({
      idempotencyScope: 'sandbox.credit',
      idempotencyKey: `${userId}:${idempotency}`,
      correlationId: crypto.randomUUID(),
      availableAccountId: accounts.available,
      assetCode: asset,
      amountAtomic: amount,
      metadata: { source: 'sandbox' },
    });
    // The simulated chain mints the matching float, once per credited journal.
    if (asset === 'USDC' && !result.replayed) this.chain!.mint(this.signer.address, amount);
    return { transaction_id: result.transactionId, asset, amount: fromAtomic(BigInt(result.amountAtomic), ASSETS[asset]), replayed: result.replayed };
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
