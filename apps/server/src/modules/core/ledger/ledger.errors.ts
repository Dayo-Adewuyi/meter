/**
 * Stable financial error codes (§10.6). Callers branch on `code`; messages are
 * for humans and may change.
 */
export const LEDGER_ERROR_CODES = [
  'IDEMPOTENCY_CONFLICT',
  'UNBALANCED_JOURNAL',
  'INVALID_ENTRY_AMOUNT',
  'ASSET_MISMATCH',
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_INACTIVE',
  'INSUFFICIENT_FUNDS',
  'RESERVATION_NOT_FOUND',
  'RESERVATION_EXHAUSTED',
  'CAPTURE_NOT_FOUND',
  'REFUND_CEILING_EXCEEDED',
  'INVALID_ACCOUNT_ROLE',
  'TRANSACTION_NOT_FOUND',
  'NON_REVERSIBLE_TRANSACTION',
  'ALREADY_REVERSED',
] as const;

export type LedgerErrorCode = (typeof LEDGER_ERROR_CODES)[number];

export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'LedgerError';
  }
}
