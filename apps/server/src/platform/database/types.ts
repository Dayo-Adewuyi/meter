import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type {
  AccountClass,
  AccountPurpose,
  NormalBalance,
} from '../../modules/core/ledger/account-taxonomy.ts';

export type UserStatus = 'active' | 'suspended' | 'deleted';
export type UserRole = 'customer' | 'operator' | 'admin';

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

export interface IdentityUsersTable {
  id: ColumnType<string, string | undefined, never>;
  status: ColumnType<UserStatus, UserStatus | undefined, UserStatus>;
  roles: ColumnType<UserRole[], UserRole[] | undefined, UserRole[]>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface IdentityExternalIdentitiesTable {
  provider: string;
  external_subject: string;
  user_id: string;
  provider_metadata: ColumnType<JsonValue, JsonValue | undefined, JsonValue>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type IdentityUser = Selectable<IdentityUsersTable>;
export type NewIdentityUser = Insertable<IdentityUsersTable>;
export type IdentityUserUpdate = Updateable<IdentityUsersTable>;
export type IdentityExternalIdentity = Selectable<IdentityExternalIdentitiesTable>;
export type NewIdentityExternalIdentity = Insertable<IdentityExternalIdentitiesTable>;
export type IdentityExternalIdentityUpdate = Updateable<IdentityExternalIdentitiesTable>;

export type AccountOwnerType = 'customer' | 'provider' | 'system';

export interface LedgerAccountsTable {
  id: ColumnType<string, string | undefined, never>;
  owner_type: AccountOwnerType;
  owner_id: string;
  asset_code: string;
  account_type: string;
  account_class: AccountClass;
  purpose: AccountPurpose;
  normal_balance: NormalBalance;
  status: ColumnType<string, string | undefined, string>;
  customer_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface LedgerTransactionsTable {
  id: ColumnType<string, string | undefined, never>;
  transaction_type: string;
  idempotency_scope: ColumnType<string | null, string | null | undefined, string | null>;
  idempotency_key: ColumnType<string | null, string | null | undefined, string | null>;
  state: string;
  effective_at: ColumnType<Date, Date | undefined, never>;
  external_reference: ColumnType<string | null, string | null | undefined, string | null>;
  reversal_of: ColumnType<string | null, string | null | undefined, string | null>;
  correlation_id: string;
  metadata: ColumnType<JsonValue, JsonValue | undefined, JsonValue>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface LedgerEntriesTable {
  transaction_id: string;
  sequence: number;
  account_id: string;
  direction: 'debit' | 'credit';
  amount_atomic: string;
  asset_code: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface LedgerIdempotencyTable {
  scope: string;
  key: string;
  request_digest: string;
  state: ColumnType<'pending' | 'completed', 'pending' | 'completed' | undefined, 'pending' | 'completed'>;
  transaction_id: ColumnType<string | null, string | null | undefined, string | null>;
  result: ColumnType<JsonValue | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
  completed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface LedgerBalancesTable {
  account_id: string;
  posted_amount: ColumnType<string, string | undefined, string>;
  reserved_amount: ColumnType<string, string | undefined, string>;
  version: ColumnType<string, string | undefined, string>;
}

export type ExternalEventStatus = 'verified' | 'processing' | 'processed' | 'failed';

export interface OperationsExternalEventsTable {
  provider: string;
  external_id: string;
  received_at: ColumnType<Date, Date | undefined, never>;
  payload_digest: string;
  provider_event_at: ColumnType<Date, Date, Date>;
  status: ColumnType<ExternalEventStatus, ExternalEventStatus | undefined, ExternalEventStatus>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface OperationsOutboxTable {
  id: ColumnType<string, string | undefined, never>;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: ColumnType<number, number | undefined, number>;
  payload: ColumnType<JsonValue, JsonValue, JsonValue>;
  correlation_id: string;
  status: ColumnType<string, string | undefined, string>;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: ColumnType<Date, Date | undefined, Date>;
  last_error: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

// Generated-by-hand for now; swap to kysely-codegen once the schema settles.
// Money columns are NUMERIC(38,0) and arrive as strings — convert with @meter/contracts.
export interface DB {
  'identity.users': IdentityUsersTable;
  'identity.external_identities': IdentityExternalIdentitiesTable;
  'ledger.accounts': LedgerAccountsTable;
  'ledger.transactions': LedgerTransactionsTable;
  'ledger.entries': LedgerEntriesTable;
  'ledger.balances': LedgerBalancesTable;
  'ledger.idempotency': LedgerIdempotencyTable;
  'operations.external_events': OperationsExternalEventsTable;
  'operations.outbox': OperationsOutboxTable;
}
