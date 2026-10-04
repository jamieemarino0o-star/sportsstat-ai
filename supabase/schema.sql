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

create table if not exists public.odds_cache (
  key text primary key,
  payload jsonb,
  fetched_at timestamptz,
  provider_remaining integer,
  reservation_id uuid,
  lease_until timestamptz,
  retry_at timestamptz
);

create table if not exists public.odds_usage (
  id uuid primary key default gen_random_uuid(),
  reserved_at timestamptz not null default now(),
  credits integer not null check (credits > 0)
);

create index if not exists odds_usage_reserved_at_idx on public.odds_usage (reserved_at);
alter table public.odds_cache enable row level security;
alter table public.odds_usage enable row level security;
revoke all on public.odds_cache, public.odds_usage from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.odds_cache, public.odds_usage to service_role;

create or replace function public.odds_budget_status(max_credits integer default 400)
returns jsonb language sql security invoker set search_path = '' as $$
  select jsonb_build_object(
    'limit', max_credits, 'windowDays', 31,
    'used', coalesce(sum(credits), 0),
    'remaining', greatest(0, max_credits - coalesce(sum(credits), 0)),
    'nextReleaseAt', min(reserved_at) + interval '31 days'
  ) from public.odds_usage where reserved_at > now() - interval '31 days';
$$;

create or replace function public.claim_odds_request(cache_key text, ttl_ms integer, max_credits integer default 400)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  cached public.odds_cache%rowtype;
  budget jsonb;
  reservation uuid;
begin
  if cache_key is null or length(cache_key) not between 1 and 300
    or ttl_ms is null or ttl_ms not between 60000 and 604800000
    or max_credits is null or max_credits not between 0 and 400 then
    raise exception 'Invalid odds cache or budget settings';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(78234819);
  delete from public.odds_usage where reserved_at <= now() - interval '31 days';
  delete from public.odds_cache where greatest(fetched_at, retry_at, lease_until) < now() - interval '7 days';
  insert into public.odds_cache (key) values (cache_key) on conflict (key) do nothing;
  select * into cached from public.odds_cache where key = cache_key;
  budget := public.odds_budget_status(max_credits);
  if cached.fetched_at > now() - ttl_ms * interval '1 millisecond' then
    return jsonb_build_object('state', 'cached', 'budget', budget, 'data', cached.payload, 'time', cached.fetched_at, 'providerRemaining', cached.provider_remaining);
  end if;
  if cached.lease_until > now() or cached.retry_at > now() then
    return jsonb_build_object('state', 'waiting', 'budget', budget, 'retryAt', greatest(cached.lease_until, cached.retry_at));
  end if;
  if (budget->>'remaining')::integer < 1 then
    return jsonb_build_object('state', 'budget', 'budget', budget);
  end if;
  insert into public.odds_usage (credits) values (1) returning id into reservation;
  update public.odds_cache set reservation_id = reservation, lease_until = now() + interval '2 minutes', retry_at = null where key = cache_key;
  return jsonb_build_object('state', 'reserved', 'reservationId', reservation, 'budget', public.odds_budget_status(max_credits));
end;
$$;

create or replace function public.complete_odds_request(cache_key text, reservation uuid, response_payload jsonb, remaining_credits integer default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  saved public.odds_cache%rowtype;
begin
  update public.odds_cache set
    payload = case when response_payload is not null then response_payload else payload end,
    fetched_at = case when response_payload is not null then now() else fetched_at end,
    provider_remaining = case when response_payload is not null then remaining_credits else provider_remaining end,
    reservation_id = null,
    lease_until = null,
    retry_at = case when response_payload is null then now() + interval '15 minutes' else null end
  where key = cache_key and reservation_id = reservation
  returning * into saved;
  if not found then raise exception 'Odds reservation expired or replaced'; end if;
  return jsonb_build_object('data', saved.payload, 'time', saved.fetched_at, 'providerRemaining', saved.provider_remaining);
end;
$$;

revoke all on function public.odds_budget_status(integer) from public, anon, authenticated;
revoke all on function public.claim_odds_request(text, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_odds_request(text, uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.odds_budget_status(integer) to service_role;
grant execute on function public.claim_odds_request(text, integer, integer) to service_role;
grant execute on function public.complete_odds_request(text, uuid, jsonb, integer) to service_role;