import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { DATABASE } from '../../../platform/database/database.module.ts';
import { serializable } from '../../../platform/database/transaction.ts';
import type { DB } from '../../../platform/database/types.ts';
import { LedgerError } from './ledger.errors.ts';
import { acquireLedgerLock } from './post-journal.ts';

@Injectable()
export class RebuildProjectionsService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  /**
   * Maintenance only: recomputes `ledger.balances` from the immutable entries
   * that are the actual source of truth (§10.3).
   *
   * Writes no journal, idempotency claim or outbox event — nothing financial
   * happened, a derived projection was restated. It takes the ledger lock
   * exclusively so no command can post between the zeroing and the replay.
   *
   * `accountCount` is the number of accounts that had entries to replay.
   */
  async rebuild(): Promise<{ accountCount: number }> {
    return serializable(this.db, async (trx) => {
      await acquireLedgerLock(trx, 'exclusive');

      // Accounts with a stale projection and no entries must end at zero.
      await trx.updateTable('ledger.balances').set({ posted_amount: '0' }).execute();

      const rebuilt = await sql<{ account_id: string }>`
        insert into ledger.balances (account_id, posted_amount, version)
        select entries.account_id,
               sum(case when entries.direction = accounts.normal_balance
                        then entries.amount_atomic
                        else -entries.amount_atomic end),
               1
        from ledger.entries as entries
        join ledger.accounts as accounts on accounts.id = entries.account_id
        group by entries.account_id
        on conflict (account_id) do update
          set posted_amount = excluded.posted_amount,
              version = balances.version + 1
        returning account_id
      `.execute(trx);

      const negative = await trx
        .selectFrom('ledger.balances')
        .innerJoin('ledger.accounts', 'ledger.accounts.id', 'ledger.balances.account_id')
        .select('ledger.balances.account_id as account_id')
        .where('ledger.accounts.purpose', '=', 'customer_available')
        .where('ledger.balances.posted_amount', '<', '0')
        .executeTakeFirst();
      if (negative !== undefined) {
        throw new LedgerError('INSUFFICIENT_FUNDS', `rebuild produced a negative available balance`);
      }

      return { accountCount: rebuilt.rows.length };
    });
  }
}
