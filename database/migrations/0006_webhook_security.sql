-- External events become replay claims: the provider's own event time and a
-- processing lifecycle, not just a receipt log (§15.1).
alter table operations.external_events
  add column provider_event_at timestamptz,
  add column status text not null default 'verified',
  add column updated_at timestamptz not null default now();

update operations.external_events
set provider_event_at = received_at
where provider_event_at is null;

alter table operations.external_events
  alter column provider_event_at set not null,
  add constraint external_events_status_check
    check (status in ('verified', 'processing', 'processed', 'failed'));

create index external_events_status_idx
  on operations.external_events (status, provider_event_at);
