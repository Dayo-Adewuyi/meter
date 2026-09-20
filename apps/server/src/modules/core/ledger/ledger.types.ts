import type { AssetCode } from '@meter/contracts';
import type { AccountPurpose, NormalBalance } from './account-taxonomy.ts';

export type EntryDirection = 'debit' | 'credit';

export interface JournalEntryInput {
  readonly accountId: string;
  readonly assetCode: AssetCode;
  readonly direction: EntryDirection;
  readonly amountAtomic: bigint;
}

export interface PostJournalCommand {
  readonly transactionType: string;
  readonly correlationId: string;
  readonly entries: readonly JournalEntryInput[];
  readonly reversalOf?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly event: { readonly type: string; readonly payload: Readonly<Record<string, unknown>> };
}

export interface PostedJournalEntry {
  readonly sequence: number;
  readonly accountId: string;
  readonly assetCode: AssetCode;
  readonly direction: EntryDirection;
  readonly amountAtomic: string;
}

export interface PostedBalance {
  readonly accountId: string;
  readonly postedAmountAtomic: string;
}

export interface PostedJournal {
  readonly transactionId: string;
  readonly correlationId: string;
  readonly entries: readonly PostedJournalEntry[];
  readonly balances: readonly PostedBalance[];
}

/** Every ledger command returns at least this (§10.4). */
export interface LedgerCommandResult {
  readonly transactionId: string;
  readonly correlationId: string;
  readonly amountAtomic: string;
  readonly assetCode: AssetCode;
  readonly replayed: boolean;
}

export interface LedgerAccountRow {
  readonly id: string;
  readonly assetCode: string;
  readonly normalBalance: NormalBalance;
  readonly purpose: AccountPurpose;
  readonly status: string;
}
