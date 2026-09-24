import { ASSETS, fromAtomic } from '@meter/contracts';
import type { Kysely } from 'kysely';
import type { DB, JsonValue } from '../../../../platform/database/types.ts';
import type { TimelineEntry } from '../timeline.ts';

const MOVES: Record<string, string> = {
  reserve: 'available → reserved',
  capture: 'reserved → provider_payable',
  release: 'reserved → available',
};

/** The chronicle of one x402 payment: decision, signature, chain evidence, journals. */
export async function buildX402Timeline(db: Kysely<DB>, paymentId: string) {
  const payment = await db
    .selectFrom('agents.x402_payments as p')
    .innerJoin('authz.agent_credentials as c', 'c.id', 'p.credential_id')
    .innerJoin('authz.mandates as m', 'm.id', 'c.mandate_id')
    .selectAll('p')
    .select(['c.label', 'm.owner_id'])
    .where('p.id', '=', paymentId)
    .executeTakeFirst();
  if (payment === undefined) return null;
  const money = (atomic: string | bigint) => `${fromAtomic(BigInt(atomic), ASSETS.USDC)} USDC`;
  const decision = await db.selectFrom('authz.decisions').selectAll().where('id', '=', payment.decision_id).executeTakeFirstOrThrow();
  const events = await db.selectFrom('agents.x402_payment_events').selectAll().where('payment_id', '=', paymentId).orderBy('id').execute();
  const journalIds = events.flatMap((e) => (e.ledger_transaction_id === null ? [] : [e.ledger_transaction_id]));
  const journals = journalIds.length === 0
    ? []
    : await db
        .selectFrom('ledger.transactions as t')
        .innerJoin('ledger.entries as e', 'e.transaction_id', 't.id')
        .select(['t.id', 't.transaction_type', 'e.amount_atomic'])
        .where('t.id', 'in', journalIds)
        .where('e.direction', '=', 'debit')
        .execute();

  const evaluated = decision.evaluated as { checks: { check: string; passed: boolean }[] };
  const entries: TimelineEntry[] = [
    {
      at: decision.created_at.toISOString(),
      kind: 'decision',
      summary: `${decision.outcome}${decision.reason_code === null ? '' : ` ${decision.reason_code}`}`,
      detail: { outcome: decision.outcome, reason_code: decision.reason_code, checks: evaluated.checks.map((c) => `${c.check} ${c.passed ? '✓' : '✗'}`).join(' ') },
    },
  ];
  for (const event of events) {
    const at = event.created_at.toISOString();
    const detail = event.detail as Record<string, JsonValue>;
    if (event.reason === 'settlement_hint') {
      entries.push({ at, kind: 'provider', summary: 'agent reported a PAYMENT-RESPONSE (a hint; the chain decides)', detail: { call: 'hint', kind: 'reported' } });
    } else if (event.to_state === 'settled') {
      entries.push({ at, kind: 'provider', summary: `AuthorizationUsed at block ${String(detail.block ?? '—')}`, detail: { call: 'chain', kind: 'used', provider_reference: detail.transaction ?? null } });
    } else if (event.to_state === 'lapsed') {
      entries.push({ at, kind: 'provider', summary: 'validBefore passed at the safe head; nonce never used', detail: { call: 'chain', kind: 'expired unused' } });
    }
    // Cause before effect: the chain's evidence, then the journal it justified.
    const journal = journals.find((j) => j.id === event.ledger_transaction_id);
    if (journal !== undefined) {
      entries.push({ at, kind: 'ledger', summary: `${journal.transaction_type} ${money(journal.amount_atomic)} ${MOVES[journal.transaction_type] ?? ''}`, detail: { type: journal.transaction_type, amount: fromAtomic(BigInt(journal.amount_atomic), ASSETS.USDC), move: MOVES[journal.transaction_type] ?? '' } });
    }
    if (event.from_state !== event.to_state && event.reason !== 'settlement_hint') {
      entries.push({ at, kind: 'purchase', summary: `${event.from_state ?? '∅'} → ${event.to_state}`, detail: { from: event.from_state, to: event.to_state, actor: event.actor, reason: event.reason } });
    }
  }
  return {
    purchase_id: payment.id,
    owner_id: payment.owner_id,
    correlation_id: payment.correlation_id,
    purchase: {
      amount: fromAtomic(BigInt(payment.amount), ASSETS.USDC),
      asset: 'USDC',
      network: payment.network,
      destination: payment.resource_url,
      intent: payment.intent,
      delivery_status: payment.state,
      credential_label: payment.label,
      created_at: payment.created_at.toISOString(),
      pay_to: payment.pay_to,
      nonce: payment.auth_nonce,
      valid_before: payment.valid_before === null ? null : new Date(Number(payment.valid_before) * 1000).toISOString(),
      settlement_tx: payment.settlement_tx,
    },
    entries,
  };
}
