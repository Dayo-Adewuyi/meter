import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { fetchPaid } from './fetch-paid.ts';
import type { ApiResponse, MeterApi } from './meter-api.ts';

export interface ServerOptions {
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How paid resources are fetched; tests substitute a fake seller. */
  readonly fetchResource?: typeof fetch;
}

interface ApiError {
  code?: string;
  message?: string;
  limit?: string;
  remaining?: string;
  requested?: string;
  resets_at?: string;
  dimension?: string;
}

const PROCESSING_NOTE =
  'The money is held and the purchase is in progress. Do NOT call buy_airtime again for this request; call get_purchase later with this purchase_id.';

/** One plain sentence the model can repeat to the user (§10.2). */
export function explain(error: ApiError): string {
  const parts = [`Declined (${error.code ?? 'UNKNOWN'}): ${(error.message ?? 'the request was refused').replace(/\.$/, '')}`];
  if (error.limit !== undefined && error.remaining !== undefined) {
    parts.push(`Limit ₦${error.limit}, ₦${error.remaining} remaining`);
  } else if (error.limit !== undefined && error.requested !== undefined) {
    parts.push(`Limit ₦${error.limit}, requested ₦${error.requested}`);
  }
  if (error.resets_at !== undefined) parts.push(`resets at ${error.resets_at}`);
  if (error.code === 'DUPLICATE_SUSPECTED') {
    parts.push('Only retry with confirm_duplicate=true if the user explicitly asked to buy the same thing again');
  }
  return `${parts.join('. ')}.`;
}

