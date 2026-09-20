import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../../../platform/database/types.ts';
import { withMigratedDb } from '../../../test/support/database.ts';
import { type LedgerFixture, createLedgerFixture } from '../../../test/support/ledger-fixtures.ts';
import { CreditDebitService } from './credit-debit.service.ts';
import { LedgerError } from './ledger.errors.ts';
import { RefundService } from './refund.service.ts';
import { ReservationService } from './reservation.service.ts';
import { ReversalService } from './reversal.service.ts';

/** Committed seeds keep a counterexample reproducible from CI output alone. */
const SEED = 20260920;
const RUNS = { numRuns: 100, seed: SEED } as const;

/** NUMERIC(38,0) holds up to 10^38 - 1. */
const NUMERIC_MAX = 10n ** 38n - 1n;

/**
 * Every run funds through the one shared external-cash account, so per-run
 * amounts are capped to keep its running total inside NUMERIC(38,0). Even the
 * floor here is twenty orders of magnitude past what a double represents
 * exactly, and the exact ceiling gets its own single-shot test below.
 */
const BOUNDARY_MIN = NUMERIC_MAX / (BigInt(RUNS.numRuns) * 4n);
const BOUNDARY_MAX = NUMERIC_MAX / (BigInt(RUNS.numRuns) * 2n);

function isCode(error: unknown, code: string): boolean {
  return error instanceof LedgerError && error.code === code;
}

interface Services {
  readonly creditDebit: CreditDebitService;
  readonly reservations: ReservationService;
  readonly refunds: RefundService;
  readonly reversals: ReversalService;
}

function servicesFor(db: Kysely<DB>): Services {
  return {
    creditDebit: new CreditDebitService(db),
    reservations: new ReservationService(db),
    refunds: new RefundService(db),
    reversals: new ReversalService(db),
  };
}

async function fundedLedger(db: Kysely<DB>, funding: bigint): Promise<LedgerFixture> {
  return createLedgerFixture(db, funding);
}

/**
 * Reserve as much of each request as the balance allows, capture half of it and
 * release the rest. Declines are expected outcomes, not failures.
 */
async function runCappedSequence(
  services: Services,
  fixture: LedgerFixture,
  requests: readonly bigint[],
): Promise<void> {
  for (const [index, amount] of requests.entries()) {
    const scope = `property-${fixture.customerId}`;
    let reservationId: string;
    try {
      const reserved = await services.reservations.reserve({
        idempotencyScope: scope,
        idempotencyKey: `reserve-${index}`,
        correlationId: randomUUID(),
        availableAccountId: fixture.available,
        reservedAccountId: fixture.reserved,
        assetCode: 'NGN',
        amountAtomic: amount,
      });
      reservationId = reserved.reservationId;
    } catch (error) {
      if (isCode(error, 'INSUFFICIENT_FUNDS')) continue;
      throw error;
    }

    const capture = amount / 2n;
    if (capture > 0n) {
      await services.reservations.capture({
        idempotencyScope: scope,
        idempotencyKey: `capture-${index}`,
        correlationId: randomUUID(),
        reservationId,
        destinationAccountId: fixture.payable,
        amountAtomic: capture,
      });
    }
    await services.reservations.release({
      idempotencyScope: scope,
      idempotencyKey: `release-${index}`,
      correlationId: randomUUID(),
      reservationId,
    });
  }
}

