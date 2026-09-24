export interface ApiResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * The MCP server's only way to reach Meter: the public agent API (§8.2) with
 * one agent credential. No database, no ledger, no owner or operator routes.
 */
export class MeterApi {
  private readonly baseUrl: string;
  private readonly credential: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, credential: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.credential = credential;
    this.fetchImpl = fetchImpl;
  }

  spendingPower(): Promise<ApiResponse> {
    return this.request('GET', '/v1/agent/spending-power');
  }

  createPurchase(body: object, idempotencyKey: string): Promise<ApiResponse> {
    return this.request('POST', '/v1/agent/purchases', body, { 'idempotency-key': idempotencyKey });
  }

  getPurchase(id: string): Promise<ApiResponse> {
    return this.request('GET', `/v1/agent/purchases/${encodeURIComponent(id)}`);
  }

  listPurchases(limit: number): Promise<ApiResponse> {
    return this.request('GET', `/v1/agent/purchases?limit=${limit}`);
  }

  createX402Payment(body: object, idempotencyKey: string): Promise<ApiResponse> {
    return this.request('POST', '/v1/agent/x402/payments', body, { 'idempotency-key': idempotencyKey });
  }

  getX402Payment(id: string): Promise<ApiResponse> {
    return this.request('GET', `/v1/agent/x402/payments/${encodeURIComponent(id)}`);
  }

  x402Settlement(id: string, paymentResponse: string): Promise<ApiResponse> {
    return this.request('POST', `/v1/agent/x402/payments/${encodeURIComponent(id)}/settlement`, { payment_response: paymentResponse });
  }

  private async request(method: string, path: string, body?: object, headers: Record<string, string> = {}): Promise<ApiResponse> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${this.credential}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      parsed = { error: { code: 'UNEXPECTED_RESPONSE', message: text.slice(0, 200) } };
    }
    return { status: response.status, body: parsed };
  }
}
