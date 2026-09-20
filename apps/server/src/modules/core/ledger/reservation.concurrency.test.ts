import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
} from '../../../platform/database/transaction.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { LedgerError } from './ledger.errors.ts';
import { ReservationService } from './reservation.service.ts';

const PARALLEL = 20;
const EACH = 100n;
const FUNDING = 1_000n;
const AFFORDABLE = Number(FUNDING / EACH);

const isFulfilled = <T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> =>
  result.status === 'fulfilled';
const isRejected = <T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult =>
  result.status === 'rejected';
const hasCode = (code: string) => (result: PromiseRejectedResult) =>
  result.reason instanceof LedgerError && result.reason.code === code;

async function reserveInParallel(
  service: ReservationService,
  fixture: Awaited<ReturnType<typeof createLedgerFixture>>,
) {
  return Promise.allSettled(
    Array.from({ length: PARALLEL }, (_unused, index) =>
      service.reserve({
        idempotencyScope: 'concurrency',
        idempotencyKey: `parallel-${index}`,
        correlationId: randomUUID(),
        availableAccountId: fixture.available,
        reservedAccountId: fixture.reserved,
        assetCode: 'NGN',
        amountAtomic: EACH,
      }),
    ),
  );
}

describe('concurrent reservations', () => {
  it('never overspends one balance under parallel reservations', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db, FUNDING);
      const observed: number[] = [];
      const policy: RetryPolicy = {
        ...DEFAULT_RETRY_POLICY,
        onAttempt: (attempt) => observed.push(attempt),
      };

      const attempts = await reserveInParallel(new ReservationService(db, policy), fixture);

      const successes = attempts.filter(isFulfilled);
      const declines = attempts.filter(isRejected);
      expect(successes).toHaveLength(AFFORDABLE);
      expect(declines).toHaveLength(PARALLEL - AFFORDABLE);
      // Only a business decline reaches the caller. A serialization failure or
      // deadlock is retried internally and must never surface as one.
      expect(declines.every(hasCode('INSUFFICIENT_FUNDS'))).toBe(true);
      expect(declines.every((decline) => (decline.reason as { code?: string }).code !== '40001')).toBe(true);

      await expect(fixture.balance(fixture.available)).resolves.toBe(0n);
      await expect(fixture.balance(fixture.reserved)).resolves.toBe(FUNDING);
      await expect(
        db.selectFrom('ledger.transactions').selectAll().where('transaction_type', '=', 'reserve').execute(),
      ).resolves.toHaveLength(AFFORDABLE);

      // Every operation settled inside the policy's bound.
      expect(Math.max(...observed)).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.attempts);
    });
  }, 300_000);

  it('leaves no journal, claim, reservation, or outbox row behind for a failed attempt', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db, FUNDING);
      // Zero backoff is the hostile case: every retry re-enters immediately.
      const service = new ReservationService(db, {
        ...DEFAULT_RETRY_POLICY,
        baseDelayMs: 0,
        sleep: async () => {},
      });

      const attempts = await reserveInParallel(service, fixture);

      expect(attempts.filter(isFulfilled)).toHaveLength(AFFORDABLE);
      expect(attempts.filter(isRejected).every(hasCode('INSUFFICIENT_FUNDS'))).toBe(true);

      const [journals, claims, reservations, outbox] = await Promise.all([
        db.selectFrom('ledger.transactions').selectAll().where('transaction_type', '=', 'reserve').execute(),
        db.selectFrom('ledger.idempotency').selectAll().where('scope', '=', 'concurrency').execute(),
        db.selectFrom('ledger.reservations').selectAll().execute(),
        db.selectFrom('operations.outbox').selectAll().where('event_type', '=', 'ledger.reserved').execute(),
      ]);

      expect(journals).toHaveLength(AFFORDABLE);
      expect(claims).toHaveLength(AFFORDABLE);
      expect(claims.every((claim) => claim.state === 'completed')).toBe(true);
      expect(reservations).toHaveLength(AFFORDABLE);
      expect(outbox).toHaveLength(AFFORDABLE);
      const totals = await fixture.totals();
      expect(totals.debits).toBe(totals.credits);
    });
  }, 300_000);
});
