import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentRoute, requireScope } from '../../../core/authorization/agent-credential.guard.ts';
import { idempotencyKey, parse } from '../validation.ts';
import { X402FinalizerService } from './x402-finalizer.service.ts';
import { presentX402, X402PaymentsService } from './x402-payments.service.ts';
import { x402PaymentRequestSchema, X402RequestError } from './x402-request.ts';
import { Inject } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { DATABASE } from '../../../../platform/database/database.module.ts';
import type { DB } from '../../../../platform/database/types.ts';
import { buildX402Timeline } from './x402-timeline.ts';

const hintSchema = z.object({ payment_response: z.string().max(8_192).optional() }).strict();

/** Agent routes for x402 (design §4.1): ask Meter to pay a PAYMENT-REQUIRED. */
@AgentRoute()
@Controller('agent/x402')
export class AgentX402Controller {
  constructor(private readonly payments: X402PaymentsService) {}

  @Post('payments')
  async create(@Req() request: FastifyRequest, @Headers('idempotency-key') key: unknown, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const agent = request.agent!;
    const idempotency = idempotencyKey(key);
    const input = parse(x402PaymentRequestSchema, body);
    try {
      const result = await this.payments.create(agent, idempotency, input);
      reply.status(result.httpStatus);
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return result.body;
    } catch (error) {
      if (error instanceof X402RequestError) throw new BadRequestException({ error: { code: error.code, message: error.message } });
      throw error;
    }
  }

  @Get('payments/:id')
  get(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    requireScope(request.agent!, 'purchases:read');
    return this.payments.getForAgent(request.agent!, id);
  }

  @Post('payments/:id/settlement')
  @HttpCode(200)
  hint(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const { payment_response } = parse(hintSchema, body);
    return this.payments.hint(request.agent!, id, payment_response);
  }
}

const resolveSchema = z
  .object({ outcome: z.enum(['settled', 'lapsed']), reason: z.string().trim().min(1).max(280), evidence: z.string().trim().min(1).max(280) })
  .strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });

/** Owner and operator views of x402 payments. */
@Controller()
export class OwnerX402Controller {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly finalizer: X402FinalizerService,
  ) {}

  @Get('mandates/:id/x402-payments')
  async list(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string, @Query() query: unknown) {
    const { limit } = parse(listQuery, query);
    const rows = await this.db
      .selectFrom('agents.x402_payments as p')
      .innerJoin('authz.agent_credentials as c', 'c.id', 'p.credential_id')
      .innerJoin('authz.mandates as m', 'm.id', 'c.mandate_id')
      .selectAll('p')
      .select('c.label as credential_label')
      .where('m.id', '=', id)
      .where('m.owner_id', '=', request.principal!.userId)
      .orderBy('p.id', 'desc')
      .limit(limit)
      .execute();
    return { payments: rows.map((row) => ({ ...presentX402(row), credential_label: row.credential_label })) };
  }

  @Get('x402/payments/:id/timeline')
  async timeline(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    const principal = request.principal!;
    const timeline = await buildX402Timeline(this.db, id);
    if (timeline === null || (timeline.owner_id !== principal.userId && !principal.roles.includes('operator'))) {
      throw new NotFoundException({ error: { code: 'PAYMENT_NOT_FOUND' } });
    }
    return timeline;
  }

  @Post('operator/x402/payments/:id/resolve')
  @HttpCode(200)
  async resolve(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const principal = request.principal!;
    if (!principal.roles.includes('operator')) throw new ForbiddenException({ error: { code: 'OPERATOR_ROLE_REQUIRED' } });
    const input = parse(resolveSchema, body);
    try {
      const done = await this.finalizer.resolve(principal.userId, id, input);
      if (!done) throw new BadRequestException({ error: { code: 'PAYMENT_NOT_UNRESOLVED', message: 'Only an unresolved payment can be resolved by an operator.' } });
    } catch (error) {
      if (error instanceof Error && /cannot be released/.test(error.message)) {
        throw new BadRequestException({ error: { code: 'CHAIN_SHOWS_PAYMENT', message: error.message } });
      }
      throw error;
    }
    return buildX402Timeline(this.db, id);
  }
}
