import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { MeterApi } from './meter-api.ts';
import { createMeterMcpServer } from './server.ts';

type Route = (init: RequestInit & { url: URL }) => { status: number; body: object };

async function connect(route: Route, fetchResource?: typeof fetch) {
  const requests: (RequestInit & { url: URL })[] = [];
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    const request = { ...init, url };
    requests.push(request);
    const { status, body } = route(request);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const server = createMeterMcpServer(new MeterApi('http://meter.test', 'mtr_agt_x', fakeFetch), {
    pollIntervalMs: 1,
    pollTimeoutMs: 3,
    sleep: async () => undefined,
    ...(fetchResource === undefined ? {} : { fetchResource }),
  });
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { ...res, json: JSON.parse((res.content as { text: string }[])[0]!.text) };
  };
  return { client, call, requests };
}

const BUY = { network: 'mtn', phone: '08030000000', amount_naira: 500, intent: 'top up my line' };

describe('meter MCP server', () => {
  it('exposes six tools whose descriptions carry the operating rules', async () => {
    const { client } = await connect(() => ({ status: 200, body: {} }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['buy_airtime', 'fetch_paid', 'get_payment', 'get_purchase', 'get_spending_power', 'list_purchases']);
    const buy = tools.find((t) => t.name === 'buy_airtime')!;
    expect(buy.description).toMatch(/Do NOT call buy_airtime again/);
    expect(buy.inputSchema.required).toEqual(expect.arrayContaining(['network', 'phone', 'amount_naira', 'intent']));
  });

  it('buys with a fresh idempotency key per call and returns the final status', async () => {
    let polls = 0;
    const { call, requests } = await connect(({ method }) =>
      method === 'POST'
        ? { status: 202, body: { purchase_id: 'p-1', status: 'processing' } }
        : { status: 200, body: { purchase_id: 'p-1', status: ++polls < 2 ? 'processing' : 'delivered', amount_charged: '500.00' } },
    );

    const first = await call('buy_airtime', BUY);
    await call('buy_airtime', BUY);

    expect(first.json).toMatchObject({ purchase_id: 'p-1', status: 'delivered', amount_charged: '500.00' });
    const posts = requests.filter((r) => r.method === 'POST');
    expect(JSON.parse(posts[0]!.body as string)).toEqual({
      category: 'airtime', network: 'mtn', destination: '08030000000', amount: '500.00', intent: 'top up my line', confirm_duplicate: false,
    });
    const keys = posts.map((r) => (r.headers as Record<string, string>)['idempotency-key']);
    expect(new Set(keys).size).toBe(2);
    expect((posts[0]!.headers as Record<string, string>).authorization).toBe('Bearer mtr_agt_x');
  });

  it('tells the model not to retry while processing', async () => {
    const { call } = await connect(({ method }) =>
      method === 'POST' ? { status: 202, body: { purchase_id: 'p-2' } } : { status: 200, body: { purchase_id: 'p-2', status: 'processing' } },
    );
    const res = await call('buy_airtime', BUY);
    expect(res.json).toMatchObject({ purchase_id: 'p-2', status: 'processing', note: expect.stringMatching(/Do NOT call buy_airtime again/) });
  });

  it('returns denials as results with a plain-language explanation', async () => {
    const { call } = await connect(() => ({
      status: 403,
      body: { error: { code: 'DAILY_LIMIT', message: "This purchase would exceed the mandate's daily limit.", limit: '5000.00', remaining: '500.00', resets_at: '2026-09-25T00:00:00+01:00', decision_id: 'd' } },
    }));
    const res = await call('buy_airtime', BUY);
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(res.json).toMatchObject({ declined: true, error: { code: 'DAILY_LIMIT' } });
    expect(res.json.explanation).toBe(
      "Declined (DAILY_LIMIT): This purchase would exceed the mandate's daily limit. Limit ₦5000.00, ₦500.00 remaining. resets at 2026-09-25T00:00:00+01:00.",
    );
  });

  it('reports a revoked credential as a declined result', async () => {
    const { call } = await connect(() => ({ status: 401, body: { error: { code: 'CREDENTIAL_REVOKED', message: 'The agent credential was not accepted.' } } }));
    const res = await call('get_spending_power');
    expect(res.json).toMatchObject({ declined: true, error: { code: 'CREDENTIAL_REVOKED' } });
  });
});

/** A fake x402 seller: 402 until it sees a PAYMENT-SIGNATURE (or always, if stubborn). */
function seller(options: { free?: boolean; stubborn?: boolean } = {}) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchResource = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({ url, headers });
    if (options.free) return new Response('{"free":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    if (headers['PAYMENT-SIGNATURE'] === undefined || options.stubborn) {
      return new Response('{}', { status: 402, headers: { 'payment-required': 'UkVRVUlSRUQ=' } });
    }
    return new Response('{"prophecy":"rain"}', { status: 200, headers: { 'content-type': 'application/json', 'payment-response': 'U0VUVExFRA==' } });
  }) as unknown as typeof fetch;
  return { seen, fetchResource };
}

