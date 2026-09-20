import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations, withTestDatabase } from '@meter/testing';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../../test/support/database.ts';

const SYSTEM_OWNER_ID = '00000000-0000-0000-0000-000000000000';

type AccountValues = {
  account_class?: string;
  account_type?: string;
  asset_code?: string;
  customer_id?: string | null;
  id?: string;
  normal_balance?: string;
  owner_id?: string;
  owner_type?: string;
  purpose?: string;
};

// The cast is the point: these rows are deliberately invalid, and the database
// — not TypeScript — must be the thing that rejects them.
function insertAccount(db: ReturnType<typeof testDb>, values: AccountValues = {}) {
  return db
    .insertInto('ledger.accounts')
    .values({
      id: randomUUID(),
      owner_type: 'system',
      owner_id: SYSTEM_OWNER_ID,
      asset_code: 'NGN',
      account_type: 'external_cash',
      account_class: 'asset',
      purpose: 'external_cash',
      normal_balance: 'debit',
      customer_id: null,
      ...values,
    } as never)
    .execute();
}

describe('ledger account taxonomy migration', () => {
  it('seeds every system account and rejects an invalid purpose', async () => {
    await withTestDatabase(async (databaseUrl) => {
      const db = testDb(databaseUrl);

      try {
        await runMigrations(databaseUrl, resolve(import.meta.dirname, '../../../../../..', 'database', 'migrations'));

        const rows = await db
          .selectFrom('ledger.accounts')
          .select(['account_class', 'purpose', 'asset_code', 'normal_balance'])
          .where('owner_type', '=', 'system')
          .orderBy('purpose')
          .execute();

        expect(rows.map((row) => row.purpose)).toEqual([
          'external_cash',
          'meter_revenue',
          'provider_payable',
          'reserve',
          'tax_liability',
        ]);
        expect(rows).toEqual([
          { account_class: 'asset', purpose: 'external_cash', asset_code: 'NGN', normal_balance: 'debit' },
          { account_class: 'revenue', purpose: 'meter_revenue', asset_code: 'NGN', normal_balance: 'credit' },
          {
            account_class: 'provider_liability',
            purpose: 'provider_payable',
            asset_code: 'NGN',
            normal_balance: 'credit',
          },
          { account_class: 'reserve', purpose: 'reserve', asset_code: 'NGN', normal_balance: 'debit' },
          {
            account_class: 'tax_liability',
            purpose: 'tax_liability',
            asset_code: 'NGN',
            normal_balance: 'credit',
          },
        ]);

        await expect(insertAccount(db, { purpose: 'mystery' })).rejects.toMatchObject({ code: '23514' });
        await expect(
          insertAccount(db, {
            owner_type: 'provider',
            owner_id: randomUUID(),
            account_class: 'revenue',
          }),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await db.destroy();
      }
    });
  }, 30_000);

  it('requires customer accounts to reference their internal owner and prevents system or provider impersonation', async () => {
    await withTestDatabase(async (databaseUrl) => {
      const db = testDb(databaseUrl);

      try {
        await runMigrations(databaseUrl, resolve(import.meta.dirname, '../../../../../..', 'database', 'migrations'));

        const missingCustomerId = randomUUID();
        await expect(
          insertAccount(db, {
            owner_type: 'customer',
            owner_id: missingCustomerId,
            customer_id: missingCustomerId,
            account_type: 'customer_available',
            account_class: 'customer_liability',
            purpose: 'customer_available',
            normal_balance: 'credit',
          }),
        ).rejects.toMatchObject({ code: '23503' });

        const customer = await db
          .insertInto('identity.users')
          .values({ status: 'active', roles: ['customer'] })
          .returning('id')
          .executeTakeFirstOrThrow();

        await expect(
          insertAccount(db, {
            owner_type: 'customer',
            owner_id: customer.id,
            customer_id: customer.id,
            account_type: 'customer_available',
            account_class: 'customer_liability',
            purpose: 'customer_available',
            normal_balance: 'credit',
          }),
        ).resolves.toBeDefined();
        await expect(insertAccount(db, { customer_id: customer.id })).rejects.toMatchObject({ code: '23514' });
        await expect(
          insertAccount(db, { owner_type: 'provider', owner_id: randomUUID(), customer_id: customer.id }),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          insertAccount(db, {
            owner_type: 'customer',
            owner_id: customer.id,
            customer_id: customer.id,
            account_type: 'meter_revenue',
            account_class: 'revenue',
            purpose: 'meter_revenue',
            normal_balance: 'credit',
          }),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await db.destroy();
      }
    });
  }, 30_000);

  it('requires every ledger entry asset to match its account asset', async () => {
    await withTestDatabase(async (databaseUrl) => {
      const db = testDb(databaseUrl);

      try {
        await runMigrations(databaseUrl, resolve(import.meta.dirname, '../../../../../..', 'database', 'migrations'));

        const account = await db
          .selectFrom('ledger.accounts')
          .select(['id'])
          .where('purpose', '=', 'external_cash')
          .executeTakeFirstOrThrow();
        const transaction = await db
          .insertInto('ledger.transactions')
          .values({
            transaction_type: 'test',
            correlation_id: randomUUID(),
            state: 'posted',
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await expect(
          db
            .insertInto('ledger.entries')
            .values({
              transaction_id: transaction.id,
              sequence: 1,
              account_id: account.id,
              direction: 'debit',
              amount_atomic: '1',
              asset_code: 'USD',
            })
            .execute(),
        ).rejects.toMatchObject({ code: '23503' });
      } finally {
        await db.destroy();
      }
    });
  }, 30_000);
});
