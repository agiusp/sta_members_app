-- Emails and schedule that developers can change in the app
-- (Developer area > Emails and schedule).
--
-- email_templates: edits that developers made to email wording. An email with no row
--   here uses its default wording (supabase/functions/_shared/default-emails.ts).
-- schedule: the day and time of every deadline and timed email, plus on/off
--   switches for the optional emails. Times are US Eastern, as a number of
--   days before the Sunday (6 = Monday, 1 = Saturday, 0 = Sunday) and a time.
--
-- Also adds the Monday play-invite and the "off the waitlist" email.

create table public.email_templates (
  key        text primary key,
  subject    text not null check (trim(subject) <> ''),
  body       text not null check (trim(body) <> ''),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table public.schedule (
  key                text primary key,
  days_before_sunday int check (days_before_sunday between 0 and 6),
  at_time            time,
  enabled            boolean not null default true
);
insert into public.schedule (key, days_before_sunday, at_time) values
  ('signups_open',       6, '09:00'),  -- Monday 9:00am; the play-invite goes out then
  ('signups_close',      1, '12:00'),  -- Saturday noon
  ('dev_scheduler_open', 1, '12:01'),  -- developers: time to run the Scheduler
  ('dev_reminder_1',     1, '16:00'),  -- developers: first reminder, if not locked
  ('dev_reminder_2',     1, '19:00'),  -- developers: final reminder, if not locked
  ('dev_locked_summary', 1, '19:45'),  -- developers: the locked arrangement
  ('courts_publish',     1, '20:00'),  -- player emails, Designated Courts page
  ('late_lock_until',    0, '07:00');  -- last moment to lock late
insert into public.schedule (key) values
  ('play_invite'),                     -- on/off only: sent when sign-ups open
  ('moved_off_waitlist');              -- on/off only: sent when it happens

-- A player who moved from the waitlist into a spot, waiting to be emailed.
create table public.waitlist_moves (
  id          bigint generated always as identity primary key,
  session_id  bigint not null references public.sessions (id),
  player_id   bigint not null references public.players (id),
  moved_at    timestamptz not null,
  notified_at timestamptz
);

alter table public.sessions add column play_invite_sent_at timestamptz;

alter table public.email_templates enable row level security;
alter table public.schedule        enable row level security;
alter table public.waitlist_moves  enable row level security;
revoke all on public.email_templates, public.schedule, public.waitlist_moves from anon;
revoke insert, update, delete on public.schedule, public.waitlist_moves from authenticated;
create policy email_templates_all on public.email_templates for all to authenticated
  using (is_developer()) with check (is_developer());
create policy schedule_read on public.schedule for select to authenticated using (is_developer());
create policy waitlist_moves_read on public.waitlist_moves for select to authenticated using (is_developer());

-- ---------- Schedule helpers ----------

-- The moment a schedule entry falls on, for the week of p_play_date.
create function public.sched_at(p_key text, p_play_date date) returns timestamptz
language sql stable security definer set search_path = public as $$
  select ((p_play_date - days_before_sunday) + at_time) at time zone 'America/New_York'
    from schedule where key = p_key;
$$;

create function public.sched_on(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select enabled from schedule where key = p_key), true);
$$;

create or replace function public.late_lock_until(p_play_date date) returns timestamptz
language sql stable security definer set search_path = public as $$
  select sched_at('late_lock_until', p_play_date);
$$;

-- New sessions take their deadlines from the schedule.
create or replace function public.ensure_upcoming_session() returns bigint
language plpgsql security definer set search_path = public as $$
declare
  today   date := (app_now() at time zone 'America/New_York')::date;
  sunday  date := today + ((7 - extract(isodow from today)::int) % 7);
  season  bigint;
  courts  int;
  sid     bigint;
