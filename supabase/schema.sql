create table if not exists public.prediction_records (
  id text primary key,
  sequence bigint generated always as identity unique,
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and payload ?& array['type', 'sport', 'eventId']
    and payload->>'type' in ('prediction', 'result')
    and payload->>'sport' is not null
    and payload->>'eventId' is not null
  ),
  created_at timestamptz not null default now()
);

alter table public.prediction_records enable row level security;
revoke all on public.prediction_records from public, anon, authenticated, service_role;
grant select, insert on public.prediction_records to service_role;
grant usage, select on sequence public.prediction_records_sequence_seq to service_role;

create table if not exists public.notification_state (
  id text primary key,
  payload jsonb not null
);

alter table public.notification_state enable row level security;
revoke all on public.notification_state from public, anon, authenticated, service_role;
grant select, insert, update on public.notification_state to service_role;