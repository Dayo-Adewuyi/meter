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

export type ReservationState = 'open' | 'partially_captured' | 'captured' | 'released';

export interface LedgerReservationsTable {
  id: ColumnType<string, string | undefined, never>;
  reserve_transaction_id: string;
  available_account_id: string;
  reserved_account_id: string;
  asset_code: string;
  original_amount: string;
  captured_amount: ColumnType<string, string | undefined, string>;
  released_amount: ColumnType<string, string | undefined, string>;
  state: ColumnType<ReservationState, ReservationState | undefined, ReservationState>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface LedgerCapturesTable {
  transaction_id: string;
  reservation_id: string;
  destination_account_id: string;
  amount: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export interface LedgerRefundsTable {
  transaction_id: string;
  capture_transaction_id: string;
  amount: string;
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

export interface AuthzMandatesTable {
  id: ColumnType<string, string | undefined, never>;
  owner_id: string;
  name: string;
  asset_code: string;
  available_account_id: string;
  reserved_account_id: string;
  status: ColumnType<'active' | 'revoked', 'active' | 'revoked' | undefined, 'active' | 'revoked'>;
  per_transaction_limit: string;
  daily_limit: string;
  lifetime_limit: string;
  velocity_max_count: number;
  velocity_window_secs: number;
  max_in_flight: ColumnType<number, number | undefined, number>;
  duplicate_window_secs: ColumnType<number, number | undefined, number>;
  allowed_categories: string[];
  allowed_destinations: string[] | null;
  expires_at: Date;
  revoked_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  revoked_reason: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface AuthzAgentCredentialsTable {
  id: ColumnType<string, string | undefined, never>;
  mandate_id: string;
  public_id: string;
  secret_hash: Buffer;
  label: string;
  scopes: string[];
  status: ColumnType<'active' | 'revoked', 'active' | 'revoked' | undefined, 'active' | 'revoked'>;
  expires_at: Date;
  last_used_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  revoked_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export type AuthorizationState = 'authorized' | 'captured' | 'released' | 'expired';

export interface AuthzAuthorizationsTable {
  id: ColumnType<string, string | undefined, never>;
  mandate_id: string;
  credential_id: string;
  reservation_id: string;
  asset_code: string;
  amount: string;
  captured_amount: ColumnType<string, string | undefined, string>;
  category: string;
  destination: string;
  state: ColumnType<AuthorizationState, AuthorizationState | undefined, AuthorizationState>;
  hold_expires_at: Date;
  correlation_id: string;
  created_at: ColumnType<Date, Date | undefined, never>;
  finalized_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface AuthzDecisionsTable {
  id: ColumnType<string, string | undefined, never>;
  mandate_id: string | null;
  credential_id: string | null;
  outcome: 'approved' | 'declined';
  reason_code: string | null;
  evaluated: ColumnType<JsonValue, string, never>;
  request_digest: string;
  authorization_id: string | null;
  correlation_id: string;
  created_at: ColumnType<Date, Date | undefined, never>;
}

export type DeliveryStatus =
  | 'declined'
  | 'pending_dispatch'
  | 'dispatching'
  | 'awaiting_confirmation'
  | 'unresolved'
  | 'delivered'
  | 'rejected'
  | 'expired';

export interface AgentsPurchasesTable {
  id: ColumnType<string, string | undefined, never>;
  credential_id: string;
  idempotency_key: string;
  request_digest: string;
  authorization_id: string | null;
  decision_id: string;
  category: 'airtime';
  network: 'mtn' | 'airtel' | 'glo' | '9mobile';
  destination: string;
  amount: string;
  asset_code: string;
  intent: string;
  canonical_state: string;
  delivery_status: DeliveryStatus;
  send_attempts: ColumnType<number, number | undefined, number>;
  requery_attempts: ColumnType<number, number | undefined, number>;
  next_action_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  lease_until: ColumnType<Date | null, Date | null | undefined, Date | null>;
  dispatch_started_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  resolve_deadline_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  provider_reference: ColumnType<string | null, string | null | undefined, string | null>;
  last_provider_outcome: ColumnType<JsonValue | null, string | null | undefined, string | null>;
  correlation_id: string;
  created_at: ColumnType<Date, Date | undefined, never>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface AgentsPurchaseEventsTable {
  id: ColumnType<string, string | undefined, never>;
  purchase_id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  reason: string;
  detail: ColumnType<JsonValue, string | undefined, never>;
  ledger_transaction_id: string | null;
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
  'ledger.reservations': LedgerReservationsTable;
  'ledger.captures': LedgerCapturesTable;
  'ledger.refunds': LedgerRefundsTable;
  'operations.external_events': OperationsExternalEventsTable;
  'operations.outbox': OperationsOutboxTable;
  'authz.mandates': AuthzMandatesTable;
  'authz.agent_credentials': AuthzAgentCredentialsTable;
  'authz.authorizations': AuthzAuthorizationsTable;
  'authz.decisions': AuthzDecisionsTable;
  'agents.purchases': AgentsPurchasesTable;
  'agents.purchase_events': AgentsPurchaseEventsTable;
}
