-- Phase 4: the Saturday developer reminders and 20:00 emails, and the
-- Designated Courts page.
--
-- Timed tasks are run by the "timed-tasks" function, which online is called
-- every minute by a scheduler (and locally by a test button). Each run claims
-- whatever is due, once. Each developer email has a time window, and one
-- whose window has passed is skipped rather than sent late:
--   12:01-16:00 Sat  always                  -> "sign-ups closed, run the Scheduler"
--   16:00-19:00 Sat  courts not locked yet   -> reminder
--   19:00-20:00 Sat  courts not locked yet   -> final reminder
--   19:45-20:00 Sat  courts locked           -> the arrangement, who locked it
--                                               (sent again if re-locked later)
--   from 20:00 Sat   courts locked           -> court email to every assigned
--                                               player, no-spot email to the rest
--                                               (weather option: the weather
--                                               email to everyone signed up)
--   20:00-07:00 Sun  courts not locked       -> alert to developers; if they
--                                               lock late, the emails above go
--                                               out on the next run

alter table public.sessions
  add column scheduler_notice_sent_at timestamptz,
  add column reminder_4pm_sent_at     timestamptz,
  add column reminder_7pm_sent_at     timestamptz,
  add column preview_sent_at          timestamptz,
  add column not_locked_alert_sent_at timestamptz,
  add column published_at             timestamptz;

-- Every email the app sends, for troubleshooting.
create table public.email_log (
  id         bigint generated always as identity primary key,
  session_id bigint references public.sessions (id),
  kind       text not null,
  to_email   text not null,
  subject    text not null,
  sent_at    timestamptz not null default now(),
  error      text
);
alter table public.email_log enable row level security;
revoke all on public.email_log from anon;
revoke insert, update, delete on public.email_log from authenticated;
create policy email_log_read on public.email_log for select to authenticated
  using (is_developer());

-- Courts of a session in court order, with names and ball-bringers.
create function public.session_courts(p_session_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(c order by (c->>'court')::int), '[]'::jsonb) from (
    select jsonb_build_object('court', a.court, 'players', jsonb_agg(jsonb_build_object(
             'name', p.first_name || ' ' || p.last_name, 'brings_balls', a.brings_balls)
             order by a.brings_balls desc, p.first_name, p.last_name)) as c
      from assignments a join players p on p.id = a.player_id
     where a.session_id = p_session_id
     group by a.court) x;
$$;

-- Signed-up players not on any court, in sign-up order. waitlist_place is set
-- for real waitlist players; players who had a spot but were left off courts
-- get null.
create function public.session_left_over(p_session_id bigint)
returns table (player_id bigint, first_name text, name text, account_email text, waitlist_place int)
language sql stable security definer set search_path = public as $$
  select p.id, p.first_name, p.first_name || ' ' || p.last_name, p.account_email, l.waitlist_place
    from session_lineup(p_session_id) l join players p on p.id = l.player_id
   where not exists (select 1 from assignments a
                      where a.session_id = p_session_id and a.player_id = l.player_id)
   order by l.place;
$$;

-- Claims the tasks that are due now and returns everything needed to send
-- their emails. Only the timed-tasks function (service role) calls this.
create function public.claim_due_tasks() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  now_  timestamptz := app_now();
  sid   bigint;
  sess  sessions;
  tasks jsonb := '[]'::jsonb;
  base  jsonb;
  sat   date;
  t4pm  timestamptz;
  t7pm  timestamptz;
  t745  timestamptz;