describe(`ledger invariants (seed ${SEED})`, () => {
  it('conserves value across generated reserve/capture/release sequences', async () => {
    await withMigratedDb(async (db) => {
      const services = servicesFor(db);

      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: 1_000_000n }),
          fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 20 }),
          async (funding, requests) => {
            const fixture = await fundedLedger(db, funding);
            await runCappedSequence(services, fixture, requests);

            const [available, reserved, capturedNet, totals] = await Promise.all([
              fixture.balance(fixture.available),
              fixture.balance(fixture.reserved),
              fixture.balance(fixture.payable),
              fixture.totals(),
            ]);

            expect(totals.debits).toEqual(totals.credits);
            expect(available + reserved + capturedNet).toEqual(funding);
            expect(available).toBeGreaterThanOrEqual(0n);
            expect(reserved).toBeGreaterThanOrEqual(0n);
          },
        ),
        RUNS,
      );
    });
  }, 600_000);

  it('keeps atomic arithmetic exact at NUMERIC(38,0) boundaries', async () => {
    await withMigratedDb(async (db) => {
      const services = servicesFor(db);

      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: BOUNDARY_MIN, max: BOUNDARY_MAX }),
          fc.bigInt({ min: 1n, max: 1_000_000_000_000_000_000_000n }),
          async (funding, spend) => {
            const debited = spend > funding ? funding : spend;
            const fixture = await fundedLedger(db, funding);
            const scope = `boundary-${fixture.customerId}`;

            const result = await services.creditDebit.debit({
              idempotencyScope: scope,
              idempotencyKey: 'debit',
              correlationId: randomUUID(),
              availableAccountId: fixture.available,
              assetCode: 'NGN',
              amountAtomic: debited,
            });

            // Decimal strings in, decimal strings out: no double ever sees this.
            expect(result.amountAtomic).toBe(debited.toString());
            expect(BigInt(result.amountAtomic)).toBe(debited);
            await expect(fixture.balance(fixture.available)).resolves.toBe(funding - debited);

            const stored = await db
              .selectFrom('ledger.balances')
              .select('posted_amount')
              .where('account_id', '=', fixture.available)
              .executeTakeFirstOrThrow();
            expect(stored.posted_amount).toBe((funding - debited).toString());
            expect(stored.posted_amount).not.toContain('e');
          },
        ),
        RUNS,
      );
    });
  }, 600_000);

  it('restores every affected projection when a credit or debit is reversed', async () => {
    await withMigratedDb(async (db) => {
      const services = servicesFor(db);

      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: 1_000_000n }),
          fc.bigInt({ min: 1n, max: 1_000_000n }),
          fc.boolean(),
          async (funding, amount, reverseTheDebit) => {
            const fixture = await fundedLedger(db, funding);
            const scope = `reverse-${fixture.customerId}`;
            const before = {
              available: await fixture.balance(fixture.available),
              cash: await fixture.balance(fixture.externalCash),
            };

            const command = {
              idempotencyScope: scope,
              idempotencyKey: 'command',
              correlationId: randomUUID(),
              availableAccountId: fixture.available,
              assetCode: 'NGN' as const,
              amountAtomic: reverseTheDebit && amount > funding ? funding : amount,
            };
            const posted = reverseTheDebit
              ? await services.creditDebit.debit(command)
              : await services.creditDebit.credit(command);

            const originalEntries = await db
              .selectFrom('ledger.entries')
              .selectAll()
              .where('transaction_id', '=', posted.transactionId)
              .orderBy('sequence')
              .execute();

            await services.reversals.reverse({
              idempotencyScope: scope,
              idempotencyKey: 'reverse',
              correlationId: randomUUID(),
              transactionId: posted.transactionId,
              reason: 'property',
            });

            await expect(fixture.balance(fixture.available)).resolves.toBe(before.available);
            await expect(fixture.balance(fixture.externalCash)).resolves.toBe(before.cash);
            await expect(
              db.selectFrom('ledger.entries').selectAll().where('transaction_id', '=', posted.transactionId).orderBy('sequence').execute(),
            ).resolves.toEqual(originalEntries);
          },
        ),
        RUNS,
      );
    });
  }, 600_000);

  it('holds the largest representable amount without rounding it', async () => {
    await withMigratedDb(async (db) => {
      const fixture = await createLedgerFixture(db, NUMERIC_MAX);
      const spend = NUMERIC_MAX - 1n;

      const result = await new CreditDebitService(db).debit({
        idempotencyScope: 'ceiling',
        idempotencyKey: 'debit',
        correlationId: randomUUID(),
        availableAccountId: fixture.available,
        assetCode: 'NGN',
        amountAtomic: spend,
      });

      expect(result.amountAtomic).toBe(spend.toString());
      await expect(fixture.balance(fixture.available)).resolves.toBe(1n);
      const stored = await db
        .selectFrom('ledger.balances')
        .select('posted_amount')
        .where('account_id', '=', fixture.externalCash)
        .executeTakeFirstOrThrow();
      expect(stored.posted_amount).toBe('1');
    });
  }, 120_000);
});
