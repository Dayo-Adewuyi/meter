import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { SYSTEM_ACCOUNT_IDS } from '../../modules/core/ledger/account-taxonomy.ts';
import { postJournal } from '../../modules/core/ledger/post-journal.ts';
import { serializable } from '../../platform/database/transaction.ts';
import type { DB } from '../../platform/database/types.ts';

export interface LedgerFixture {
  readonly customerId: string;
  readonly available: string;
  readonly reserved: string;
  readonly pending: string;
  readonly externalCash: string;
  readonly payable: string;
  readonly revenue: string;
  readonly assetCode: 'NGN';
  balance(accountId: string): Promise<bigint>;
  /** Trial balance across every account: debits must equal credits. */
  totals(): Promise<{ debits: bigint; credits: bigint }>;
}

/**
 * One customer with their three NGN accounts, optionally funded through a real
 * credit journal so fixtures exercise the same primitive production uses.
 */
export async function createLedgerFixture(
  db: Kysely<DB>,
  initialAvailable = 0n,
): Promise<LedgerFixture> {
  const customer = await db
    .insertInto('identity.users')
    .values({ status: 'active', roles: ['customer'] })
    .returning('id')
    .executeTakeFirstOrThrow();

  const accounts = await db
    .insertInto('ledger.accounts')
    .values(
      (['customer_available', 'customer_reserved', 'customer_pending'] as const).map((purpose) => ({
        id: randomUUID(),
        owner_type: 'customer' as const,
        owner_id: customer.id,
        customer_id: customer.id,
        asset_code: 'NGN',
        account_type: purpose,
        account_class: 'customer_liability' as const,
        purpose,
        normal_balance: 'credit' as const,
      })),
    )
    .returning(['id', 'purpose'])
    .execute();

  const idFor = (purpose: string): string => {
    const account = accounts.find((row) => row.purpose === purpose);
    if (account === undefined) throw new Error(`fixture is missing ${purpose}`);
    return account.id;
  };

  const fixture: LedgerFixture = {
    customerId: customer.id,
    available: idFor('customer_available'),
    reserved: idFor('customer_reserved'),
    pending: idFor('customer_pending'),
    externalCash: SYSTEM_ACCOUNT_IDS.external_cash,
    payable: SYSTEM_ACCOUNT_IDS.provider_payable,
    revenue: SYSTEM_ACCOUNT_IDS.meter_revenue,
    assetCode: 'NGN',

    async balance(accountId) {
      const row = await db
        .selectFrom('ledger.balances')
        .select('posted_amount')
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return BigInt(row?.posted_amount ?? '0');
    },

    async totals() {
      const rows = await db
        .selectFrom('ledger.entries')
        .select(['direction', 'amount_atomic'])
        .execute();
      let debits = 0n;
      let credits = 0n;
      for (const row of rows) {
        if (row.direction === 'debit') debits += BigInt(row.amount_atomic);
        else credits += BigInt(row.amount_atomic);
      }
      return { debits, credits };
    },
  };

  if (initialAvailable > 0n) {
    await serializable(db, (trx) =>
      postJournal(trx, {
        transactionType: 'fixture_funding',
        correlationId: randomUUID(),
        entries: [
          {
            accountId: fixture.externalCash,
            assetCode: 'NGN',
            direction: 'debit',
            amountAtomic: initialAvailable,
          },
          {
            accountId: fixture.available,
            assetCode: 'NGN',
            direction: 'credit',
            amountAtomic: initialAvailable,
          },
        ],
        event: { type: 'ledger.fixture_funded', payload: { amount: initialAvailable.toString() } },
      }),
    );
  }

  return fixture;
}