begin
  select id into sid from sessions where play_date = sunday;
  if sid is not null then return sid; end if;

  select id into season from seasons
   where start_date <= sunday and (end_date is null or sunday <= end_date)
   order by start_date desc limit 1;
  if season is null then return null; end if;

  select num_courts into courts from sessions
   where play_date < sunday order by play_date desc limit 1;

  insert into sessions (play_date, season_id, num_courts,
                        signups_open_at, signups_close_at, courts_publish_at)
  values (sunday, season, coalesce(courts, 6),
          sched_at('signups_open', sunday), sched_at('signups_close', sunday),
          sched_at('courts_publish', sunday))
  returning id into sid;
  return sid;
end;
$$;

-- Saves the schedule after checking the times make sense. The upcoming
-- Sunday picks up the new deadlines too, unless its sign-ups already opened.
-- p_rows: [{"key": "...", "days_before_sunday": 1, "at_time": "16:00", "enabled": true}, ...]
create function public.dev_save_schedule(p_rows jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare
  r      jsonb;
  ref    date := date '2026-10-04'; -- any Sunday, to compare times
  t      jsonb := '{}'::jsonb;
  sid    bigint;
  sess   sessions;
  result text := 'Saved. The new times apply from next week';
  function_label text;
  labels jsonb := jsonb_build_object(
    'dev_scheduler_open', 'the "time to run the Scheduler" email',
    'dev_reminder_1', 'the first reminder',
    'dev_reminder_2', 'the final reminder',
    'dev_locked_summary', 'the locked summary');
begin
  perform require_developer();
  for r in select * from jsonb_array_elements(p_rows) loop
    if not exists (select 1 from schedule where key = r->>'key') then
      raise exception 'Unknown schedule entry: %', r->>'key';
    end if;
    update schedule set
      days_before_sunday = coalesce((r->>'days_before_sunday')::int, days_before_sunday),
      at_time            = coalesce((r->>'at_time')::time, at_time),
      enabled            = coalesce((r->>'enabled')::boolean, enabled)
     where key = r->>'key';
  end loop;

  -- The weekly order must hold.
  if not (sched_at('signups_open', ref) < sched_at('signups_close', ref)) then
    raise exception 'Sign-ups must open before they close';
  end if;
  foreach function_label in array array['dev_scheduler_open', 'dev_reminder_1', 'dev_reminder_2', 'dev_locked_summary'] loop
    if not (sched_at(function_label, ref) >= sched_at('signups_close', ref)
            and sched_at(function_label, ref) < sched_at('courts_publish', ref)) then
      raise exception 'Developer emails must be between sign-ups closing and the player emails going out (check %)', labels->>function_label;
    end if;
  end loop;
  if not (sched_at('dev_reminder_1', ref) < sched_at('dev_reminder_2', ref)) then
    raise exception 'The first reminder must come before the final reminder';
  end if;
  if not (sched_at('late_lock_until', ref) > sched_at('courts_publish', ref)
          and sched_at('late_lock_until', ref) <= (ref + time '09:00') at time zone 'America/New_York') then
    raise exception 'The late-lock cutoff must be after the player emails and no later than 9am Sunday';
  end if;

  sid := current_session_id();
  select * into sess from sessions where id = sid;
  if sid is not null and app_now() < sess.signups_open_at then
    update sessions set signups_open_at   = sched_at('signups_open', play_date),
                        signups_close_at  = sched_at('signups_close', play_date),
                        courts_publish_at = sched_at('courts_publish', play_date)
     where id = sid;
    result := 'Saved. The new times apply from this coming week';
  end if;
  return result;
end;
$$;

-- ---------- Off the waitlist ----------

-- Records players who now have a spot but did not before (p_before: player ids
-- that had a spot before the change). Only while sign-ups are open.
create function public.record_waitlist_moves(p_session_id bigint, p_before bigint[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if app_now() >= (select signups_close_at from sessions where id = p_session_id) then return; end if;
  insert into waitlist_moves (session_id, player_id, moved_at)
  select p_session_id, l.player_id, app_now()
    from session_lineup(p_session_id) l
   where l.has_spot and not (l.player_id = any (coalesce(p_before, '{}')));
end;
$$;

create function public.spot_holders(p_session_id bigint) returns bigint[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(player_id), '{}') from session_lineup(p_session_id) where has_spot;
$$;

create or replace function public.cancel_signup(p_player_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  me     text := my_email();
  sid    bigint;
  sess   sessions;
  before bigint[];
begin
  if me is null then raise exception 'Not a member'; end if;
  if not exists (select 1 from players where id = p_player_id and account_email = me) then
    raise exception 'That player is not linked to your account';
  end if;
  sid := current_session_id();
  select * into sess from sessions where id = sid;
  if sid is null or app_now() >= sess.signups_close_at then
    raise exception 'Cancellations closed %. After that, contact %',
      et_label(sess.signups_close_at), coalesce((select nullif(array_to_string(contact_emails, ' and/or '), '') from settings),
               'the program organizers');
  end if;
  before := spot_holders(sid);
  update signups set cancelled_at = app_now(), cancelled_by = me
   where session_id = sid and player_id = p_player_id and cancelled_at is null;
  if not found then raise exception 'Not signed up'; end if;
  perform record_waitlist_moves(sid, before);
end;
$$;

create or replace function public.dev_remove_signup(p_signup_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  s      signups;
  before bigint[];
begin
  perform require_developer();
  select * into s from signups where id = p_signup_id and cancelled_at is null;
  if s.id is null then return; end if;
  if exists (select 1 from assignments a join sessions se on se.id = a.session_id
              where a.session_id = s.session_id and a.player_id = s.player_id
                and se.locked_at is not null) then
    raise exception 'This player is on a locked court. Unlock the courts, move them off, then remove them';
  end if;
  before := spot_holders(s.session_id);
  delete from assignments where session_id = s.session_id and player_id = s.player_id;
  update signups set cancelled_at = app_now(), cancelled_by = my_email(),
                     removed_by_developer = true
   where id = p_signup_id;
  perform record_waitlist_moves(s.session_id, before);
end;
$$;

create or replace function public.dev_set_num_courts(p_session_id bigint, p_num_courts int) returns void
language plpgsql security definer set search_path = public as $$
declare
  before bigint[];
begin
  perform require_developer();
  if (select locked_at from sessions where id = p_session_id) is not null then
    raise exception 'The courts are locked. Unlock them first to change the number of courts';
  end if;
  before := spot_holders(p_session_id);
  update sessions set num_courts = p_num_courts where id = p_session_id;
  delete from assignments where session_id = p_session_id and court > p_num_courts;
  perform record_waitlist_moves(p_session_id, before);
end;
$$;

create or replace function public.dev_clear_signups() returns void
language plpgsql security definer set search_path = public as $$
declare
  sid bigint := current_session_id();
begin
  perform require_test_mode();
  delete from waitlist_moves where session_id = sid;
  delete from assignments where session_id = sid;
  delete from signups where session_id = sid;
  update sessions set locked_at = null, locked_by = null,
                      scheduler_notice_sent_at = null, reminder_4pm_sent_at = null,
                      reminder_7pm_sent_at = null, preview_sent_at = null,
                      not_locked_alert_sent_at = null, published_at = null,
                      play_invite_sent_at = null, week_mode = 'courts'
   where id = sid;
end;
$$;

-- ---------- Timed tasks, now following the schedule ----------

create or replace function public.claim_due_tasks() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  now_  timestamptz := app_now();
  sid   bigint;
  sess  sessions;
  tasks jsonb := '[]'::jsonb;
  base  jsonb;
  t_notice timestamptz;
  t_r1     timestamptz;
  t_r2     timestamptz;
  t_sum    timestamptz;
  pub      timestamptz;
  notice_end timestamptz;
  r1_end     timestamptz;
  moves    jsonb;
begin
  perform ensure_upcoming_session();
  sid := current_session_id();
  select * into sess from sessions where id = sid for update;
  if sid is null then return tasks; end if;

  pub      := sess.courts_publish_at;
  t_notice := sched_at('dev_scheduler_open', sess.play_date);
  t_r1     := sched_at('dev_reminder_1', sess.play_date);
  t_r2     := sched_at('dev_reminder_2', sess.play_date);
  t_sum    := sched_at('dev_locked_summary', sess.play_date);
  -- The window of each developer email ends where the next one starts, or
  -- at the player emails if the next one is switched off.
  notice_end := pub;
  if sched_on('dev_reminder_1') then notice_end := t_r1; end if;
  r1_end := pub;
  if sched_on('dev_reminder_2') then r1_end := t_r2; end if;

  base := jsonb_build_object(
    'now', now_,
    'session_id', sid, 'play_date', sess.play_date,
    'courts_publish_at', pub,
    'contact_emails', (select to_jsonb(contact_emails) from settings),
    'developer_emails', coalesce((select jsonb_agg(email) from accounts
                                   where is_developer and active), '[]'::jsonb),
    'signed_up', (select count(*) from session_lineup(sid)),
    'spots', sess.num_courts * 4,
    'waitlist_count', (select count(*) from session_lineup(sid) where not has_spot));

  -- Monday: the play-invite, to current members who have set up their account.
  if sched_on('play_invite') and sess.play_invite_sent_at is null
     and now_ >= sess.signups_open_at and now_ < sess.signups_close_at then
    update sessions set play_invite_sent_at = now_ where id = sid;
    tasks := tasks || jsonb_build_array(base || jsonb_build_object(
      'kind', 'play_invite',
      'recipients', coalesce((
        select jsonb_agg(a.email) from accounts a join auth.users u on u.id = a.user_id
         where a.active and a.membership_current and u.email_confirmed_at is not null), '[]'::jsonb)));
  end if;

  -- During the week: players who moved off the waitlist.
  select jsonb_agg(jsonb_build_object('email', p.account_email, 'first_name', p.first_name))
    into moves
    from waitlist_moves m join players p on p.id = m.player_id
    join accounts ac on ac.email = p.account_email and ac.active
   where m.session_id = sid and m.notified_at is null
     -- still signed up with a spot
     and exists (select 1 from session_lineup(sid) l where l.player_id = m.player_id and l.has_spot);
  update waitlist_moves set notified_at = now_ where session_id = sid and notified_at is null;
  if moves is not null and sched_on('moved_off_waitlist') then
    tasks := tasks || jsonb_build_array(base || jsonb_build_object('kind', 'moved_off_waitlist', 'players', moves));
  end if;

  -- Saturday developer emails. The window of each one ends where the next one
  -- starts (or at the player emails), so a missed one is skipped, not sent late.
  if sched_on('dev_scheduler_open') and sess.scheduler_notice_sent_at is null
     and now_ >= t_notice and now_ < notice_end then
    update sessions set scheduler_notice_sent_at = now_ where id = sid;
    tasks := tasks || jsonb_build_array(base || jsonb_build_object(
      'kind', 'dev_scheduler_open', 'locked', sess.locked_at is not null));
  end if;

  if sched_on('dev_reminder_1') and sess.locked_at is null and sess.reminder_4pm_sent_at is null
     and now_ >= t_r1 and now_ < r1_end then
    update sessions set reminder_4pm_sent_at = now_ where id = sid;
    tasks := tasks || jsonb_build_array(base || jsonb_build_object('kind', 'dev_reminder_1'));
  end if;

  if sched_on('dev_reminder_2') and sess.locked_at is null and sess.reminder_7pm_sent_at is null
     and now_ >= t_r2 and now_ < pub then
    update sessions set reminder_7pm_sent_at = now_ where id = sid;
    tasks := tasks || jsonb_build_array(base || jsonb_build_object('kind', 'dev_reminder_2'));
  end if;

  if sched_on('dev_locked_summary') and sess.locked_at is not null
     and (sess.preview_sent_at is null or sess.locked_at > sess.preview_sent_at)
     and now_ >= t_sum and now_ < pub then
    tasks := tasks || jsonb_build_array(base || jsonb_build_object(
      'kind', 'preview',
      'week_mode', sess.week_mode,
      'updated', sess.preview_sent_at is not null,
      'courts', session_courts(sid),
      'waitlist', coalesce((select jsonb_agg(name) from session_left_over(sid)
                             where waitlist_place is not null), '[]'::jsonb),
      'left_over_count', (select count(*) from session_left_over(sid)),
      'locked_at', sess.locked_at,
      'locked_by_email', sess.locked_by,
      'locked_by_name', coalesce((select first_name || ' ' || last_name from players
                                   where account_email = sess.locked_by
                                   order by id limit 1), sess.locked_by)));
    update sessions set preview_sent_at = now_ where id = sid;
  end if;

  if sess.locked_at is null and sess.not_locked_alert_sent_at is null
     and now_ >= pub and now_ < late_lock_until(sess.play_date) then
    update sessions set not_locked_alert_sent_at = now_ where id = sid;
    tasks := tasks || jsonb_build_array(base || jsonb_build_object(
      'kind', 'not_locked_alert', 'late_lock_until', late_lock_until(sess.play_date)));
  end if;

  -- On time, or right after a late lock.
  if sess.locked_at is not null and sess.published_at is null and now_ >= pub then
    update sessions set published_at = now_ where id = sid;
    if sess.week_mode <> 'courts' then
      tasks := tasks || jsonb_build_array(base || jsonb_build_object(
        'kind', 'weather', 'week_mode', sess.week_mode,
        'recipients', coalesce((
          select jsonb_agg(distinct p.account_email)
            from session_lineup(sid) l join players p on p.id = l.player_id
            join accounts ac on ac.email = p.account_email and ac.active), '[]'::jsonb)));
    else
      tasks := tasks || jsonb_build_array(base || jsonb_build_object(
        'kind', 'publish',
        'courts', session_courts(sid),
        'court_recipients', coalesce((
          select jsonb_agg(distinct p.account_email)
            from assignments a join players p on p.id = a.player_id
            join accounts ac on ac.email = p.account_email and ac.active
           where a.session_id = sid), '[]'::jsonb),
        'waitlist', coalesce((select jsonb_agg(name) from session_left_over(sid)
                               where waitlist_place is not null), '[]'::jsonb),
        'no_spot', coalesce((
          select jsonb_agg(jsonb_build_object('email', o.account_email, 'first_name', o.first_name,
                                              'waitlist_place', o.waitlist_place))
            from session_left_over(sid) o
            join accounts ac on ac.email = o.account_email and ac.active), '[]'::jsonb)));
    end if;
  end if;
  return tasks;
end;
$$;

-- For the setup-invite: names of the players linked to an account.
create function public.account_player_names(p_email text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(string_agg(first_name || ' ' || last_name, ' and ' order by id), p_email)
    from players where account_email = p_email and active;
$$;

-- The Developer area and test clock need the schedule too.
create function public.dev_schedule() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_developer();
  return (select jsonb_agg(to_jsonb(s) order by s.key) from schedule s);
end;
$$;

revoke all on function public.sched_at(text, date), public.sched_on(text),
  public.record_waitlist_moves(bigint, bigint[]), public.spot_holders(bigint),
  public.account_player_names(text) from anon, authenticated, public;
revoke all on function public.dev_save_schedule(jsonb), public.dev_schedule() from anon, public;
grant execute on function public.dev_save_schedule(jsonb), public.dev_schedule() to authenticated;
grant execute on function public.account_player_names(text) to service_role;

-- The schedule of the upcoming Sunday as actual times, for the test clock shortcuts.
create function public.dev_week_times() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  pd date;
begin
  perform require_developer();
  select play_date into pd from sessions where id = current_session_id();
  if pd is null then return '{}'::jsonb; end if;
  return (select jsonb_object_agg(key, sched_at(key, pd)) from schedule where at_time is not null);
end;
$$;
revoke all on function public.dev_week_times() from anon, public;
grant execute on function public.dev_week_times() to authenticated;
