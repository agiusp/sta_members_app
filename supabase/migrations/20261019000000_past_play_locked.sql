-- Past Play only comes from the Scheduler now: each week's column appears
-- once its courts are final (locked, and the 8pm player emails are due), and
-- developers can't change courts or ball-bringers there. They can only mark
-- a player as a no-show, which takes that player out of the Scheduler's play
-- history (ball roster and repeat groupings) for that Sunday.
--
-- Developers can also upload a table for a past season (before the app), in
-- the club sheet's layout. Uploaded rows are kept by name, since many past
-- players may not be in the app; names that match a player feed the
-- Scheduler's history too.

drop function public.dev_save_past_play(date, bigint, int, boolean);
drop function public.dev_add_past_date(date);
drop function public.past_session_for(date);

alter table public.assignments add column no_show boolean not null default false;

create table public.past_play_uploads (
  season_id    bigint not null references public.seasons (id) on delete cascade,
  play_date    date not null check (extract(isodow from play_date) = 7),
  player_name  text not null check (trim(player_name) <> ''),
  player_id    bigint references public.players (id),
  court        int not null check (court between 1 and 7),
  brings_balls boolean not null default false,
  no_show      boolean not null default false,
  primary key (season_id, play_date, player_name)
);
alter table public.past_play_uploads enable row level security;
revoke all on public.past_play_uploads from anon, authenticated;

-- A Sunday's courts are final once locked and the player emails are due.
create function public.session_final(s sessions) returns boolean
language sql stable security definer set search_path = public as $$
  select s.locked_at is not null and app_now() >= s.courts_publish_at;
$$;

create or replace function public.dev_past_play(p_season text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  today date := (app_now() at time zone 'America/New_York')::date;
  se    seasons;
begin
  perform require_developer();
  perform ensure_upcoming_session();
  if p_season is not null then
    select * into se from seasons where name = p_season;
  else
    select * into se from seasons
     where id = coalesce((select season_id from sessions where id = current_session_id()), season_for(today));
    if se.id is null then
      select * into se from seasons where start_date <= today order by start_date desc limit 1;
    end if;
  end if;
  return jsonb_build_object(
    'today', today,
    'seasons', coalesce((select jsonb_agg(name order by start_date desc) from seasons), '[]'::jsonb),
    'season', case when se.id is null then null else jsonb_build_object(
                'name', se.name, 'start_date', se.start_date, 'end_date', se.end_date,
                'uploaded', exists (select 1 from past_play_uploads u where u.season_id = se.id)) end,
    -- Sundays of the season so far (the app's, then any uploaded), oldest first.
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object('play_date', d.play_date, 'week_mode', d.week_mode, 'uploaded', d.uploaded)
             order by d.play_date)
        from (select s.play_date, case when s.locked_at is null then null else s.week_mode end as week_mode,
                     false as uploaded
                from sessions s
               where s.season_id = se.id and (s.play_date < today or session_final(s))
              union all
              select distinct u.play_date, 'courts', true
                from past_play_uploads u
               where u.season_id = se.id
                 and not exists (select 1 from sessions s where s.play_date = u.play_date and s.season_id = se.id)) d),
      '[]'::jsonb),
    'cells', coalesce((
      select jsonb_agg(c) from (
        select jsonb_build_object('play_date', s.play_date, 'player_id', a.player_id,
                 'name', p.first_name || ' ' || p.last_name, 'court', a.court,
                 'brings_balls', a.brings_balls, 'no_show', a.no_show) as c
          from assignments a join sessions s on s.id = a.session_id join players p on p.id = a.player_id
         where s.season_id = se.id and session_final(s)
        union all
        select jsonb_build_object('play_date', u.play_date, 'player_id', u.player_id, 'name', u.player_name,
                 'court', u.court, 'brings_balls', u.brings_balls, 'no_show', u.no_show, 'uploaded', true)
          from past_play_uploads u where u.season_id = se.id) x), '[]'::jsonb),
    -- Sunday Doubles players, for a season the app ran (uploaded seasons list
    -- the names in the upload).
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name)
             order by p.first_name, p.last_name, p.id)
        from players p
       where p.active and p.sunday_doubles
         and exists (select 1 from sessions s where s.season_id = se.id)), '[]'::jsonb));
end;
$$;

