-- Agent mandates (agent-mandates design §3.1): scoped, revocable authority for a
-- machine credential to spend from its owner's balance.

create table authz.mandates (
  id                     uuid primary key default uuidv7(),
  owner_id               uuid not null references identity.users (id),
  name                   text not null check (length(name) between 1 and 80),
  asset_code             text not null,
  available_account_id   uuid not null references ledger.accounts (id),
  reserved_account_id    uuid not null references ledger.accounts (id),
  status                 text not null default 'active'
                           check (status in ('active', 'revoked')),
  per_transaction_limit  numeric(38,0) not null check (per_transaction_limit > 0),
  daily_limit            numeric(38,0) not null check (daily_limit > 0),
  lifetime_limit         numeric(38,0) not null check (lifetime_limit > 0),
  velocity_max_count     int not null check (velocity_max_count > 0),
  velocity_window_secs   int not null check (velocity_window_secs > 0),
  max_in_flight          int not null default 3 check (max_in_flight > 0),
  duplicate_window_secs  int not null default 120 check (duplicate_window_secs >= 0),
  allowed_categories     text[] not null check (cardinality(allowed_categories) > 0),
  allowed_destinations   text[],            -- null = any destination in category
  expires_at             timestamptz not null,
  revoked_at             timestamptz,
  revoked_reason         text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (per_transaction_limit <= daily_limit),
  check (daily_limit <= lifetime_limit),
  check ((status = 'revoked') = (revoked_at is not null))
);

create index mandates_owner_idx on authz.mandates (owner_id, created_at desc);

create table authz.agent_credentials (
  id            uuid primary key default uuidv7(),
  mandate_id    uuid not null references authz.mandates (id),
  public_id     text not null unique,          -- the non-secret half of the token
  secret_hash   bytea not null,                -- HMAC-SHA256(pepper, secret)
  label         text not null check (length(label) between 1 and 80),
  scopes        text[] not null,
  status        text not null default 'active' check (status in ('active', 'revoked')),
  expires_at    timestamptz not null,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  check ((status = 'revoked') = (revoked_at is not null))
);

create index agent_credentials_mandate_idx on authz.agent_credentials (mandate_id);

create table authz.authorizations (
  id                 uuid primary key default uuidv7(),
  mandate_id         uuid not null references authz.mandates (id),
  credential_id      uuid not null references authz.agent_credentials (id),
  reservation_id     uuid not null unique references ledger.reservations (id),
  asset_code         text not null,
  amount             numeric(38,0) not null check (amount > 0),
  captured_amount    numeric(38,0) not null default 0 check (captured_amount >= 0),
  -- Opaque to core: the duplicate guard (§6.4) compares them, nothing else reads them.
  category           text not null,
  destination        text not null,
  state              text not null default 'authorized'
                       check (state in ('authorized', 'captured', 'released', 'expired')),
  hold_expires_at    timestamptz not null,
  correlation_id     uuid not null,
  created_at         timestamptz not null default now(),
  finalized_at       timestamptz,
  check (captured_amount <= amount),
  check ((state = 'authorized') = (finalized_at is null))
);

create index authorizations_mandate_time_idx on authz.authorizations (mandate_id, created_at);
create index authorizations_open_idx on authz.authorizations (hold_expires_at)
  where state = 'authorized';

create table authz.decisions (
  id               uuid primary key default uuidv7(),
  mandate_id       uuid references authz.mandates (id),
  credential_id    uuid references authz.agent_credentials (id),
  outcome          text not null check (outcome in ('approved', 'declined')),
  reason_code      text,                       -- null when approved
  evaluated        jsonb not null,             -- ordered snapshot of every check run
  request_digest   text not null,
  authorization_id uuid references authz.authorizations (id),
  correlation_id   uuid not null,
  created_at       timestamptz not null default now(),
  check ((outcome = 'approved') = (authorization_id is not null)),
  check ((outcome = 'declined') = (reason_code is not null))
);

create index decisions_mandate_idx on authz.decisions (mandate_id, created_at);

-- Same pattern as ledger.entries (0008): a decision is evidence, never edited.
create function authz.reject_decision_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'authz.decisions is append-only' using errcode = '23000';
end;
$$;

create trigger decisions_append_only
  before update or delete on authz.decisions
  for each row execute function authz.reject_decision_mutation();
