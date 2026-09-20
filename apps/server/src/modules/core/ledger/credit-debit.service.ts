import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { DATABASE } from '../../../platform/database/database.module.ts';
import {
  DEFAULT_RETRY_POLICY,
  RETRY_POLICY,
  type RetryPolicy,
  serializable,
} from '../../../platform/database/transaction.ts';
import type { DB } from '../../../platform/database/types.ts';
import { executeIdempotent } from './idempotency.ts';
import { LedgerError } from './ledger.errors.ts';
import type { JournalEntryInput, LedgerAmountCommand, LedgerCommandResult } from './ledger.types.ts';
import { acquireLedgerLock, lockAccounts, postJournal } from './post-journal.ts';

type Direction = 'credit' | 'debit';

@Injectable()
export class CreditDebitService {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Optional() @Inject(RETRY_POLICY) private readonly retry: RetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  /** Money entering Meter: debit external cash, credit the customer. */
  credit(command: LedgerAmountCommand): Promise<LedgerCommandResult> {
    return this.run('credit', command);
  }

  /** Money leaving Meter, never below zero: debit the customer, credit cash. */
  debit(command: LedgerAmountCommand): Promise<LedgerCommandResult> {
    return this.run('debit', command);
  }

  private async run(kind: Direction, command: LedgerAmountCommand): Promise<LedgerCommandResult> {
    if (command.amountAtomic <= 0n) {
      throw new LedgerError('INVALID_ENTRY_AMOUNT', 'amount must be positive');
    }

    return serializable(this.db, async (trx) => {
      await acquireLedgerLock(trx);
      const { result, replayed } = await executeIdempotent(
        trx,
        {
          scope: command.idempotencyScope,
          key: command.idempotencyKey,
          // Only the money-defining fields: a retry may carry a new correlation
          // id or new metadata and is still the same command.
          request: {
            kind,
            availableAccountId: command.availableAccountId,
            assetCode: command.assetCode,
            amountAtomic: command.amountAtomic,
          },
        },
        () => this.post(trx, kind, command),
      );
      return { ...result, replayed };
    }, this.retry);
  }

  private async post(
    trx: Transaction<DB>,
    kind: Direction,
    command: LedgerAmountCommand,
  ): Promise<Omit<LedgerCommandResult, 'replayed'>> {
    const cashAccountId = await externalCashAccountId(trx, command.assetCode);

    // Lock both accounts in the order postJournal will, then read the
    // projection: nothing can spend the same balance between check and post.
    const accounts = await lockAccounts(trx, [command.availableAccountId, cashAccountId]);
    const available = accounts.find((account) => account.id === command.availableAccountId);
    if (available?.purpose !== 'customer_available') {
      throw new LedgerError('INVALID_ACCOUNT_ROLE', 'not a customer available account');
    }

    if (kind === 'debit') {
      const balance = await postedAmount(trx, command.availableAccountId);
      if (balance < command.amountAtomic) {
        throw new LedgerError('INSUFFICIENT_FUNDS', command.availableAccountId);
      }
    }

    const entry = (accountId: string, direction: 'debit' | 'credit'): JournalEntryInput => ({
      accountId,
      assetCode: command.assetCode,
      direction,
      amountAtomic: command.amountAtomic,
    });
    const entries =
      kind === 'credit'
        ? [entry(cashAccountId, 'debit'), entry(command.availableAccountId, 'credit')]
        : [entry(command.availableAccountId, 'debit'), entry(cashAccountId, 'credit')];

    const posted = await postJournal(trx, {
      transactionType: kind,
      correlationId: command.correlationId,
      entries,
      ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
      event: {
        type: kind === 'credit' ? 'ledger.credited' : 'ledger.debited',
        payload: {
          accountId: command.availableAccountId,
          assetCode: command.assetCode,
          amountAtomic: command.amountAtomic.toString(),
        },
      },
    });

    return {
      transactionId: posted.transactionId,
      correlationId: posted.correlationId,
      amountAtomic: command.amountAtomic.toString(),
      assetCode: command.assetCode,
    };
  }
}

export async function externalCashAccountId(
  trx: Transaction<DB>,
  assetCode: string,
): Promise<string> {
  const account = await trx
    .selectFrom('ledger.accounts')
    .select('id')
    .where('owner_type', '=', 'system')
    .where('purpose', '=', 'external_cash')
    .where('asset_code', '=', assetCode)
    .executeTakeFirst();
  if (account === undefined) {
    throw new LedgerError('ACCOUNT_NOT_FOUND', `no external cash account for ${assetCode}`);
  }
  return account.id;
}

export async function postedAmount(trx: Transaction<DB>, accountId: string): Promise<bigint> {
  const balance = await trx
    .selectFrom('ledger.balances')
    .select('posted_amount')
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  return BigInt(balance?.posted_amount ?? '0');
}
