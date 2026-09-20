-- Idempotency is its own record, not a unique index on transactions: a claim
-- exists before the journal does, and a replay must return the stored result
-- rather than a lookup by a key the command may not have written (§10.4).
create table ledger.idempotency (
  scope text not null,
  key text not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'completed')),
  transaction_id uuid references ledger.transactions (id),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (scope, key),
  check (
    (state = 'pending' and result is null and completed_at is null)
    or (state = 'completed' and result is not null and completed_at is not null)
  )
);

-- Retained for migration compatibility only: new commands claim in
-- ledger.idempotency, so a journal must not also own the key.
alter table ledger.transactions
  drop constraint transactions_idempotency_scope_idempotency_key_key,
  alter column idempotency_scope drop not null,
  alter column idempotency_key drop not null;
