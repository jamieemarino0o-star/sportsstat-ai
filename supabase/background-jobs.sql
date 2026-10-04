create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $validation$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'sportsstat_app_url' and decrypted_secret like 'https://%')
    or not exists (select 1 from vault.decrypted_secrets where name = 'sportsstat_job_token' and length(decrypted_secret) >= 32) then
    raise exception 'Create sportsstat_app_url and sportsstat_job_token in Supabase Vault first. The token must match Render BACKGROUND_JOB_TOKEN and contain at least 32 characters.';
  end if;
end;
$validation$;

select cron.schedule(
  'sportsstat-background-scan',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url := rtrim((select decrypted_secret from vault.decrypted_secrets where name = 'sportsstat_app_url'), '/') || '/api/jobs/scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sportsstat_job_token')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 90000
  );
  $job$
);