import type { Transaction } from 'kysely';
import type { DB } from '../../../platform/database/types.ts';
import { canonicalJson, digestRequest } from './canonical-request.ts';
import { LedgerError } from './ledger.errors.ts';

export interface IdempotencyClaim {
  readonly scope: string;
  readonly key: string;
  readonly request: unknown;
}

export interface IdempotentOutcome<T> {
  readonly result: T;
  /** False on the run that did the work, true when a stored result was read. */
  readonly replayed: boolean;
}

/**
 * Runs `operation` at most once per (scope, key) (§10.4).
 *
 * Must be called inside the same SERIALIZABLE transaction as the work it
 * guards: claim, work and completion commit together or not at all.
 */
export async function executeIdempotent<T extends { readonly transactionId?: string }>(
  trx: Transaction<DB>,
  claim: IdempotencyClaim,
  operation: () => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  const requestDigest = digestRequest(claim.request);

  await trx
    .insertInto('ledger.idempotency')
    .values({ scope: claim.scope, key: claim.key, request_digest: requestDigest })
    .onConflict((conflict) => conflict.columns(['scope', 'key']).doNothing())
    .execute();

  const claimed = await trx
    .selectFrom('ledger.idempotency')
    .selectAll()
    .where('scope', '=', claim.scope)
    .where('key', '=', claim.key)
    .forUpdate()
    .executeTakeFirstOrThrow();

  // Same key, different request: the caller has a bug, not a retry.
  if (claimed.request_digest !== requestDigest) throw new LedgerError('IDEMPOTENCY_CONFLICT');
  if (claimed.state === 'completed') return { result: claimed.result as T, replayed: true };

  const result = await operation();
  await trx
    .updateTable('ledger.idempotency')
    .set({
      state: 'completed',
      result: canonicalJson(result),
      transaction_id: result.transactionId ?? null,
      completed_at: new Date(),
    })
    .where('scope', '=', claim.scope)
    .where('key', '=', claim.key)
    .execute();

  return { result, replayed: false };
}
