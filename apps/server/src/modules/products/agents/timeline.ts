import { ASSETS, type AssetCode, fromAtomic } from '@meter/contracts';
import type { Kysely } from 'kysely';
import type { DB, JsonValue } from '../../../platform/database/types.ts';

export interface TimelineEntry {
  readonly at: string;
  readonly kind: 'decision' | 'ledger' | 'provider' | 'purchase';
  readonly summary: string;
  readonly detail: Record<string, JsonValue>;
}

export interface Timeline {
  readonly purchase_id: string;
  readonly owner_id: string;
  readonly correlation_id: string;
  readonly entries: readonly TimelineEntry[];
}

const LEDGER_MOVES: Record<string, string> = {
  reserve: 'available → reserved',
  capture: 'reserved → provider_payable',
  release: 'reserved → available',
};

/**
 * "Which agent bought what, and why" (agent-mandates §9.4): one ordered list
 * from the decision, the purchase events and the journals they reference.
 * Decorator-free so `demo:timeline` can run it without Nest.
 */
export async function buildTimeline(db: Kysely<DB>, purchaseId: string): Promise<Timeline | null> {
  const purchase = await db
    .selectFrom('agents.purchases as p')
    .innerJoin('authz.agent_credentials as c', 'c.id', 'p.credential_id')
    .innerJoin('authz.mandates as m', 'm.id', 'c.mandate_id')
    .select(['p.id', 'p.decision_id', 'p.correlation_id', 'p.intent', 'p.asset_code', 'p.amount', 'p.network', 'p.destination', 'c.public_id', 'm.owner_id'])
    .where('p.id', '=', purchaseId)
    .executeTakeFirst();
  if (purchase === undefined) return null;
  const asset = ASSETS[purchase.asset_code as AssetCode];
  const money = (atomic: string | bigint) => `₦${fromAtomic(BigInt(atomic), asset)}`;
  const agent = `agent:mtr_agt_${purchase.public_id.slice(0, 3).toUpperCase()}…`;

  const decision = await db.selectFrom('authz.decisions').selectAll().where('id', '=', purchase.decision_id).executeTakeFirstOrThrow();
  const events = await db.selectFrom('agents.purchase_events').selectAll().where('purchase_id', '=', purchaseId).orderBy('id').execute();
  const journalIds = events.flatMap((event) => (event.ledger_transaction_id === null ? [] : [event.ledger_transaction_id]));
  const journals = journalIds.length === 0
    ? []
    : await db
        .selectFrom('ledger.transactions as t')
        .innerJoin('ledger.entries as e', 'e.transaction_id', 't.id')
        .select(['t.id', 't.transaction_type', 't.created_at', 'e.amount_atomic'])
        .where('t.id', 'in', journalIds)
        .where('e.direction', '=', 'debit')
        .execute();

  const evaluated = decision.evaluated as { checks: { check: string; passed: boolean }[] };
  const entries: TimelineEntry[] = [
    {
      at: decision.created_at.toISOString(),
      kind: 'decision',
      summary: `${decision.outcome.padEnd(11)} ${agent}  intent=${JSON.stringify(purchase.intent)}${decision.reason_code === null ? '' : `  code=${decision.reason_code}`}`,
      detail: {
        decision_id: decision.id,
        outcome: decision.outcome,
        reason_code: decision.reason_code,
        checks: evaluated.checks.map((c) => `${c.check} ${c.passed ? '✓' : '✗'}`).join(' '),
        request: `${money(purchase.amount)} ${purchase.network} ${purchase.destination.slice(0, 7)}****${purchase.destination.slice(-3)}`,
      },
    },
  ];

  for (const event of events) {
    const at = event.created_at.toISOString();
    const detail = event.detail as { provider?: Record<string, JsonValue> };
    if (detail.provider !== undefined) {
      const p = detail.provider;
      const extra = [p.reason === undefined ? '' : ` (${String(p.reason)})`, p.code === undefined ? '' : ` code=${String(p.code)}`, p.provider_reference === undefined ? '' : `  ref=${String(p.provider_reference)}`].join('');
      entries.push({ at, kind: 'provider', summary: `${String(p.call)} → ${String(p.kind)}${extra}`, detail: p });
    }
    const journal = journals.find((j) => j.id === event.ledger_transaction_id);
    if (journal !== undefined) {
      entries.push({
        at,
        kind: 'ledger',
        summary: `${journal.transaction_type.padEnd(11)} ${money(journal.amount_atomic)}  ${LEDGER_MOVES[journal.transaction_type] ?? ''}  txn ${journal.id.slice(0, 4)}…`,
        detail: { transaction_id: journal.id, type: journal.transaction_type, amount: fromAtomic(BigInt(journal.amount_atomic), asset) },
      });
    }
    if (event.from_status !== event.to_status) {
      entries.push({
        at,
        kind: 'purchase',
        summary: `${event.from_status ?? '∅'} → ${event.to_status}`.padEnd(45) + `${event.actor.startsWith('agent:') ? agent : event.actor}  ${event.reason}`,
        detail: { from: event.from_status, to: event.to_status, actor: event.actor, reason: event.reason, ...(event.detail as Record<string, JsonValue>) },
      });
    }
  }

  return { purchase_id: purchase.id, owner_id: purchase.owner_id, correlation_id: purchase.correlation_id, entries };
}

export function renderTimeline(timeline: Timeline): string {
  const time = (iso: string) => new Date(iso).toISOString().slice(11, 23);
  return [
    `purchase ${timeline.purchase_id}  correlation ${timeline.correlation_id}`,
    ...timeline.entries.flatMap((entry) => {
      const line = `${time(entry.at)}  ${entry.kind.padEnd(9)}  ${entry.summary}`;
      return entry.kind === 'decision' ? [line, `${' '.repeat(25)}checks: ${String(entry.detail.checks)}`] : [line];
    }),
  ].join('\n');
}
