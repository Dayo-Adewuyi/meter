-- x402 payments (x402 design §4, §5): agents paying HTTP resources in USDC
-- through an omnibus EIP-3009 wallet, finalized from the chain.

-- USDC system accounts, so x402 captures and sandbox funding stay in one asset.
insert into ledger.accounts (
  id, owner_type, owner_id, asset_code, account_type, account_class, purpose, normal_balance, customer_id
)
values
  ('00000000-0000-7000-8000-000000000011', 'system', '00000000-0000-0000-0000-000000000000', 'USDC', 'external_cash', 'asset', 'external_cash', 'debit', null),
  ('00000000-0000-7000-8000-000000000013', 'system', '00000000-0000-0000-0000-000000000000', 'USDC', 'provider_payable', 'provider_liability', 'provider_payable', 'credit', null)
on conflict do nothing;

-- Lower-cased payTo addresses an x402 mandate may pay; null = any.
alter table authz.mandates add column allowed_counterparties text[];

create table agents.x402_payments (
  id                   uuid primary key default uuidv7(),
  credential_id        uuid not null references authz.agent_credentials (id),
  idempotency_key      text not null,
  request_digest       text not null,
  authorization_id     uuid unique references authz.authorizations (id),
  decision_id          uuid not null references authz.decisions (id),
  network              text not null,                 -- CAIP-2, e.g. eip155:84532
  asset                text not null,                 -- token contract, lower-case
  pay_to               text not null,                 -- lower-case
  amount               numeric(38,0) not null check (amount > 0),
  asset_code           text not null check (asset_code = 'USDC'),
  resource_url         text not null,
  resource_origin      text not null,
  method               text not null,
  intent               text not null check (length(intent) between 1 and 280),
  state                text not null check (state in ('declined', 'signed', 'settled', 'lapsed', 'unresolved')),
  canonical_state      text not null,
  -- The EIP-3009 authorization Meter signed (null when declined).
  auth_from            text,
  auth_nonce           text unique,                   -- keccak256("meter.x402" ‖ id)
  valid_after          bigint,
  valid_before         bigint,
  signature            text,
  payment_payload      text,                          -- base64, ready for PAYMENT-SIGNATURE
  -- On-chain evidence, recorded when settled.
  settlement_tx        text,
  settlement_block     bigint,
  settled_value        numeric(38,0),
  check_attempts       int not null default 0,
  next_action_at       timestamptz,
  lease_until          timestamptz,
  resolve_deadline_at  timestamptz,
  correlation_id       uuid not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (credential_id, idempotency_key),
  check ((state = 'declined') = (authorization_id is null)),
  check ((state = 'declined') = (signature is null))
);

create index x402_payments_work_idx on agents.x402_payments (next_action_at) where state = 'signed';
create index x402_payments_credential_idx on agents.x402_payments (credential_id, created_at desc);

create table agents.x402_payment_events (
  id                    uuid primary key default uuidv7(),
  payment_id            uuid not null references agents.x402_payments (id),
  from_state            text,
  to_state              text not null,
  actor                 text not null,
  reason                text not null,
  detail                jsonb not null default '{}',
  ledger_transaction_id uuid references ledger.transactions (id),
  created_at            timestamptz not null default now()
);

create index x402_payment_events_payment_idx on agents.x402_payment_events (payment_id, id);

create trigger x402_payment_events_append_only
  before update or delete on agents.x402_payment_events
  for each row execute function agents.reject_event_mutation();
