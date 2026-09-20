-- Append-only double-entry ledger (§10.1). Entries are the source of truth;
-- ledger.balances is an atomically updated projection for authorization latency.

create table ledger.accounts (
  id             uuid primary key default uuidv7(),
  owner_type     text        not null,
  owner_id       uuid        not null,
  asset_code     text        not null,
  account_type   text        not null,
  normal_balance text        not null check (normal_balance in ('debit', 'credit')),
  status         text        not null default 'active',
  created_at     timestamptz not null default now(),
  unique (owner_type, owner_id, asset_code, account_type)
);

create table ledger.transactions (
  id                 uuid primary key default uuidv7(),
  transaction_type   text        not null,
  idempotency_scope  text        not null,
  idempotency_key    text        not null,
  state              text        not null,
  effective_at       timestamptz not null default now(),
  external_reference text,
  reversal_of        uuid references ledger.transactions (id),
  metadata           jsonb       not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (idempotency_scope, idempotency_key)
);

create table ledger.entries (
  transaction_id uuid          not null references ledger.transactions (id),
  sequence       int           not null,
  account_id     uuid          not null references ledger.accounts (id),
  direction      text          not null check (direction in ('debit', 'credit')),
  amount_atomic  numeric(38,0) not null check (amount_atomic > 0),
  asset_code     text          not null,
  created_at     timestamptz   not null default now(),
  primary key (transaction_id, sequence)
);

create index entries_account_created_idx on ledger.entries (account_id, created_at desc);

create table ledger.balances (
  account_id      uuid primary key references ledger.accounts (id),
  posted_amount   numeric(38,0) not null default 0,
  reserved_amount numeric(38,0) not null default 0 check (reserved_amount >= 0),
  version         bigint        not null default 0
);

-- Posted entries are immutable; corrections use linked compensating journals (§10.2).
create rule entries_no_update as on update to ledger.entries do instead nothing;
create rule entries_no_delete as on delete to ledger.entries do instead nothing;
