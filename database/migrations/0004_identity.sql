create table identity.users (
  id uuid primary key default uuidv7(),
  status text not null default 'active'
    check (status in ('active', 'suspended', 'deleted')),
  roles text[] not null default array['customer']::text[]
    check (cardinality(roles) > 0 and roles <@ array['customer','operator','admin']::text[]),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table identity.external_identities (
  provider text not null,
  external_subject text not null,
  user_id uuid not null references identity.users(id),
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, external_subject),
  unique (provider, user_id)
);

create index external_identities_user_idx
  on identity.external_identities (user_id);