const PAID = { url: 'https://oracle.example/q?x=1', intent: 'ask the oracle', max_amount_usdc: '0.25', headers: { authorization: 'Bearer secret', accept: 'application/json' } };

describe('fetch_paid', () => {
  it('pays once for a 402, retries with PAYMENT-SIGNATURE and forwards the settlement hint', async () => {
    const shop = seller();
    const { call, requests } = await connect(({ url }) =>
      url.pathname.endsWith('/settlement')
        ? { status: 200, body: {} }
        : { status: 202, body: { payment_id: 'pay-1', payment_signature: 'U0lHTkVE', amount: '0.100000' } },
      shop.fetchResource,
    );

    const res = await call('fetch_paid', PAID);

    expect(res.json).toMatchObject({ status: 200, paid: '0.100000 USDC', payment_id: 'pay-1', body: '{"prophecy":"rain"}' });
    expect(shop.seen).toHaveLength(2);
    expect(shop.seen[1]!.headers['PAYMENT-SIGNATURE']).toBe('U0lHTkVE');
    expect(shop.seen.every((r) => r.headers.authorization === undefined)).toBe(true);
    const create = requests.find((r) => r.url.pathname === '/v1/agent/x402/payments')!;
    expect(JSON.parse(create.body as string)).toEqual({ payment_required: 'UkVRVUlSRUQ=', resource_url: PAID.url, method: 'GET', intent: 'ask the oracle', max_amount: '0.25' });
    const hint = requests.find((r) => r.url.pathname.endsWith('/settlement'))!;
    expect(JSON.parse(hint.body as string)).toEqual({ payment_response: 'U0VUVExFRA==' });
  });

  it('never asks Meter to pay for a free resource', async () => {
    const shop = seller({ free: true });
    const { call, requests } = await connect(() => ({ status: 500, body: {} }), shop.fetchResource);
    const res = await call('fetch_paid', PAID);
    expect(res.json).toMatchObject({ status: 200, paid: false });
    expect(requests).toHaveLength(0);
  });

  it('returns a mandate denial as a result and does not retry', async () => {
    const shop = seller();
    const { call } = await connect(() => ({ status: 403, body: { error: { code: 'DESTINATION_NOT_ALLOWED', message: 'The mandate does not allow purchases for this destination.' } } }), shop.fetchResource);
    const res = await call('fetch_paid', PAID);
    expect(res.json).toMatchObject({ declined: true, error: { code: 'DESTINATION_NOT_ALLOWED' } });
    expect(shop.seen).toHaveLength(1);
  });

  it('reports a seller that refuses after payment, and never pays twice', async () => {
    const shop = seller({ stubborn: true });
    const { call, requests } = await connect(() => ({ status: 202, body: { payment_id: 'pay-2', payment_signature: 'U0lHTkVE', amount: '0.100000' } }), shop.fetchResource);
    const res = await call('fetch_paid', PAID);
    expect(res.json).toMatchObject({ status: 402, payment_id: 'pay-2', note: expect.stringMatching(/Do not retry/) });
    expect(shop.seen).toHaveLength(2);
    expect(requests.filter((r) => r.url.pathname === '/v1/agent/x402/payments')).toHaveLength(1);
  });

  it('refuses plain http to other hosts', async () => {
    const shop = seller();
    const { call } = await connect(() => ({ status: 500, body: {} }), shop.fetchResource);
    const res = await call('fetch_paid', { ...PAID, url: 'http://oracle.example/q' });
    expect(res.json).toMatchObject({ refused: true });
    expect(shop.seen).toHaveLength(0);
  });
});
