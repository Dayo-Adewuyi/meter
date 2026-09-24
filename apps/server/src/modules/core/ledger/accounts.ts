import type { Transaction } from 'kysely';
import type { DB } from '../../../platform/database/types.ts';
import { accountDefinition } from './account-taxonomy.ts';

const CUSTOMER_PURPOSES = ['customer_available', 'customer_reserved', 'customer_pending'] as const;

/**
 * Opens a customer's accounts in one asset if they do not exist yet, and
 * returns the pair a reservation needs. Safe to call on every mandate create.
 */
export async function ensureCustomerAccounts(
  trx: Transaction<DB>,
  customerId: string,
  assetCode: string,
): Promise<{ available: string; reserved: string }> {
  await trx
    .insertInto('ledger.accounts')
    .values(
      CUSTOMER_PURPOSES.map((purpose) => ({
        owner_type: 'customer' as const,
        owner_id: customerId,
        customer_id: customerId,
        asset_code: assetCode,
        account_type: purpose,
        account_class: accountDefinition(purpose).accountClass,
        purpose,
        normal_balance: accountDefinition(purpose).normalBalance,
      })),
    )
    .onConflict((conflict) =>
      conflict.columns(['owner_type', 'owner_id', 'asset_code', 'purpose']).doNothing(),
    )
    .execute();

  const rows = await trx
    .selectFrom('ledger.accounts')
    .select(['id', 'purpose'])
    .where('owner_type', '=', 'customer')
    .where('owner_id', '=', customerId)
    .where('asset_code', '=', assetCode)
    .execute();
  const idFor = (purpose: string) => {
    const row = rows.find((candidate) => candidate.purpose === purpose);
    if (row === undefined) throw new Error(`customer ${customerId} has no ${purpose} account`);
    return row.id;
  };
  return { available: idFor('customer_available'), reserved: idFor('customer_reserved') };
}
