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

/** The account columns every command needs, as selected and row-locked. */
export interface LockedAccount {
  readonly id: string;
  readonly asset_code: string;
  readonly normal_balance: NormalBalance;
  readonly purpose: AccountPurpose;
  readonly status: string;
  readonly customer_id: string | null;
}

/** A credit or a controlled debit of a customer's available value. */
export interface LedgerAmountCommand {
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly availableAccountId: string;
  readonly assetCode: AssetCode;
  readonly amountAtomic: bigint;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ReservationState = 'open' | 'partially_captured' | 'captured' | 'released';

export interface ReserveCommand {
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly availableAccountId: string;
  readonly reservedAccountId: string;
  readonly assetCode: AssetCode;
  readonly amountAtomic: bigint;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReservationResult {
  readonly reservationId: string;
  readonly transactionId: string;
  readonly correlationId: string;
  readonly assetCode: AssetCode;
  readonly originalAmountAtomic: string;
  readonly capturedAmountAtomic: string;
  readonly releasedAmountAtomic: string;
  readonly remainingAmountAtomic: string;
  readonly state: ReservationState;
  readonly replayed: boolean;
}

export interface CaptureCommand {
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly reservationId: string;
  readonly destinationAccountId: string;
  readonly amountAtomic: bigint;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CaptureResult {
  readonly transactionId: string;
  readonly correlationId: string;
  readonly reservationId: string;
  readonly assetCode: AssetCode;
  /** What the caller asked for, kept even when the ceiling reduced it. */
  readonly requestedAmountAtomic: string;
  readonly capturedAmountAtomic: string;
  readonly remainingAmountAtomic: string;
  readonly capped: boolean;
  readonly state: ReservationState;
  readonly replayed: boolean;
}

/**
 * Release takes no amount on purpose: it always returns everything still held,
 * so no reservation can strand a residue that nobody can reach.
 */
export interface ReleaseCommand {
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly reservationId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReleaseResult {
  readonly transactionId: string;
  readonly correlationId: string;
  readonly reservationId: string;
  readonly assetCode: AssetCode;
  readonly releasedAmountAtomic: string;
  readonly state: ReservationState;
  readonly replayed: boolean;
}

export interface ReverseCommand {
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly transactionId: string;
  readonly reason: string;
}
