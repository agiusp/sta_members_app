-- Phase 1: members, linked players, seasons, Sunday sessions and sign-ups.
--
-- Security model: every table has row-level security on. Members read only
-- their own account and linked players; all writes that have rules attached
-- (sign up, cancel, deadlines, capacity) go through the functions below,
-- which run with elevated rights and check the caller themselves.
-- Developers can read and manage everything.

-- ---------- Tables ----------

-- One row per sign-in email. Only emails listed here can be invited.
create table public.accounts (
  email        text primary key check (email = lower(trim(email)) and email like '%@%'),
  user_id      uuid unique references auth.users (id) on delete set null,
  is_developer boolean not null default false,
  -- false = removed from the program: can't sign in to anything.
  active       boolean not null default true,
  -- false = membership not renewed this year: can sign in, but signing up
  -- shows the dues message instead.
  membership_current boolean not null default true,
  created_at   timestamptz not null default now()
);

-- A person who plays. Several players can share one account (family members).
create table public.players (
  id            bigint generated always as identity primary key,
  account_email text not null references public.accounts (email) on update cascade,
  first_name    text not null check (trim(first_name) <> ''),
  last_name     text not null check (trim(last_name) <> ''),
  level         text,
  sex           text check (sex in ('M', 'F')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index players_account_email_idx on public.players (account_email);

create table public.seasons (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  start_date date not null,
  end_date   date,
  check (end_date is null or end_date >= start_date)
);

-- One row per Sunday. The deadline timestamps are filled in when the session
-- is created (see ensure_upcoming_session) and can be adjusted per week.
create table public.sessions (
  id                bigint generated always as identity primary key,
  play_date         date not null unique check (extract(isodow from play_date) = 7),
  season_id         bigint references public.seasons (id),
  num_courts        int not null default 6 check (num_courts between 1 and 7),
  status            text not null default 'scheduled' check (status in ('scheduled', 'no_play')),
  signups_open_at   timestamptz not null,
  signups_close_at  timestamptz not null,
  courts_publish_at timestamptz not null,
  created_at        timestamptz not null default now()
);

-- Sign-up order is signed_up_at. Cancelling sets cancelled_at rather than
-- deleting, so the history is kept. The first (courts x 4) active sign-ups
-- have a spot; everyone after them is on the waitlist, so a cancellation
-- automatically moves the next person up.
create table public.signups (
  id           bigint generated always as identity primary key,
  session_id   bigint not null references public.sessions (id),
  player_id    bigint not null references public.players (id),
  signed_up_at timestamptz not null,
  signed_up_by text not null,
  cancelled_at timestamptz,
  cancelled_by text,
  removed_by_developer boolean not null default false
);
create unique index signups_one_active_per_player
  on public.signups (session_id, player_id) where cancelled_at is null;
create index signups_session_idx on public.signups (session_id, signed_up_at);

-- Single-row app settings.
create table public.settings (
  id               boolean primary key default true check (id),
  -- Who to contact after the Saturday noon cutoff. Set from the Developer
  -- area; kept out of this file because the repo is public.
  contact_emails   text[] not null default '{}',
  -- Shown to lapsed members when they try to sign up.
  dues_message     text not null default 'Our records show that your STA membership has not been renewed for this year. Please pay your membership dues first, and then you''ll be able to sign up.',
  -- Test clock: only honoured when test_mode is on. Must stay off online.
  test_mode        boolean not null default false,
  test_clock       timestamptz
);
insert into public.settings default values;

-- ---------- Helpers ----------

-- The current time, or the test clock when test mode is on.
create function public.app_now() returns timestamptz
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select test_clock from settings where test_mode and test_clock is not null),
    now());
$$;

-- A moment as members read it, e.g. "Monday 9:00am" (US Eastern).
create function public.et_label(p_ts timestamptz) returns text
language sql stable as $$
  select to_char(p_ts at time zone 'America/New_York', 'FMDay FMHH12:MIam');
$$;

