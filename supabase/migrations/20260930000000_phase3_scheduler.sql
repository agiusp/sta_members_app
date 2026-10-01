-- Phase 3: court assignments, lock/unlock, and play history for the scheduler.
--
-- Saturday flow (US Eastern): sign-ups close at 12:00; from then until 20:00 a
-- developer arranges courts and locks them, and may unlock, edit and re-lock.
-- At 20:00 the locked assignments are final and emailed (Phase 4). If nobody
-- locked by 20:00, a developer can still lock until Sunday 07:00 ("late
-- lock"); the emails then go out right away and the lock is final at once.
--
-- Instead of assigning courts, a developer can lock the week in a weather
-- mode: 'rain_expected' (a rain-out is expected; show up anyway if the
-- forecast is wrong) or 'self_organized' (uncertain weather; show up and
-- self-organize). Either way no courts are assigned.
-- Assignments of earlier Sundays are the play history used for the ball
-- roster and the repeat-grouping check.

alter table public.sessions
  add column week_mode text not null default 'courts'
    check (week_mode in ('courts', 'rain_expected', 'self_organized')),
  add column org_play  text check (org_play in ('same-sex', 'mixed', 'level', 'level-samesex', 'level-mixed')),
  add column locked_at timestamptz,
  add column locked_by text;

create table public.assignments (
  session_id   bigint not null references public.sessions (id),
  court        int not null check (court between 1 and 7),
  player_id    bigint not null references public.players (id),
  brings_balls boolean not null default false,
  primary key (session_id, player_id)
);
create index assignments_court_idx on public.assignments (session_id, court);

alter table public.assignments enable row level security;
revoke all on public.assignments from anon;
revoke insert, update, delete on public.assignments from authenticated;
-- Members get their own court in Phase 4 (Designated Courts page).
create policy assignments_read on public.assignments for select to authenticated
  using (is_developer());

-- Everything the scheduler page needs for the upcoming Sunday.
create function public.dev_scheduler_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sid  bigint;
  sess sessions;
begin
  perform require_developer();
  perform ensure_upcoming_session();
  sid := current_session_id();
  select * into sess from sessions where id = sid;
  return jsonb_build_object(
    'now', app_now(),
    'test_mode', (select test_mode from settings),
    'session', to_jsonb(sess) || jsonb_build_object('late_lock_until', late_lock_until(sess.play_date)),
    'lineup', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
               'level', p.level, 'sex', p.sex, 'place', l.place,
               'has_spot', l.has_spot, 'waitlist_place', l.waitlist_place,
               'signup_id', l.signup_id)
             order by l.place)
        from session_lineup(sid) l join players p on p.id = l.player_id), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'court', a.court, 'player_id', a.player_id, 'brings_balls', a.brings_balls))
        from assignments a where a.session_id = sid), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
               'play_date', se.play_date, 'court', a.court,
               'player_id', a.player_id, 'brings_balls', a.brings_balls)
             order by se.play_date, a.court)
        from assignments a join sessions se on se.id = a.session_id
       where se.play_date < sess.play_date and se.locked_at is not null), '[]'::jsonb));
end;
$$;

-- Last moment a developer can still lock a week nobody locked by 8pm Saturday.
create function public.late_lock_until(p_play_date date) returns timestamptz
language sql immutable as $$
  select (p_play_date + time '07:00') at time zone 'America/New_York';
$$;

-- p_courts: [{"court": 1, "players": [{"player_id": 12, "brings_balls": true}, ...]}, ...]
-- p_mode: 'courts', or a weather mode with p_courts = [].
create function public.dev_lock_courts(p_org_play text, p_courts jsonb, p_mode text default 'courts')
returns void
language plpgsql security definer set search_path = public as $$
declare
  sid  bigint;
  sess sessions;
  now_ timestamptz := app_now();