-- Marks (or unmarks) a player as a no-show on a Sunday the Scheduler recorded.
create function public.dev_set_no_show(p_play_date date, p_player_id bigint, p_no_show boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  sess sessions;
begin
  perform require_developer();
  select * into sess from sessions where play_date = p_play_date;
  if sess.id is null or not session_final(sess) then
    raise exception 'No-shows can be marked once that Sunday''s courts are final';
  end if;
  update assignments set no_show = coalesce(p_no_show, false)
   where session_id = sess.id and player_id = p_player_id;
  if not found then raise exception 'That player was not on a court that Sunday'; end if;
end;
$$;

-- Uploads a past season's table, replacing any earlier upload for it.
-- p_rows: [{"name": "Peter Smith", "play_date": "2025-05-04", "court": 3,
--           "brings_balls": true, "no_show": false}, ...]
-- The season is created from the dates if it doesn't exist. Its Sundays must
-- all be before today and before the app's own seasons, so an upload never
-- touches weeks the Scheduler recorded.
create function public.dev_upload_past_season(p_season text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  today date := (app_now() at time zone 'America/New_York')::date;
  first_ date;
  last_  date;
  sid    bigint;
begin
  perform require_developer();
  p_season := trim(p_season);
  if coalesce(p_season, '') = '' then raise exception 'Give the season a name, e.g. 2025'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'The table has no players on courts';
  end if;
  select min((r->>'play_date')::date), max((r->>'play_date')::date) into first_, last_
    from jsonb_array_elements(p_rows) r;
  if exists (select 1 from jsonb_array_elements(p_rows) r
              where extract(isodow from (r->>'play_date')::date) <> 7) then
    raise exception 'Every date must be a Sunday. Check the year';
  end if;
  if last_ >= today then raise exception 'Uploads are for past seasons only'; end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
              where (r->>'court')::int is null or (r->>'court')::int not between 1 and 7) then
    raise exception 'Courts are numbered 1 to 7';
  end if;

  select id into sid from seasons where name = p_season;
  if exists (select 1 from sessions s where s.season_id = sid) then
    raise exception 'The app ran the % season itself, so it can''t be uploaded', p_season;
  end if;
  if exists (select 1 from sessions s where s.play_date between first_ and last_) then
    raise exception 'The app already has Sundays between % and %. Uploads are only for seasons before the app',
      to_char(first_, 'FMMM-DD-YYYY'), to_char(last_, 'FMMM-DD-YYYY');
  end if;
  if exists (select 1 from seasons x where (sid is null or x.id <> sid)
                and x.start_date <= last_ and (x.end_date is null or x.end_date >= first_)) then
    raise exception 'Those dates overlap another season';
  end if;

  if sid is null then
    insert into seasons (name, start_date, end_date) values (p_season, first_, last_) returning id into sid;
  else
    update seasons set start_date = first_, end_date = last_ where id = sid;
    delete from past_play_uploads where season_id = sid;
  end if;

  insert into past_play_uploads (season_id, play_date, player_name, player_id, court, brings_balls, no_show)
  select sid, (r->>'play_date')::date, trim(r->>'name'),
         (select p.id from players p
           where lower(p.first_name || ' ' || p.last_name) = lower(trim(r->>'name'))
           order by p.active desc, p.id limit 1),
         (r->>'court')::int, coalesce((r->>'brings_balls')::boolean, false),
         coalesce((r->>'no_show')::boolean, false)
    from jsonb_array_elements(p_rows) r
  on conflict (season_id, play_date, player_name) do update
    set court = excluded.court, brings_balls = excluded.brings_balls, no_show = excluded.no_show;

  return jsonb_build_object(
    'rows', (select count(*) from past_play_uploads where season_id = sid),
    'unmatched', coalesce((select jsonb_agg(distinct player_name) from past_play_uploads
                            where season_id = sid and player_id is null), '[]'::jsonb));
end;
$$;

-- The Scheduler's play history leaves out no-shows, and includes uploaded
-- past seasons for players who are in the app.
create or replace function public.dev_scheduler_data() returns jsonb
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
      select jsonb_agg(h order by h->>'play_date', (h->>'court')::int) from (
        select jsonb_build_object('play_date', se.play_date, 'court', a.court,
                 'player_id', a.player_id, 'brings_balls', a.brings_balls) as h
          from assignments a join sessions se on se.id = a.session_id
         where se.play_date < sess.play_date and se.locked_at is not null and not a.no_show
        union all
        select jsonb_build_object('play_date', u.play_date, 'court', u.court,
                 'player_id', u.player_id, 'brings_balls', u.brings_balls)
          from past_play_uploads u
         where u.player_id is not null and not u.no_show and u.play_date < sess.play_date) x), '[]'::jsonb));
end;
$$;

revoke all on function public.session_final(sessions) from anon, authenticated, public;
revoke all on function public.dev_set_no_show(date, bigint, boolean),
  public.dev_upload_past_season(text, jsonb) from anon, public;
grant execute on function public.dev_set_no_show(date, bigint, boolean),
  public.dev_upload_past_season(text, jsonb) to authenticated;