-- Email of the signed-in caller's active account, or null.
create function public.my_email() returns text
language sql stable security definer set search_path = public as $$
  select email from accounts where user_id = auth.uid() and active;
$$;

create function public.is_developer() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select is_developer from accounts where user_id = auth.uid() and active),
    false);
$$;

-- Link a new sign-in user to their account row (users are only ever created
-- by invite, and invites are only sent for emails in accounts).
create function public.link_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update accounts set user_id = new.id where email = lower(new.email);
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.link_auth_user();

-- Create the session for the next Sunday (today counts if it is Sunday), if
-- it's within a season and doesn't exist yet. The court count carries over
-- from the most recent earlier session. Deadlines, all US Eastern:
--   sign-ups open Monday 09:00, close Saturday 12:00, courts publish Saturday 20:00.
create function public.ensure_upcoming_session() returns bigint
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
          ((sunday - 6) + time '09:00') at time zone 'America/New_York',
          ((sunday - 1) + time '12:00') at time zone 'America/New_York',
          ((sunday - 1) + time '20:00') at time zone 'America/New_York')
  returning id into sid;
  return sid;
end;
$$;

-- The session members are currently dealing with: the next scheduled Sunday
-- on or after today.
create function public.current_session_id() returns bigint
language sql stable security definer set search_path = public as $$
  select id from sessions
   where play_date >= (app_now() at time zone 'America/New_York')::date
     and status = 'scheduled'
   order by play_date limit 1;
$$;

-- Active sign-ups for a session in sign-up order, with each one's place and
-- whether it has a spot or is on the waitlist.
create function public.session_lineup(p_session_id bigint)
returns table (signup_id bigint, player_id bigint, place int, has_spot boolean,
               waitlist_place int, signed_up_at timestamptz)
language sql stable security definer set search_path = public as $$
  with ordered as (
    select s.id, s.player_id, s.signed_up_at,
           row_number() over (order by s.signed_up_at, s.id)::int as place
      from signups s
     where s.session_id = p_session_id and s.cancelled_at is null
  ), cap as (
    select num_courts * 4 as capacity from sessions where id = p_session_id
  )
  select o.id, o.player_id, o.place, o.place <= cap.capacity,
         case when o.place > cap.capacity then o.place - cap.capacity end,
         o.signed_up_at
    from ordered o cross join cap
   order by o.place;
$$;

-- ---------- Member functions ----------

-- Everything the sign-up page needs, for the signed-in member only.
create function public.my_week() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me    text := my_email();
  now_  timestamptz := app_now();
  sid   bigint;
  sess  sessions;
  phase text;
begin
  if me is null then raise exception 'Not a member'; end if;
  perform ensure_upcoming_session();
  sid := current_session_id();
  select * into sess from sessions where id = sid;

  phase := case
    when sid is null then 'none'
    when now_ < sess.signups_open_at then 'not_open'
    when now_ < sess.signups_close_at then 'open'
    else 'closed' end;

  return jsonb_build_object(
    'now', now_,
    'test_mode', (select test_mode from settings),
    'contact_emails', (select to_jsonb(contact_emails) from settings),
    'is_developer', is_developer(),
    'membership_current', (select membership_current from accounts where email = me),
    'dues_message', (select dues_message from settings),
    'phase', phase,
    'session', case when sid is null then null else jsonb_build_object(
      'id', sess.id, 'play_date', sess.play_date, 'num_courts', sess.num_courts,
      'capacity', sess.num_courts * 4,
      'signups_open_at', sess.signups_open_at,
      'signups_close_at', sess.signups_close_at,
      'courts_publish_at', sess.courts_publish_at,
      'filled', (select count(*) from session_lineup(sid) where has_spot),
      'waitlist', (select count(*) from session_lineup(sid) where not has_spot)) end,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
               'signed_up', l.signup_id is not null,
               'has_spot', l.has_spot,
               'waitlist_place', l.waitlist_place)
             order by p.first_name, p.last_name)
        from players p
        left join session_lineup(sid) l on l.player_id = p.id
       where p.account_email = me and p.active), '[]'::jsonb));