function result(payload: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/** Denials and auth failures are answers for the model, not transport errors. */
function fromResponse(response: ApiResponse, onSuccess: (body: Record<string, unknown>) => Record<string, unknown>): CallToolResult {
  const error = response.body.error as ApiError | undefined;
  if (response.status >= 400 || error !== undefined) {
    return result({ declined: true, error, explanation: explain(error ?? { message: `HTTP ${response.status}` }) });
  }
  return result(onSuccess(response.body));
}

export function createMeterMcpServer(api: MeterApi, options: ServerOptions = {}): McpServer {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 8_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const server = new McpServer({ name: 'meter', version: '0.1.0' });

  server.registerTool(
    'get_spending_power',
    {
      description:
        'What you may spend right now under your mandate: the spendable amount, which limit binds it, each limit broken out, and how many purchases are in progress. Call this before a purchase if unsure.',
      inputSchema: {},
    },
    async () => fromResponse(await api.spendingPower(), (body) => body),
  );

  server.registerTool(
    'buy_airtime',
    {
      description: [
        'Buy Nigerian mobile airtime from the user\'s Meter balance, within the limits of your mandate.',
        'Returns the final status when it arrives within a few seconds, otherwise status "processing".',
        `If the result is "processing": ${PROCESSING_NOTE}`,
        'If the result is declined, tell the user exactly which limit applied and when it resets; do not retry with a smaller or split amount unless the user asks.',
      ].join(' '),
      inputSchema: {
        network: z.enum(['mtn', 'airtel', 'glo', '9mobile']).describe('Mobile network of the phone number.'),
        phone: z.string().describe('Nigerian mobile number, e.g. 08030000000 or +2348030000000.'),
        amount_naira: z.number().int().min(50).max(50_000).describe('Whole naira, 50 to 50,000.'),
        intent: z
          .string()
          .min(1)
          .max(280)
          .describe('Why you are making this purchase, in the user\'s words where possible. Recorded for the owner; never used to decide.'),
        confirm_duplicate: z
          .boolean()
          .optional()
          .describe('Set true ONLY when the user explicitly asked to repeat an identical purchase they just made.'),
      },
    },
    async (input) => {
      // A fresh key per tool call: the server's duplicate guard catches agent-level retries (§6.4).
      const created = await api.createPurchase(
        {
          category: 'airtime',
          network: input.network,
          destination: input.phone,
          amount: `${input.amount_naira}.00`,
          intent: input.intent,
          confirm_duplicate: input.confirm_duplicate ?? false,
        },
        randomUUID(),
      );
      if (created.status !== 202) return fromResponse(created, (body) => body);

      const purchaseId = String(created.body.purchase_id);
      for (let waited = 0; waited < pollTimeoutMs; waited += pollIntervalMs) {
        await sleep(pollIntervalMs);
        const current = await api.getPurchase(purchaseId);
        if (current.status === 200 && current.body.status !== 'processing') {
          return result({ ...current.body, purchase_id: purchaseId });
        }
      }
      return result({ purchase_id: purchaseId, status: 'processing', note: PROCESSING_NOTE });
    },
  );

  server.registerTool(
    'get_purchase',
    {
      description: 'Current status of one purchase, and once finished, the amount charged or released back to the balance.',
      inputSchema: { purchase_id: z.string().uuid() },
    },
    async ({ purchase_id }) =>
      fromResponse(await api.getPurchase(purchase_id), (body) =>
        body.status === 'processing' ? { ...body, note: PROCESSING_NOTE } : body,
      ),
  );

  server.registerTool(
    'list_purchases',
    {
      description: 'Your recent purchases, newest first, with status.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ limit }) => fromResponse(await api.listPurchases(limit ?? 10), (body) => body),
  );

  server.registerTool(
    'fetch_paid',
    {
      description: [
        'Fetch a web resource that may charge per request using the x402 protocol (HTTP 402), paying in USDC from the user\'s Meter balance within your mandate.',
        'If the resource is free, you get the response. If it asks for payment, Meter checks your mandate and pays once, then the request is retried with proof of payment.',
        'Never call fetch_paid again for the same request because the first one did not return what you wanted: if a payment was made, report its payment_id and use get_payment.',
        'The user is only charged once the payment is final on-chain; if the seller never collects it, it is released automatically.',
      ].join(' '),
      inputSchema: {
        url: z.string().describe('https URL of the resource (http://localhost is allowed for the sandbox).'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        body: z.string().max(20_000).optional().describe('Request body, e.g. JSON text.'),
        headers: z.record(z.string(), z.string()).optional().describe('Extra request headers. Authorization and cookies are never forwarded.'),
        max_amount_usdc: z
          .string()
          .regex(/^\d+(\.\d{1,6})?$/)
          .optional()
          .describe('The most this one request may cost, in USDC, e.g. "0.25". Set it whenever the user named a budget.'),
        intent: z.string().min(1).max(280).describe("Why you are fetching this, in the user's words where possible."),
      },
    },
    async (input) => {
      const outcome = await fetchPaid(api, input, options.fetchResource);
      switch (outcome.kind) {
        case 'refused':
          return result({ refused: true, reason: outcome.reason }, true);
        case 'declined':
          return result({ declined: true, error: outcome.error, explanation: explain(outcome.error ?? { message: `HTTP ${outcome.status}` }) });
        case 'response':
          return result({ status: outcome.status, content_type: outcome.contentType, body: outcome.body, paid: false });
        case 'paid':
          return result({
            status: outcome.status,
            content_type: outcome.contentType,
            body: outcome.body,
            paid: `${outcome.amount} USDC`,
            payment_id: outcome.paymentId,
            note: outcome.accepted
              ? 'Paid. The charge becomes final once the payment settles on-chain.'
              : 'The seller did not accept the payment. Meter holds the funds until the authorization expires unused, then releases them. Do not retry; check get_payment later.',
          });
      }
    },
  );

  server.registerTool(
    'get_payment',
    {
      description: 'Status of one x402 payment: pending (signed, not yet final), settled (charged, with the on-chain transaction) or lapsed (never collected, released).',
      inputSchema: { payment_id: z.string().uuid() },
    },
    async ({ payment_id }) => fromResponse(await api.getX402Payment(payment_id), (body) => body),
  );

  return server;
}
