-- Financial invariants are enforced twice: stable application errors at the
-- command boundary, and these constraints at the persistence boundary, because
-- the application is not the only thing that can hold a connection (§10.2).

-- Rules silently discarded writes and reported "0 rows affected". A caller that
-- believes it edited a posted entry is worse than one that gets an error.
drop rule entries_no_update on ledger.entries;
drop rule entries_no_delete on ledger.entries;

create function ledger.reject_entry_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'ledger.entries is append-only; post a compensating journal'
    using errcode = '23000';
end;
$$;

create trigger entries_append_only
  before update or delete on ledger.entries
  for each row execute function ledger.reject_entry_mutation();

-- Deferred: a journal is only required to balance at commit, not part-way
-- through its own inserts.
create function ledger.assert_transaction_balanced() returns trigger
language plpgsql as $$
declare
  unbalanced_asset text;
begin
  select asset_code into unbalanced_asset
  from ledger.entries
  where transaction_id = new.transaction_id
  group by asset_code
  having sum(case when direction = 'debit' then amount_atomic else 0 end)
      <> sum(case when direction = 'credit' then amount_atomic else 0 end)
  limit 1;

  if unbalanced_asset is not null then
    raise exception 'transaction % does not balance for asset %', new.transaction_id, unbalanced_asset
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger entries_balanced
  after insert on ledger.entries
  deferrable initially deferred
  for each row execute function ledger.assert_transaction_balanced();

-- A transaction may be reversed at most once.
create unique index transactions_reversal_of_key
  on ledger.transactions (reversal_of)
  where reversal_of is not null;

-- Every journal belongs to a traceable chain of work.
alter table ledger.transactions add column correlation_id uuid;
update ledger.transactions set correlation_id = id where correlation_id is null;
alter table ledger.transactions alter column correlation_id set not null;

create index transactions_correlation_idx on ledger.transactions (correlation_id);

-- Deferred, so a command service sees its own projection result first and can
-- return the stable INSUFFICIENT_FUNDS code. A direct writer that never runs
-- that check still fails, at commit.
create function ledger.assert_available_non_negative() returns trigger
language plpgsql as $$
begin
  if new.posted_amount < 0 and exists (
    select 1 from ledger.accounts
    where id = new.account_id and purpose = 'customer_available'
  ) then
    raise exception 'customer available balance cannot be negative for account %', new.account_id
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger balances_available_non_negative
  after insert or update on ledger.balances
  deferrable initially deferred
  for each row execute function ledger.assert_available_non_negative();
