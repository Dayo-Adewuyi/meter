-- Transactional outbox: domain state and its downstream event commit together (§12.1).
create table operations.outbox (
  id              uuid primary key default uuidv7(),
  aggregate_type  text        not null,
  aggregate_id    uuid        not null,
  event_type      text        not null,
  schema_version  int         not null default 1,
  payload         jsonb       not null,
  correlation_id  uuid        not null,
  status          text        not null default 'pending',
  attempts        int         not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now()
);

create index outbox_dispatch_idx on operations.outbox (status, next_attempt_at);

-- External event IDs are unique within their provider scope (§10.2, §15.1).
create table operations.external_events (
  provider         text        not null,
  external_id      text        not null,
  received_at      timestamptz not null default now(),
  payload_digest   text        not null,
  primary key (provider, external_id)
);