begin
  perform require_developer();
  sid := current_session_id();
  select * into sess from sessions where id = sid;
  if sid is null then raise exception 'There is no upcoming Sunday session'; end if;
  if now_ < sess.signups_close_at then
    raise exception 'Courts can be locked once sign-ups close, %', et_label(sess.signups_close_at);
  end if;
  if sess.locked_at is not null then
    raise exception 'The courts are already locked. Unlock them first to make changes';
  end if;
  if now_ >= late_lock_until(sess.play_date) then
    raise exception 'It is too late to lock the courts: the cutoff was %', et_label(late_lock_until(sess.play_date));
  end if;
  if p_mode not in ('courts', 'rain_expected', 'self_organized') then
    raise exception 'Unknown option for this week';
  end if;

  if p_mode <> 'courts' then
    if jsonb_array_length(coalesce(p_courts, '[]'::jsonb)) > 0 then
      raise exception 'No courts are assigned when the week is set to a weather option';
    end if;
    delete from assignments where session_id = sid;
    update sessions set locked_at = now_, locked_by = my_email(), org_play = null, week_mode = p_mode
     where id = sid;
    return;
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_courts) c, jsonb_array_elements(c->'players') p
     group by p->>'player_id' having count(*) > 1) then
    raise exception 'A player is on more than one court';
  end if;

  delete from assignments where session_id = sid;
  insert into assignments (session_id, court, player_id, brings_balls)
  select sid, (c->>'court')::int, (p->>'player_id')::bigint,
         coalesce((p->>'brings_balls')::boolean, false)
    from jsonb_array_elements(p_courts) c, jsonb_array_elements(c->'players') p;

  if exists (select 1 from assignments where session_id = sid and court > sess.num_courts) then
    raise exception 'There are only % courts this week', sess.num_courts;
  end if;
  if exists (select 1 from assignments where session_id = sid
              group by court having count(*) > 4) then
    raise exception 'A court can have at most 4 players';
  end if;
  if exists (select 1 from assignments where session_id = sid
              group by court having count(*) filter (where brings_balls) > 1) then
    raise exception 'Each court can have only one ball-bringer';
  end if;
  if exists (select 1 from assignments a where a.session_id = sid and not exists (
               select 1 from signups s where s.session_id = sid
                  and s.player_id = a.player_id and s.cancelled_at is null)) then
    raise exception 'Only players signed up for this Sunday can be put on a court';
  end if;

  update sessions set locked_at = now_, locked_by = my_email(), org_play = p_org_play,
                      week_mode = 'courts'
   where id = sid;
end;
$$;

-- Unlocking keeps the saved assignments as the starting point for edits.
create function public.dev_unlock_courts() returns void
language plpgsql security definer set search_path = public as $$
declare
  sid  bigint;
  sess sessions;
begin
  perform require_developer();
  sid := current_session_id();
  select * into sess from sessions where id = sid;
  if sid is null or sess.locked_at is null then raise exception 'The courts are not locked'; end if;
  if app_now() >= sess.courts_publish_at then
    raise exception 'Court assignments became final % and can no longer be changed', et_label(sess.courts_publish_at);
  end if;
  update sessions set locked_at = null, locked_by = null where id = sid;
end;
$$;

-- Changing the line-up or court count must not silently break locked courts.
create or replace function public.dev_remove_signup(p_signup_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  s signups;
begin
  perform require_developer();
  select * into s from signups where id = p_signup_id and cancelled_at is null;
  if s.id is null then return; end if;
  if exists (select 1 from assignments a join sessions se on se.id = a.session_id
              where a.session_id = s.session_id and a.player_id = s.player_id
                and se.locked_at is not null) then
    raise exception 'This player is on a locked court. Unlock the courts, move them off, then remove them';
  end if;
  delete from assignments where session_id = s.session_id and player_id = s.player_id;
  update signups set cancelled_at = app_now(), cancelled_by = my_email(),
                     removed_by_developer = true
   where id = p_signup_id;
end;
$$;

create or replace function public.dev_set_num_courts(p_session_id bigint, p_num_courts int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if (select locked_at from sessions where id = p_session_id) is not null then
    raise exception 'The courts are locked. Unlock them first to change the number of courts';
  end if;
  update sessions set num_courts = p_num_courts where id = p_session_id;
  delete from assignments where session_id = p_session_id and court > p_num_courts;
end;
$$;

create or replace function public.dev_clear_signups() returns void
language plpgsql security definer set search_path = public as $$
declare
  sid bigint := current_session_id();
begin
  perform require_test_mode();
  delete from assignments where session_id = sid;
  delete from signups where session_id = sid;
  update sessions set locked_at = null, locked_by = null where id = sid;
end;
$$;

revoke all on function public.dev_scheduler_data(), public.dev_lock_courts(text, jsonb, text),
  public.dev_unlock_courts() from anon, public;
grant execute on function public.dev_scheduler_data(), public.dev_lock_courts(text, jsonb, text),
  public.dev_unlock_courts() to authenticated;
