import { ApiError, type MeterClient } from './types';

type TokenSource = () => Promise<string | null>;

/** The live client: Meter's owner API with a Clerk session token. No cookies cross origins. */
export function httpClient(baseUrl: string, getToken: TokenSource): MeterClient {
  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const token = await getToken();
    const response = await fetch(new URL(`/v1${path}`, baseUrl), {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const json = text.length === 0 ? {} : JSON.parse(text);
    if (!response.ok) {
      const error = json.error ?? json;
      throw new ApiError(error.code ?? `HTTP_${response.status}`, error.message ?? 'The request failed.', error.issues ?? []);
    }
    return json as T;
  }

  return {
    balance: () => request('GET', '/balance'),
    credit: async (amount) => {
      await request('POST', '/sandbox/credit', { amount }, { 'idempotency-key': crypto.randomUUID() });
    },
    mandates: async () => (await request<{ mandates: MeterClient['mandates'] extends () => Promise<infer M> ? M : never }>('GET', '/mandates')).mandates,
    mandate: (id) => request('GET', `/mandates/${id}`),
    createMandate: (input) => request('POST', '/mandates', input),
    revokeMandate: async (id, reason) => {
      await request('POST', `/mandates/${id}/revoke`, { reason });
    },
    issueCredential: (mandateId, label) => request('POST', `/mandates/${mandateId}/credentials`, { label }),
    revokeCredential: async (id) => {
      await request('POST', `/credentials/${id}/revoke`);
    },
    purchases: async (mandateId) =>
      (await request<{ purchases: Awaited<ReturnType<MeterClient['purchases']>> }>('GET', `/mandates/${mandateId}/purchases?limit=50`)).purchases,
    timeline: (purchaseId) => request('GET', `/purchases/${purchaseId}/timeline`),
    x402Payments: async (mandateId) =>
      (await request<{ payments: Awaited<ReturnType<MeterClient['x402Payments']>> }>('GET', `/mandates/${mandateId}/x402-payments?limit=50`)).payments,
    x402Timeline: (paymentId) => request('GET', `/x402/payments/${paymentId}/timeline`),
  };
}