end;
$$;

create function public.sign_up(p_player_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  me   text := my_email();
  sid  bigint;
  sess sessions;
begin
  if me is null then raise exception 'Not a member'; end if;
  if not exists (select 1 from players
                  where id = p_player_id and account_email = me and active) then
    raise exception 'That player is not linked to your account';
  end if;
  if not (select membership_current from accounts where email = me) then
    raise exception '%', (select dues_message from settings);
  end if;
  sid := current_session_id();
  select * into sess from sessions where id = sid;
  if sid is null then raise exception 'There is no upcoming Sunday session'; end if;
  if app_now() < sess.signups_open_at then
    raise exception 'Sign-ups for this Sunday open %', et_label(sess.signups_open_at);
  end if;
  if app_now() >= sess.signups_close_at then
    raise exception 'Sign-ups for this Sunday closed %', et_label(sess.signups_close_at);
  end if;
  if exists (select 1 from signups where session_id = sid
                and player_id = p_player_id and cancelled_at is null) then
    raise exception 'Already signed up';
  end if;
  insert into signups (session_id, player_id, signed_up_at, signed_up_by)
  values (sid, p_player_id, app_now(), me);
end;
$$;

create function public.cancel_signup(p_player_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  me   text := my_email();
  sid  bigint;
  sess sessions;
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
  update signups set cancelled_at = app_now(), cancelled_by = me
   where session_id = sid and player_id = p_player_id and cancelled_at is null;
  if not found then raise exception 'Not signed up'; end if;
end;
$$;

-- ---------- Developer functions ----------

create function public.require_developer() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_developer() then raise exception 'Developers only'; end if;
end;
$$;

-- Full line-up for the current session, with names.
create function public.dev_week() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sid bigint;
begin
  perform require_developer();
  perform ensure_upcoming_session();
  sid := current_session_id();
  return jsonb_build_object(
    'now', app_now(),
    'settings', (select to_jsonb(s) - 'id' from settings s),
    'session', (select to_jsonb(s) from sessions s where id = sid),
    'lineup', coalesce((
      select jsonb_agg(jsonb_build_object(
               'signup_id', l.signup_id, 'place', l.place, 'has_spot', l.has_spot,
               'waitlist_place', l.waitlist_place, 'signed_up_at', l.signed_up_at,
               'player_id', p.id, 'name', p.first_name || ' ' || p.last_name,
               'level', p.level, 'sex', p.sex, 'account_email', p.account_email)
             order by l.place)
        from session_lineup(sid) l join players p on p.id = l.player_id), '[]'::jsonb));
end;
$$;

create function public.dev_set_num_courts(p_session_id bigint, p_num_courts int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  update sessions set num_courts = p_num_courts where id = p_session_id;
end;
$$;

-- Emergency removal after the deadline (or any time). Recorded, not deleted.
create function public.dev_remove_signup(p_signup_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  update signups set cancelled_at = app_now(), cancelled_by = my_email(),
                     removed_by_developer = true
   where id = p_signup_id and cancelled_at is null;
end;
$$;

-- Accounts with their sign-in status: 'not_invited', 'invited' (invite sent
-- but not accepted yet, so it can be resent) or 'active' (password set).
create function public.dev_members() returns table (
  email text, is_developer boolean, active boolean, membership_current boolean,
  signin_status text, invited_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_developer();
  return query
  select a.email, a.is_developer, a.active, a.membership_current,
         case when u.id is null then 'not_invited'
              when u.email_confirmed_at is null then 'invited'
              else 'active' end,
         u.invited_at
    from accounts a left join auth.users u on u.id = a.user_id
   order by a.email;
end;
$$;

create function public.dev_set_test_clock(p_clock timestamptz) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if not (select test_mode from settings) then
    raise exception 'The test clock is only available in test mode';
  end if;
  update settings set test_clock = p_clock where id;
end;
$$;

-- ---------- Test-mode tools (refuse to run unless test_mode is on) ----------

create function public.require_test_mode() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_developer();
  if not (select test_mode from settings) then
    raise exception 'Only available in test mode';
  end if;
end;
$$;

-- Signs up p_count random active players who aren't signed up yet, one
-- minute apart, ending at the (test) clock's current time.
create function public.dev_simulate_signups(p_count int) returns int
language plpgsql security definer set search_path = public as $$
declare
  sid   bigint;
  sess  sessions;
  now_  timestamptz := app_now();
  added int := 0;
  p     record;
begin
  perform require_test_mode();
  perform ensure_upcoming_session();
  sid := current_session_id();
  select * into sess from sessions where id = sid;
  if sid is null then raise exception 'There is no upcoming Sunday session'; end if;
  if now_ < sess.signups_open_at or now_ >= sess.signups_close_at then
    raise exception 'Set the test clock to a time when sign-ups are open first';
  end if;
  for p in
    select pl.id from players pl
     where pl.active
       and pl.account_email in (select email from accounts where active and membership_current)
       and not exists (select 1 from signups s where s.session_id = sid
                         and s.player_id = pl.id and s.cancelled_at is null)
     order by random() limit greatest(p_count, 0)
  loop
    insert into signups (session_id, player_id, signed_up_at, signed_up_by)
    values (sid, p.id,
            greatest(sess.signups_open_at, now_ - make_interval(mins => p_count - added)),
            'simulated');
    added := added + 1;
  end loop;
  return added;
end;
$$;

-- Deletes every sign-up for the upcoming Sunday.
create function public.dev_clear_signups() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_test_mode();
  delete from signups where session_id = current_session_id();
end;
$$;

-- ---------- Row-level security ----------

alter table public.accounts enable row level security;
alter table public.players  enable row level security;
alter table public.seasons  enable row level security;
alter table public.sessions enable row level security;
alter table public.signups  enable row level security;
alter table public.settings enable row level security;

-- Nothing is readable without signing in, and signed-in users may only call
-- the functions granted explicitly at the end.
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon, authenticated, public;

-- Sign-ups change only through the functions; settings only the emergency
-- email directly (test mode can't be switched on from the app at all).
revoke insert, update, delete on public.signups from authenticated;
revoke insert, update, delete on public.settings from authenticated;
grant update (contact_emails, dues_message) on public.settings to authenticated;

create policy accounts_read on public.accounts for select to authenticated
  using (user_id = auth.uid() or is_developer());
create policy accounts_write on public.accounts for all to authenticated
  using (is_developer()) with check (is_developer());

create policy players_read on public.players for select to authenticated
  using (account_email = my_email() or is_developer());
create policy players_write on public.players for all to authenticated
  using (is_developer()) with check (is_developer());

create policy seasons_read on public.seasons for select to authenticated using (true);
create policy seasons_write on public.seasons for all to authenticated
  using (is_developer()) with check (is_developer());

create policy sessions_read on public.sessions for select to authenticated using (true);
create policy sessions_write on public.sessions for all to authenticated
  using (is_developer()) with check (is_developer());

-- Sign-ups are only changed through sign_up / cancel_signup / dev_ functions.
create policy signups_read on public.signups for select to authenticated
  using (is_developer()
         or player_id in (select id from players where account_email = my_email()));

create policy settings_read on public.settings for select to authenticated using (true);
create policy settings_write on public.settings for update to authenticated
  using (is_developer()) with check (is_developer());

-- Functions members may call.
grant execute on function public.my_week(), public.sign_up(bigint),
  public.cancel_signup(bigint), public.is_developer()
  to authenticated;
-- Developer functions check the role themselves.
grant execute on function public.dev_week(), public.dev_set_num_courts(bigint, int),
  public.dev_remove_signup(bigint), public.dev_set_test_clock(timestamptz),
  public.dev_members(), public.dev_simulate_signups(int), public.dev_clear_signups()
  to authenticated;
-- Used inside row-level security policies.
grant execute on function public.my_email() to authenticated;