begin
  perform ensure_upcoming_session();
  sid := current_session_id();
  select * into sess from sessions where id = sid for update;
  if sid is null then return tasks; end if;

  base := jsonb_build_object(
    'now', now_,
    'session_id', sid, 'play_date', sess.play_date,
    'courts_publish_at', sess.courts_publish_at,
    'contact_emails', (select to_jsonb(contact_emails) from settings),
    'developer_emails', coalesce((select jsonb_agg(email) from accounts
                                   where is_developer and active), '[]'::jsonb));

  base := base || jsonb_build_object(
    'signed_up', (select count(*) from session_lineup(sid)),
    'spots', sess.num_courts * 4,
    'waitlist_count', (select count(*) from session_lineup(sid) where not has_spot));

  sat  := sess.play_date - 1;
  t4pm := (sat + time '16:00') at time zone 'America/New_York';
  t7pm := (sat + time '19:00') at time zone 'America/New_York';
  t745 := (sat + time '19:45') at time zone 'America/New_York';

  if sess.scheduler_notice_sent_at is null
     and now_ >= sess.signups_close_at + interval '1 minute' and now_ < t4pm then
    update sessions set scheduler_notice_sent_at = now_ where id = sid;
    tasks := tasks || jsonb_build_array(base || jsonb_build_object(
      'kind', 'scheduler_open', 'locked', sess.locked_at is not null));
  end if;

  if sess.locked_at is null and sess.reminder_4pm_sent_at is null
     and now_ >= t4pm and now_ < t7pm then
    update sessions set reminder_4pm_sent_at = now_ where id = sid;
    tasks := tasks || jsonb_build_array(base || jsonb_build_object('kind', 'lock_reminder', 'final', false));
  end if;

  if sess.locked_at is null and sess.reminder_7pm_sent_at is null
     and now_ >= t7pm and now_ < sess.courts_publish_at then
    update sessions set reminder_7pm_sent_at = now_ where id = sid;
    tasks := tasks || jsonb_build_array(base || jsonb_build_object('kind', 'lock_reminder', 'final', true));
  end if;

  if sess.locked_at is not null
     and (sess.preview_sent_at is null or sess.locked_at > sess.preview_sent_at)
     and now_ >= t745 and now_ < sess.courts_publish_at then
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
     and now_ >= sess.courts_publish_at and now_ < late_lock_until(sess.play_date) then
    update sessions set not_locked_alert_sent_at = now_ where id = sid;
    tasks := tasks || jsonb_build_array(base || jsonb_build_object(
      'kind', 'not_locked_alert', 'late_lock_until', late_lock_until(sess.play_date)));
  end if;

  -- On time at 20:00, or right after a late lock.
  if sess.locked_at is not null and sess.published_at is null and now_ >= sess.courts_publish_at then
    update sessions set published_at = now_ where id = sid;
    if sess.week_mode <> 'courts' then
      tasks := tasks || jsonb_build_array(base || jsonb_build_object(
        'kind', 'weather', 'week_mode', sess.week_mode,
        -- Everyone signed up, waitlist included, one email per account.
        'recipients', coalesce((
          select jsonb_agg(distinct p.account_email)
            from session_lineup(sid) l join players p on p.id = l.player_id
            join accounts ac on ac.email = p.account_email and ac.active), '[]'::jsonb)));
    else
      tasks := tasks || jsonb_build_array(base || jsonb_build_object(
        'kind', 'publish',
        'courts', session_courts(sid),
        -- One court email per account (family members share an email).
        'court_recipients', coalesce((
          select jsonb_agg(distinct p.account_email)
            from assignments a join players p on p.id = a.player_id
            join accounts ac on ac.email = p.account_email and ac.active
           where a.session_id = sid), '[]'::jsonb),
        'waitlist', coalesce((select jsonb_agg(name) from session_left_over(sid)
                               where waitlist_place is not null), '[]'::jsonb),
        -- One no-spot email per player, addressed to them by name.
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

-- The Designated Courts page: all courts for the upcoming Sunday, once
-- they're final (Saturday 20:00). Any signed-in member can see them.
create function public.my_courts() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sid  bigint;
  sess sessions;
  ready boolean;
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  perform ensure_upcoming_session();
  sid := current_session_id();
  select * into sess from sessions where id = sid;
  if sid is null then return jsonb_build_object('session', null); end if;
  -- Ready from 20:00 if locked on time, or as soon as a late lock happens.
  ready := app_now() >= sess.courts_publish_at and sess.locked_at is not null;
  return jsonb_build_object(
    'now', app_now(),
    'test_mode', (select test_mode from settings),
    'session', jsonb_build_object('play_date', sess.play_date,
                                  'courts_publish_at', sess.courts_publish_at),
    'ready', ready,
    'week_mode', case when ready then sess.week_mode end,
    'contact_emails', (select to_jsonb(contact_emails) from settings),
    'not_locked', app_now() >= sess.courts_publish_at and sess.locked_at is null,
    'courts', case when ready and sess.week_mode = 'courts' then session_courts(sid) end,
    'waitlist', case when ready and sess.week_mode = 'courts' then coalesce((select jsonb_agg(name) from session_left_over(sid)
                                                where waitlist_place is not null), '[]'::jsonb) end);
end;
$$;

revoke all on function public.session_courts(bigint), public.session_left_over(bigint),
  public.claim_due_tasks(), public.my_courts() from anon, authenticated, public;
grant execute on function public.claim_due_tasks() to service_role;
grant execute on function public.my_courts() to authenticated;

-- Test mode: clearing a week also forgets which of its emails were sent.
create or replace function public.dev_clear_signups() returns void
language plpgsql security definer set search_path = public as $$
declare
  sid bigint := current_session_id();
begin
  perform require_test_mode();
  delete from assignments where session_id = sid;
  delete from signups where session_id = sid;
  update sessions set locked_at = null, locked_by = null,
                      scheduler_notice_sent_at = null, reminder_4pm_sent_at = null,
                      reminder_7pm_sent_at = null, preview_sent_at = null,
                      not_locked_alert_sent_at = null, published_at = null, week_mode = 'courts'
   where id = sid;
end;
$$;

-- There must always be at least one active developer, so nobody can remove
-- the last one (including themselves) by accident.
create function public.keep_a_developer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from accounts where is_developer and active) then
    raise exception 'There must be at least one developer. Make someone else a developer first';
  end if;
  return null;
end;
$$;
create constraint trigger accounts_keep_a_developer
  after update or delete on public.accounts
  deferrable initially deferred
  for each row execute function public.keep_a_developer();
