// Usage: METER_AGENT_CREDENTIAL=mtr_agt_… pnpm demo:concurrency [count]  (agent-mandates §15 step 6)
// Fires N parallel ₦500 purchases at the agent API and shows that approvals never exceed the limits.
const baseUrl = process.env.METER_API_URL ?? 'http://localhost:3001';
const credential = process.env.METER_AGENT_CREDENTIAL;
const count = Number(process.argv[2] ?? 20);
if (credential === undefined) {
  console.error('METER_AGENT_CREDENTIAL is required');
  process.exit(1);
}

const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' };
const power = async () => (await fetch(`${baseUrl}/v1/agent/spending-power`, { headers })).json();

console.log('before:', JSON.stringify(await power()));
const results = await Promise.all(
  Array.from({ length: count }, async (_, i) => {
    const response = await fetch(`${baseUrl}/v1/agent/purchases`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({
        category: 'airtime',
        network: 'mtn',
        // Last four 1000+ → the simulator's plain "delivered" path.
        destination: `0803100${1000 + i}`,
        amount: '500.00',
        intent: `concurrency demo ${i + 1}/${count}`,
      }),
    });
    const body = (await response.json()) as { error?: { code: string } };
    return response.status === 202 ? 'APPROVED' : (body.error?.code ?? `HTTP_${response.status}`);
  }),
);

const tally = Object.entries(Object.groupBy(results, (r) => r)).map(([code, rows]) => `${code}=${rows!.length}`);
const approved = results.filter((r) => r === 'APPROVED').length;
console.log(`${count} parallel ₦500 purchases → ${tally.join(' ')}`);
console.log(`approved total ₦${approved * 500}.00`);
console.log('after:', JSON.stringify(await power()));
