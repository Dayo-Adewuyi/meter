alter table ledger.accounts
  add column account_class text,
  add column purpose text,
  add column customer_id uuid references identity.users(id);

update ledger.accounts
set
  purpose = account_type,
  account_class = case account_type
    when 'customer_available' then 'customer_liability'
    when 'customer_reserved' then 'customer_liability'
    when 'customer_pending' then 'customer_liability'
    when 'provider_payable' then 'provider_liability'
    when 'meter_revenue' then 'revenue'
    when 'tax_liability' then 'tax_liability'
    when 'external_cash' then 'asset'
    when 'reserve' then 'reserve'
  end,
  customer_id = case when owner_type = 'customer' then owner_id end;

alter table ledger.accounts
  alter column account_class set not null,
  alter column purpose set not null,
  add constraint accounts_account_class_check check (account_class in (
    'asset', 'customer_liability', 'provider_liability', 'revenue', 'tax_liability', 'reserve'
  )),
  add constraint accounts_purpose_check check (purpose in (
    'customer_available', 'customer_reserved', 'customer_pending', 'provider_payable',
    'meter_revenue', 'tax_liability', 'external_cash', 'reserve'
  )),
  add constraint accounts_taxonomy_mapping_check check (
    (account_type = 'customer_available' and purpose = 'customer_available' and account_class = 'customer_liability' and normal_balance = 'credit')
    or (account_type = 'customer_reserved' and purpose = 'customer_reserved' and account_class = 'customer_liability' and normal_balance = 'credit')
    or (account_type = 'customer_pending' and purpose = 'customer_pending' and account_class = 'customer_liability' and normal_balance = 'credit')
    or (account_type = 'provider_payable' and purpose = 'provider_payable' and account_class = 'provider_liability' and normal_balance = 'credit')
    or (account_type = 'meter_revenue' and purpose = 'meter_revenue' and account_class = 'revenue' and normal_balance = 'credit')
    or (account_type = 'tax_liability' and purpose = 'tax_liability' and account_class = 'tax_liability' and normal_balance = 'credit')
    or (account_type = 'external_cash' and purpose = 'external_cash' and account_class = 'asset' and normal_balance = 'debit')
    or (account_type = 'reserve' and purpose = 'reserve' and account_class = 'reserve' and normal_balance = 'debit')
  ),
  add constraint accounts_customer_owner_check check (
    (owner_type = 'customer' and customer_id is not null and customer_id = owner_id)
    or (owner_type in ('system', 'provider') and customer_id is null)
  ),
  add constraint accounts_owner_purpose_check check (
    (owner_type = 'customer' and purpose in ('customer_available', 'customer_reserved', 'customer_pending'))
    or (owner_type in ('system', 'provider') and purpose not in ('customer_available', 'customer_reserved', 'customer_pending'))
  ),
  add constraint accounts_id_asset_code_key unique (id, asset_code),
  drop constraint accounts_owner_type_owner_id_asset_code_account_type_key,
  add constraint accounts_owner_asset_purpose_key unique (owner_type, owner_id, asset_code, purpose);

insert into ledger.accounts (
  id, owner_type, owner_id, asset_code, account_type, account_class, purpose, normal_balance, customer_id
)
values
  ('00000000-0000-7000-8000-000000000001', 'system', '00000000-0000-0000-0000-000000000000', 'NGN', 'external_cash', 'asset', 'external_cash', 'debit', null),
  ('00000000-0000-7000-8000-000000000002', 'system', '00000000-0000-0000-0000-000000000000', 'NGN', 'meter_revenue', 'revenue', 'meter_revenue', 'credit', null),
  ('00000000-0000-7000-8000-000000000003', 'system', '00000000-0000-0000-0000-000000000000', 'NGN', 'provider_payable', 'provider_liability', 'provider_payable', 'credit', null),
  ('00000000-0000-7000-8000-000000000004', 'system', '00000000-0000-0000-0000-000000000000', 'NGN', 'reserve', 'reserve', 'reserve', 'debit', null),
  ('00000000-0000-7000-8000-000000000005', 'system', '00000000-0000-0000-0000-000000000000', 'NGN', 'tax_liability', 'tax_liability', 'tax_liability', 'credit', null)
on conflict do nothing;

alter table ledger.entries
  add constraint entries_account_asset_code_fkey
  foreign key (account_id, asset_code) references ledger.accounts (id, asset_code);
