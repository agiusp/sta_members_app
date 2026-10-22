-- Before going live:
--  - Casual Play and Ratings can each be switched off for everyone,
--    developers included (Developers > Settings > App settings); the pages
--    hide them (app/common.js) and their emails stop.
--  - Developers can look up any player's rating history (Developers > Ratings).
--  - Backups: developers can download one at any time, and the app emails one
--    every week to a private address (the free Supabase plan keeps none).
--    restore_backup() loads one back.
--  - Timed tasks run every minute online, once the project has its two Vault
--    secrets (see run_timed_tasks below).

-- ---------- Features switched on or off ----------
alter table public.settings
  add column casual_on boolean not null default true,
  add column rating_on boolean not null default true,
  -- Weekly backup email: where it goes (off while empty), when it last went,
  -- and "send one now".
  add column backup_email text,
  add column backup_sent_at timestamptz,
  add column backup_requested boolean not null default false;

-- my_access() also says which features are switched on.
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'member', my_email() is not null,
    'sunday_doubles', my_sd_email() is not null,
    'developer', coalesce((select is_developer and membership_current from accounts
                            where user_id = auth.uid() and active), false),
    'confirmed', is_developer(),
    'dues_message', (select dues_message from settings),
    'casual_on', (select casual_on from settings),
    'rating_on', (select rating_on from settings));
$$;

-- The App settings that aren't branding: features and backups.
create function public.dev_app_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_developer();
  return (select jsonb_build_object(
    'casual_on', s.casual_on, 'rating_on', s.rating_on,
    'backup_email', s.backup_email, 'backup_sent_at', s.backup_sent_at, 'backup_requested', s.backup_requested,
    'backup_error', (select error from email_log where kind = 'backup' order by id desc limit 1))
    from settings s);
end;
$$;

