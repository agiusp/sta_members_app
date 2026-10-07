-- Developers > Sunday Program gets three tabs: This week, Past Play and
-- Player Reviews.
--
-- Past Play is the play history as a table, like the club's Past Play sheet:
-- one row per player, one column per past Sunday of a season, and in each
-- cell the court the player was on, with * if they brought the balls. It is
-- the same data the Scheduler uses (assignments of earlier locked Sundays), so
-- editing it here changes the ball roster and the repeat-grouping check.
-- Developers can fill in Sundays from before the app (a past Sunday with no
-- session yet gets one, marked as already locked and emailed, so no timed
-- email ever goes out for it).
--
-- Player Reviews lists every Game Review for developers, with the players'
-- names and levels, for a later player-rating update.

-- The season containing a date, if any.
create function public.season_for(p_date date) returns bigint
language sql stable security definer set search_path = public as $$
  select id from seasons
   where start_date <= p_date and (end_date is null or p_date <= end_date)
   order by start_date desc limit 1;
$$;

-- p_season: a season name, or null for the season of the upcoming Sunday
-- (else the latest season).
create function public.dev_past_play(p_season text default null) returns jsonb
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
                'name', se.name, 'start_date', se.start_date, 'end_date', se.end_date) end,
    -- Past Sundays of the season the app knows about, oldest first.
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object('play_date', s.play_date,
               'week_mode', case when s.locked_at is null then null else s.week_mode end)
             order by s.play_date)
        from sessions s where s.season_id = se.id and s.play_date < today), '[]'::jsonb),
    'cells', coalesce((
      select jsonb_agg(jsonb_build_object('play_date', s.play_date, 'player_id', a.player_id,
               'court', a.court, 'brings_balls', a.brings_balls))
        from assignments a join sessions s on s.id = a.session_id
       where s.season_id = se.id and s.play_date < today and s.locked_at is not null), '[]'::jsonb),
    -- Sunday Doubles players, plus anyone who played this season.
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name,
               'level', p.level, 'sex', p.sex)
             order by p.first_name, p.last_name, p.id)
        from players p
       where (p.active and p.sunday_doubles)
          or exists (select 1 from assignments a join sessions s on s.id = a.session_id
                      where a.player_id = p.id and s.season_id = se.id and s.play_date < today)), '[]'::jsonb));
end;
$$;

-- A past Sunday's session, created if the app has none for it yet. Either
-- way it is marked as played with courts, locked and already emailed.
create function public.past_session_for(p_play_date date) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  today date := (app_now() at time zone 'America/New_York')::date;
  sid   bigint;
  now_  timestamptz := app_now();
begin
  if p_play_date is null or extract(isodow from p_play_date) <> 7 then
    raise exception 'Choose a Sunday';
  end if;
  if p_play_date >= today then
    raise exception 'Past Play is for earlier Sundays. Use the Scheduler for this week';
  end if;
  if season_for(p_play_date) is null then
    raise exception '% is not in any season', to_char(p_play_date, 'FMMonth FMDD, YYYY');
  end if;
  select id into sid from sessions where play_date = p_play_date;
  if sid is null then
    insert into sessions (play_date, season_id, num_courts, signups_open_at, signups_close_at,
                          courts_publish_at)
    values (p_play_date, season_for(p_play_date), 1,
            ((p_play_date - 6) + time '09:00') at time zone 'America/New_York',
            ((p_play_date - 1) + time '12:00') at time zone 'America/New_York',
            ((p_play_date - 1) + time '20:00') at time zone 'America/New_York')
    returning id into sid;
  end if;
  update sessions set locked_at = coalesce(locked_at, now_), locked_by = coalesce(locked_by, my_email()),
                      week_mode = 'courts', published_at = coalesce(published_at, now_)
   where id = sid;
  return sid;
end;
$$;

-- Adds an (empty) past Sunday column to Past Play.
create function public.dev_add_past_date(p_play_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  perform past_session_for(p_play_date);
end;
$$;

-- One cell of Past Play: p_court 1 to 7 (null clears the cell), and whether
-- the player brought the balls.
create function public.dev_save_past_play(p_play_date date, p_player_id bigint,
                                          p_court int, p_brings_balls boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  sid bigint;
begin
  perform require_developer();
  if not exists (select 1 from players where id = p_player_id) then
    raise exception 'Unknown player';
  end if;
  if p_court is not null and p_court not between 1 and 7 then
    raise exception 'Courts are numbered 1 to 7';
  end if;
  sid := past_session_for(p_play_date);
  if p_court is null then
    delete from assignments where session_id = sid and player_id = p_player_id;
    return;
  end if;
  insert into assignments (session_id, court, player_id, brings_balls)
  values (sid, p_court, p_player_id, coalesce(p_brings_balls, false))
  on conflict (session_id, player_id)
  do update set court = excluded.court, brings_balls = excluded.brings_balls;
  update sessions set num_courts = greatest(num_courts, p_court) where id = sid;
end;
$$;

-- Every Game Review, newest Sunday first. Names and levels come from the
-- players table (current levels).
create function public.dev_player_reviews() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  return jsonb_build_object(
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
               'player_id', r.player_id, 'play_date', s.play_date, 'court', r.court,
               'enjoyment', r.enjoyment, 'comments', r.comments, 'submitted_at', r.submitted_at,
               'sets', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'set_number', x.set_number, 'team1', to_jsonb(x.team1), 'team2', to_jsonb(x.team2),
                          'team1_games', x.team1_games, 'team2_games', x.team2_games)
                        order by x.set_number)
                   from review_sets x where x.review_id = r.id), '[]'::jsonb))
             order by s.play_date desc, player_name(r.player_id))
        from game_reviews r join sessions s on s.id = r.session_id), '[]'::jsonb),
    'players', coalesce((
      select jsonb_object_agg(p.id, jsonb_build_object(
               'name', p.first_name || ' ' || p.last_name, 'level', p.level))
        from players p
       where p.id in (select r.player_id from game_reviews r
                      union select unnest(x.team1 || x.team2) from review_sets x)), '{}'::jsonb));
end;
$$;

revoke all on function public.season_for(date), public.past_session_for(date)
  from anon, authenticated, public;
revoke all on function public.dev_past_play(text), public.dev_add_past_date(date),
  public.dev_save_past_play(date, bigint, int, boolean), public.dev_player_reviews() from anon, public;
grant execute on function public.dev_past_play(text), public.dev_add_past_date(date),
  public.dev_save_past_play(date, bigint, int, boolean), public.dev_player_reviews() to authenticated;
