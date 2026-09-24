import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentRoute, requireScope } from '../../core/authorization/agent-credential.guard.ts';
import type { AgentPrincipal } from '../../core/authorization/agent-principal.ts';
import { MandatesService } from '../../core/authorization/mandates.service.ts';
import { purchaseRequestSchema } from './airtime-request.ts';
import { PurchasesService } from './purchases.service.ts';
import { idempotencyKey, parse } from './validation.ts';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.uuid().optional(),
});

/** Machine routes (§8.2). A human session never gets past `AgentRoute`. */
@AgentRoute()
@Controller('agent')
export class AgentController {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly mandates: MandatesService,
  ) {}

  @Get('spending-power')
  spendingPower(@Req() request: FastifyRequest) {
    const agent = request.agent!;
    requireScope(agent, 'purchases:read');
    return this.mandates.spendingPower(agent.mandateId);
  }

  @Post('purchases')
  async create(
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') key: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const agent: AgentPrincipal = request.agent!;
    const idempotency = idempotencyKey(key);
    const purchase = parse(purchaseRequestSchema, body);
    const result = await this.purchases.create(agent, idempotency, purchase);
    reply.status(result.httpStatus);
    if (result.replayed) reply.header('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Get('purchases/:id')
  get(@Req() request: FastifyRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    requireScope(request.agent!, 'purchases:read');
    return this.purchases.getForAgent(request.agent!, id);
  }

  @Get('purchases')
  list(@Req() request: FastifyRequest, @Query() query: unknown) {
    requireScope(request.agent!, 'purchases:read');
    const { limit, before } = parse(listQuery, query);
    return this.purchases.listForAgent(request.agent!, limit, before);
  }
}