create function public.dev_save_features(p_casual boolean, p_rating boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if p_casual is null or p_rating is null then raise exception 'Choose On or Off for each feature'; end if;
  update settings set casual_on = p_casual, rating_on = p_rating where id;
  return dev_app_settings();
end;
$$;

-- While Ratings are switched off, players can't see or dispute their results,
-- so the Sunday Doubles Scheduler and This week use Level, not the Dynamic
-- Level from My Rating. Game Reviews still record results.
create function public.scheduler_levels() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when (select rating_on from settings) then rating_dynamic_levels() else '{}'::jsonb end;
$$;

do $$
declare
  f   text;
  fn  text;
  old text := '(select rating_dynamic_levels())';
begin
  foreach fn in array array['dev_scheduler_data', 'dev_week'] loop
    select pg_get_functiondef(('public.' || fn)::regproc) into f;
    if (length(f) - length(replace(f, old, ''))) / length(old) <> 1 then
      raise exception '% changed; update this migration', fn;
    end if;
    execute replace(f, old, '(select scheduler_levels())');
  end loop;
end $$;

-- ---------- A player's rating history ----------
-- One entry per result of theirs, oldest first, with how it moved them.
create function public.rating_history(p_player bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(rating_view(r, p_player) || jsonb_build_object(
           'rated', x.rated, 'played_before', x.played_before,
           'rating_before', round(x.rating_before, 4), 'rating_after', round(x.rating_after, 4),
           'official_before', x.official_before, 'official_after', x.official_after,
           'step', round(x.step, 4), 'weight', round(x.weight, 4),
           'expected', round(x.expected, 4), 'actual', round(x.actual, 4), 'change', round(x.change, 4))
           order by r.played_on, r.id), '[]'::jsonb)
    from rating_replay() x join rating_results r on r.id = x.result_id
   where x.player_id = p_player;
$$;

-- A player's rating summary and history: for the player (my_rating) and for
-- developers (dev_rating_history).
create function public.rating_summary(p_player bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  pl   players;
  lvl  numeric;
  hist jsonb;
  last jsonb;
begin
  select * into pl from players where id = p_player;
  lvl := rating_level(pl.level);
  hist := rating_history(p_player);
  select h into last from jsonb_array_elements(hist) h where (h ->> 'rated')::boolean
   order by (h ->> 'played_before')::int desc limit 1;
  return jsonb_build_object(
    'player', case when pl.id is null then null else jsonb_build_object(
                'id', pl.id, 'name', pl.first_name || ' ' || pl.last_name, 'level', pl.level,
                'start', lvl, 'start_official', rating_nearest(lvl)) end,
    'rating', coalesce((last ->> 'rating_after')::numeric, lvl),
    'official', coalesce((last ->> 'official_after')::numeric, rating_nearest(lvl)),
    'played', coalesce((last ->> 'played_before')::int + 1, 0),
    'history', hist);
end;
$$;

create or replace function public.my_rating() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me bigint;
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  me := rating_me();
  return rating_summary(me) || jsonb_build_object(
    'now', app_now(),
    'test_mode', (select test_mode from settings),
    'developer', is_developer(),
    -- Results waiting for this player's answer.
    'to_confirm', coalesce((
      select jsonb_agg(rating_view(r, me) order by r.played_on, r.id)
        from rating_results r where rating_needs_answer(r, me)), '[]'::jsonb),
    -- Everything else of theirs that isn't counted (yet).
    'waiting', coalesce((
      select jsonb_agg(rating_view(r, me) order by r.played_on desc, r.id desc)
        from rating_results r
       where me = any (r.team1 || r.team2) and not rating_needs_answer(r, me)
         and (r.status = 'developers'
              or (r.status = 'pending' and not rating_counted(r.source, r.status, r.reported_at)))), '[]'::jsonb));
end;
$$;

-- Developers > Ratings > Player history: any player's rating after each
-- counted result (players are told about this on rating-how.html).
create function public.dev_rating_history(p_player bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if not exists (select 1 from players where id = p_player) then raise exception 'No such player'; end if;
  return rating_summary(p_player);
end;
$$;

-- ---------- Backups ----------
-- Every table of the app, as JSON: what the weekly backup email attaches and
-- the Download button saves. Sign-in passwords aren't included (they live in
-- Supabase's sign-in service): after restoring into a new project, members
-- are invited again. The Demo inbox isn't included either.
create function public.backup_data() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t    text;
  rows jsonb;
  all_ jsonb := '{}';
begin
  for t in select c.relname from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> 'demo_inbox'
            order by c.relname loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x', t) into rows;
    all_ := all_ || jsonb_build_object(t, rows);
  end loop;
  return jsonb_build_object(
    'backup_of', 'STA Members App',
    'made_at', now(),
    'app_version', (select max(version) from supabase_migrations.schema_migrations),
    'tables', all_);
end;
$$;

create function public.dev_backup() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  return backup_data();
end;
$$;

-- Where the weekly backup goes (null or empty: no backup emails).
create function public.dev_save_backup_email(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  e text := nullif(lower(trim(coalesce(p_email, ''))), '');
begin
  perform require_developer();
  if e is not null and e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email address doesn''t look right'; end if;
  update settings set backup_email = e, backup_requested = backup_requested and e is not null where id;
  return dev_app_settings();
end;
$$;

-- "Email a backup now": sent by the next run of the timed tasks.
create function public.dev_request_backup() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if (select backup_email from settings) is null then raise exception 'Save a backup email address first'; end if;
  update settings set backup_requested = true where id;
  return dev_app_settings();
end;
$$;

-- For the timed-tasks function: the backup to email, if one is due. The
-- weekly one is due from Monday 2am (US Eastern), once a week; a requested
-- one at once. Handed out only once.
create function public.claim_backup() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s     settings;
  now_  timestamptz := app_now();
  week  timestamptz := (date_trunc('week', now_ at time zone 'America/New_York') + interval '2 hours')
                         at time zone 'America/New_York';
begin
  select * into s from settings for update;
  if s.backup_email is null
     or not (s.backup_requested or (now_ >= week and (s.backup_sent_at is null or s.backup_sent_at < week))) then
    return null;
  end if;
  update settings set backup_sent_at = now_, backup_requested = false where id;
  return jsonb_build_object('to', s.backup_email, 'made_at', now_, 'data', backup_data());
end;
$$;

-- Loads a backup back in. Only with the service role key (scripts/restore-backup.mjs).
-- Refuses a database that already has players unless p_replace is true; then
-- every table in the backup is emptied and filled from it, all at once (any
-- error leaves everything as it was). Sign-in accounts that don't exist in
-- this project are unlinked, so those members can be invited again.
create function public.restore_backup(p_backup jsonb, p_replace boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t      text;
  n      int;
  counts jsonb := '{}';
  seq    text;
begin
  if p_backup ->> 'backup_of' is distinct from 'STA Members App' or jsonb_typeof(p_backup -> 'tables') <> 'object' then
    raise exception 'This is not a backup of the app';
  end if;
  if exists (select 1 from players) and not p_replace then
    raise exception 'This database already has players. Restore with --replace to overwrite everything in it.';
  end if;
  -- Skip foreign-key checks and triggers while the tables are reloaded.
  set local session_replication_role = replica;
  for t in select key from jsonb_each(p_backup -> 'tables') loop
    if not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = t)
       or t = 'demo_inbox' then
      counts := counts || jsonb_build_object(t, 'skipped: not in this version of the app');
      continue;
    end if;
    execute format('delete from public.%I where true', t);
    execute format('insert into public.%1$I overriding system value
                      select * from jsonb_populate_recordset(null::public.%1$I, $1)', t)
      using p_backup -> 'tables' -> t;
    get diagnostics n = row_count;
    counts := counts || jsonb_build_object(t, n);
    for seq in select pg_get_serial_sequence('public.' || quote_ident(t), a.attname)
                 from pg_attribute a
                where a.attrelid = ('public.' || quote_ident(t))::regclass and a.attidentity <> '' loop
      execute format('select setval(%L, greatest(coalesce((select max(id) from public.%I), 0), 1), (select count(*) > 0 from public.%I))',
                     seq, t, t);
    end loop;
  end loop;
  update accounts a set user_id = null
   where a.user_id is not null and not exists (select 1 from auth.users u where u.id = a.user_id);
  -- Never come back up in test or demo mode by accident.
  update settings set test_mode = false, test_clock = null, demo = false where id;
  return counts;
end;
$$;

revoke all on function public.scheduler_levels(), public.rating_history(bigint), public.rating_summary(bigint),
  public.backup_data(), public.claim_backup(), public.restore_backup(jsonb, boolean)
  from anon, authenticated, public;
revoke all on function public.dev_app_settings(), public.dev_save_features(boolean, boolean),
  public.dev_rating_history(bigint), public.dev_backup(), public.dev_save_backup_email(text),
  public.dev_request_backup()
  from anon, public;
grant execute on function public.dev_app_settings(), public.dev_save_features(boolean, boolean),
  public.dev_rating_history(bigint), public.dev_backup(), public.dev_save_backup_email(text),
  public.dev_request_backup()
  to authenticated;
grant execute on function public.claim_backup(), public.restore_backup(jsonb, boolean) to service_role;

-- ---------- Running the timed tasks every minute ----------
-- pg_cron calls run_timed_tasks() every minute. It does nothing until the
-- project has two Vault secrets (Supabase dashboard > Project Settings >
-- Vault, or SQL), so local copies, tests and the demo are unaffected:
--   timed_tasks_url  https://<project ref>.supabase.co/functions/v1/timed-tasks
--   timed_tasks_key  the project's secret key (sb_secret_...)
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create function public.run_timed_tasks() returns void
language plpgsql security definer set search_path = public as $$
declare
  url text := (select decrypted_secret from vault.decrypted_secrets where name = 'timed_tasks_url');
  key text := (select decrypted_secret from vault.decrypted_secrets where name = 'timed_tasks_key');
begin
  if url is null or key is null then return; end if;
  perform net.http_post(url := url, body := '{}'::jsonb, timeout_milliseconds := 150000,
                        headers := jsonb_build_object('Content-Type', 'application/json',
                                                      'Authorization', 'Bearer ' || key, 'apikey', key));
end;
$$;
revoke all on function public.run_timed_tasks() from anon, authenticated, public;

select cron.schedule('timed-tasks', '* * * * *', 'select public.run_timed_tasks()');
