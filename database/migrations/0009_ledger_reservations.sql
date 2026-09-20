-- Reservation state lives beside the journal, not inside it: the journal says
-- what moved, these rows say how much of an authorization remains (§10.4).
create table ledger.reservations (
  id uuid primary key default uuidv7(),
  reserve_transaction_id uuid not null unique references ledger.transactions (id),
  available_account_id uuid not null references ledger.accounts (id),
  reserved_account_id uuid not null references ledger.accounts (id),
  asset_code text not null,
  original_amount numeric(38,0) not null check (original_amount > 0),
  captured_amount numeric(38,0) not null default 0 check (captured_amount >= 0),
  released_amount numeric(38,0) not null default 0 check (released_amount >= 0),
  state text not null default 'open'
    check (state in ('open', 'partially_captured', 'captured', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An authorization can never settle for more than it held.
  check (captured_amount + released_amount <= original_amount),
  check (available_account_id <> reserved_account_id)
);

create table ledger.captures (
  transaction_id uuid primary key references ledger.transactions (id),
  reservation_id uuid not null references ledger.reservations (id),
  destination_account_id uuid not null references ledger.accounts (id),
  amount numeric(38,0) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create table ledger.refunds (
  transaction_id uuid primary key references ledger.transactions (id),
  capture_transaction_id uuid not null references ledger.captures (transaction_id),
  amount numeric(38,0) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index captures_reservation_idx on ledger.captures (reservation_id);
create index refunds_capture_idx on ledger.refunds (capture_transaction_id);
