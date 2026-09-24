import { randomUUID } from 'node:crypto';
import type { MeterApi } from './meter-api.ts';

export interface FetchPaidInput {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | undefined;
  readonly body?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly max_amount_usdc?: string | undefined;
  readonly intent: string;
}

export type FetchPaidOutcome =
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'declined'; readonly error: Record<string, unknown> | undefined; readonly status: number }
  | { readonly kind: 'response'; readonly status: number; readonly contentType: string | null; readonly body: string; readonly paid: null }
  | {
      readonly kind: 'paid';
      readonly status: number;
      readonly contentType: string | null;
      readonly body: string;
      readonly paymentId: string;
      readonly amount: string;
      readonly accepted: boolean;
    };

const MAX_BODY = 6_000;
const FORBIDDEN_HEADERS = new Set(['authorization', 'cookie', 'payment-signature', 'proxy-authorization']);

/** https anywhere; plain http only to this machine (the sandbox). */
function allowedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return null;
  return 'only https URLs (or http://localhost) may be fetched';
}

async function read(response: Response) {
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type'), body: text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…[truncated]` : text };
}

/**
 * The x402 client loop (design §6): request → 402 → ask Meter to pay → retry
 * once with PAYMENT-SIGNATURE → pass PAYMENT-RESPONSE to Meter as a hint.
 * Never pays twice: a second 402 after paying is reported, not retried.
 */
export async function fetchPaid(api: MeterApi, input: FetchPaidInput, fetchResource: typeof fetch = fetch): Promise<FetchPaidOutcome> {
  const invalid = allowedUrl(input.url);
  if (invalid !== null) return { kind: 'refused', reason: invalid };
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([name]) => !FORBIDDEN_HEADERS.has(name.toLowerCase())));
  const init = (extra: Record<string, string> = {}): RequestInit => ({
    method: input.method ?? 'GET',
    headers: { ...headers, ...extra },
    ...(input.body === undefined ? {} : { body: input.body }),
    signal: AbortSignal.timeout(20_000),
    redirect: 'manual',
  });

  const first = await fetchResource(input.url, init());
  if (first.status !== 402) return { kind: 'response', ...(await read(first)), paid: null };
  const required = first.headers.get('payment-required');
  if (required === null) return { kind: 'refused', reason: 'the resource answered 402 without a PAYMENT-REQUIRED header' };

  const payment = await api.createX402Payment(
    {
      payment_required: required,
      resource_url: input.url,
      method: input.method ?? 'GET',
      intent: input.intent,
      ...(input.max_amount_usdc === undefined ? {} : { max_amount: input.max_amount_usdc }),
    },
    randomUUID(),
  );
  if (payment.status !== 202) {
    return { kind: 'declined', status: payment.status, error: payment.body.error as Record<string, unknown> | undefined };
  }

  const paymentId = String(payment.body.payment_id);
  const second = await fetchResource(input.url, init({ 'PAYMENT-SIGNATURE': String(payment.body.payment_signature) }));
  const settlement = second.headers.get('payment-response');
  if (settlement !== null) await api.x402Settlement(paymentId, settlement).catch(() => undefined);
  return { kind: 'paid', ...(await read(second)), paymentId, amount: String(payment.body.amount), accepted: second.status !== 402 };
}
