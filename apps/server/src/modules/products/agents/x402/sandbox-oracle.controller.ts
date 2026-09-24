import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { env } from '@meter/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { addressOf, bytesToHex, keccak256 } from '../../../../adapters/evm/evm.ts';
import { FACILITATOR, type FacilitatorPort } from '../../../../adapters/x402/facilitator.port.ts';
import { decodeHeader, encodeHeader, HEADERS, type PaymentPayload, type PaymentRequired, type PaymentRequirements, X402_VERSION } from '../../../../adapters/x402/protocol.ts';
import { logger } from '../../../../platform/telemetry/logger.ts';
import { Public } from '../../../core/identity/public-route.ts';
import { X402_CONFIG, type X402Config } from './x402.config.ts';

const PRICE = '100000'; // 0.10 USDC
const SANDBOX_MERCHANT = addressOf(keccak256('meter.sandbox.merchant'));

const PROPHECIES = [
  'The ledger remembers what the agent forgets.',
  'Rain over Lagos before the third bell; carry the umbrella you doubt.',
  'A held coin is not a spent coin. Wait for the chain to speak.',
  'What is signed at dusk may still lapse by dawn.',
  'The harmattan brings dust and honest receipts.',
  'Trust the safe block, not the loud one.',
  'Your question has been asked before, and paid for twice. Not today.',
  'Before midnight in Lagos, the day’s limit renews.',
];

type Fault = 'none' | 'never' | 'late' | 'after_expiry' | 'refuse';

/**
 * A paywalled x402 v2 resource for the sandbox (design §7). It is the seller
 * side: it names its price, verifies and settles through a facilitator, and
 * can misbehave on request so every finalization path can be shown.
 */
@Controller('sandbox/x402')
export class SandboxOracleController {
  constructor(
    @Inject(X402_CONFIG) private readonly config: X402Config,
    @Inject(FACILITATOR) private readonly facilitator: FacilitatorPort,
  ) {}

  private requirements(): PaymentRequirements {
    return {
      scheme: 'exact',
      network: this.config.network.network,
      amount: PRICE,
      asset: this.config.network.usdc,
      payTo: env.METER_X402_MERCHANT ?? SANDBOX_MERCHANT,
      maxTimeoutSeconds: 120,
      extra: { name: this.config.network.domainName, version: this.config.network.domainVersion },
    };
  }

  @Public()
  @Get('oracle')
  async oracle(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('q') question = 'What does the chain say?',
    @Query('fault') fault: Fault = 'none',
  ) {
    const url = `${request.protocol}://${request.headers.host}${request.url}`;
    const requirements = this.requirements();
    const demand = (error: string) => {
      const required: PaymentRequired = { x402Version: X402_VERSION, error, resource: { url, description: 'A prophecy from the sandbox oracle', mimeType: 'application/json' }, accepts: [requirements] };
      reply.status(402).header(HEADERS.required.toUpperCase(), encodeHeader(required));
      return {};
    };

    const header = request.headers[HEADERS.signature];
    if (typeof header !== 'string') return demand('PAYMENT-SIGNATURE header is required');
    let payload: PaymentPayload;
    try {
      payload = decodeHeader<PaymentPayload>(header);
    } catch {
      reply.status(400);
      return { error: 'PAYMENT-SIGNATURE is not base64 JSON' };
    }
    if (fault === 'refuse') return demand('the oracle is not answering today');

    const verified = await this.facilitator.verify(payload, requirements);
    if (!verified.isValid) return demand(verified.invalidReason ?? 'invalid payment');

    const answer = { question, prophecy: PROPHECIES[keccak256(question)[0]! % PROPHECIES.length], oracle: 'sandbox' };
    const settleLater = (ms: number) =>
      setTimeout(() => {
        void this.facilitator.settle(payload, requirements).then(
          (result) => logger.info({ result }, 'sandbox oracle settled late'),
          (error: unknown) => logger.warn({ err: error }, 'sandbox oracle late settlement failed'),
        );
      }, ms).unref();

    if (fault === 'never') {
      // A dishonest seller: answers, claims payment, never settles. Meter must not charge.
      reply.header(HEADERS.response.toUpperCase(), encodeHeader({ success: true, transaction: bytesToHex(keccak256(`forged:${Date.now()}`)), network: requirements.network }));
      return answer;
    }
    if (fault === 'late' || fault === 'after_expiry') {
      const validBefore = Number(payload.payload.authorization.validBefore) * 1000;
      settleLater(fault === 'late' ? 20_000 : Math.max(0, validBefore - Date.now()) + 10_000);
      reply.header(HEADERS.response.toUpperCase(), encodeHeader({ success: true, transaction: 'pending', network: requirements.network }));
      return answer;
    }

    const settled = await this.facilitator.settle(payload, requirements);
    if (!settled.success) return demand(settled.errorReason ?? 'settlement failed');
    reply.header(HEADERS.response.toUpperCase(), encodeHeader(settled));
    return answer;
  }
}
