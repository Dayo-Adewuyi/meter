-- Agent airtime purchases (agent-mandates design §3.2). The purchase row is the
-- durable intent: written in the same transaction as the reservation, then
-- driven to a terminal state by the finalizer.

create schema if not exists agents;

create table agents.purchases (
  id                     uuid primary key default uuidv7(),  -- also the provider request id
  credential_id          uuid not null references authz.agent_credentials (id),
  idempotency_key        text not null,
  request_digest         text not null,
  authorization_id       uuid unique references authz.authorizations (id),
  decision_id            uuid not null references authz.decisions (id),
  category               text not null check (category in ('airtime')),
  network                text not null check (network in ('mtn', 'airtel', 'glo', '9mobile')),
  destination            text not null,       -- normalized E.164, e.g. +2348030000000
  amount                 numeric(38,0) not null check (amount > 0),
  asset_code             text not null,
  intent                 text not null check (length(intent) between 1 and 280),
  canonical_state        text not null,        -- PRD §7.2 state
  delivery_status        text not null
    check (delivery_status in ('declined', 'pending_dispatch', 'dispatching',
      'awaiting_confirmation', 'unresolved', 'delivered', 'rejected', 'expired')),
  send_attempts          int not null default 0,
  requery_attempts       int not null default 0,
  next_action_at         timestamptz,
  lease_until            timestamptz,
  dispatch_started_at    timestamptz,
  resolve_deadline_at    timestamptz,
  provider_reference     text,
  last_provider_outcome  jsonb,                -- redacted
  correlation_id         uuid not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (credential_id, idempotency_key),
  check ((delivery_status = 'declined') = (authorization_id is null))
);

create index purchases_work_idx on agents.purchases (next_action_at)
  where delivery_status in ('pending_dispatch', 'dispatching', 'awaiting_confirmation');
create index purchases_credential_idx on agents.purchases (credential_id, created_at desc);

create table agents.purchase_events (
  id            uuid primary key default uuidv7(),
  purchase_id   uuid not null references agents.purchases (id),
  from_status   text,
  to_status     text not null,
  actor         text not null,               -- 'agent:<credential>', 'worker', 'operator:<user>'
  reason        text not null,
  detail        jsonb not null default '{}',
  ledger_transaction_id uuid references ledger.transactions (id),
  created_at    timestamptz not null default now()
);

create index purchase_events_purchase_idx on agents.purchase_events (purchase_id, id);

create function agents.reject_event_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'agents.purchase_events is append-only' using errcode = '23000';
end;
$$;

create trigger purchase_events_append_only
  before update or delete on agents.purchase_events
  for each row execute function agents.reject_event_mutation();
