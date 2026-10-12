-- My Rating: each member's play rating, on the NTRP scale (2.5, 3.0, 3.5 ...),
-- moved by every confirmed result they play, singles or doubles. Players see
-- only their own rating. The maths is explained to players, with its sources,
-- on the "How it works" tab (app/rating-how.html): keep the two in step.
--
-- Results come from two places:
--  - Sunday Doubles Game Reviews: each group of sets with the same partners is
--    one result. It counts once an opponent confirms it (on My Rating, or by
--    a matching review), or automatically 7 days after the latest score was
--    proposed.
--  - "Report a game": any other game between members, casual play or part of
--    a league (leagues are set up by developers). It counts only once every
--    other player in it, partner included, has confirmed it.
-- Disputing means proposing the score you think is right (a review with a
-- different score does the same). The new score goes back to the other
-- players to confirm or dispute, back and forth until it is confirmed
-- (rating_proposals keeps every score proposed). The 3rd dispute sends the
-- game to the developers (status 'developers'), who settle it under
-- Developers > Ratings; they can also settle one sooner. They see every
-- reported game, e.g. to follow a league. They never see anyone's rating.
--
-- Ratings are not stored: they are worked out again from all counted results
-- each time (rating_replay), so a late confirmation, a corrected score or a
-- changed level in the Members table fixes everything after it.

-- Leagues players can report games for. Developers add them and mark them
-- finished (active = false) when the league ends.
create table public.rating_leagues (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(trim(name)) between 1 and 80),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index rating_leagues_name on public.rating_leagues (lower(trim(name)));

create table public.rating_results (
  id             bigint generated always as identity primary key,
  played_on      date not null,
  source         text not null check (source in ('sunday', 'reported')),
  session_id     bigint references public.sessions (id),
  court          int,
  -- Reported games: 'casual' or 'league' (with the league).
  kind           text check (kind in ('casual', 'league')),
  league_id      bigint references public.rating_leagues (id),
  -- Both sides, sorted, so the same match reported twice is found again.
  teams_key      text not null,
  team1          bigint[] not null,      -- the side of whoever proposed the current score
  team2          bigint[] not null,
  sets           jsonb not null,          -- [[team1 games, team2 games], ...]
  reported_by    bigint not null references public.players (id),  -- who proposed the current score
  reported_at    timestamptz not null,                             -- and when
  status         text not null default 'pending'
                 -- 'developers': disputed 3 times, waiting for a developer to settle it.
                 check (status in ('pending', 'confirmed', 'developers', 'discarded')),
  decided_by     bigint references public.players (id),   -- who confirmed it
  decided_at     timestamptz,
  auto_note      text,                    -- e.g. 'matching Game Review'
  resolved_by    text,                    -- the developer who settled a dispute
  simulated      boolean not null default false,          -- made up in test mode
  check ((source = 'sunday' and kind is null) or (source = 'reported' and kind is not null)),
  check ((kind = 'league') = (league_id is not null))
);
create unique index rating_results_sunday on public.rating_results (session_id, court, teams_key)
  where source = 'sunday';
create index rating_results_played on public.rating_results (played_on, id);

-- Who has confirmed the current score. A new score clears them.
create table public.rating_confirmations (
  result_id   bigint not null references public.rating_results (id) on delete cascade,
  player_id   bigint not null references public.players (id),
  answer      text not null check (answer = 'confirmed'),
  answered_at timestamptz not null,
  primary key (result_id, player_id)
);

-- Every score proposed for a result, oldest first: the first report, then
-- each dispute's counter-score (or a review with a different score).
create table public.rating_proposals (
  id          bigint generated always as identity primary key,
  result_id   bigint not null references public.rating_results (id) on delete cascade,
  proposed_by bigint not null references public.players (id),
  team1       bigint[] not null,          -- the proposer's side
  team2       bigint[] not null,
  sets        jsonb not null,             -- [[team1 games, team2 games], ...]
  reason      text check (char_length(reason) <= 500),
  proposed_at timestamptz not null
);
create index rating_proposals_result on public.rating_proposals (result_id, id);

alter table public.rating_leagues enable row level security;
alter table public.rating_results enable row level security;
alter table public.rating_confirmations enable row level security;
alter table public.rating_proposals enable row level security;
revoke all on public.rating_leagues, public.rating_results, public.rating_confirmations, public.rating_proposals
  from anon, authenticated;

-- ---------- The maths (pure functions) ----------

-- A level from the Members table ('3.5') as a number, or null.
create function public.rating_level(p_level text) returns numeric
language sql immutable as $$
  select case when x is not null then least(7, greatest(1, x)) end
    from (select substring(p_level from '[0-9]+(?:\.[0-9]+)?')::numeric x) t;
$$;

-- The nearest 0.5 level to a rating: 3.15 is a 3.0, 3.9 is a 4.0.
create function public.rating_nearest(p_rating numeric) returns numeric
language sql immutable as $$
  select round(round(round(p_rating, 2) * 2) / 2, 1);
$$;

-- The share of games a side is expected to win, from the gap between the
-- sides' ratings (Bradley-Terry): every 0.5 doubles the odds, so a side 0.5
-- higher is expected to win 2 games for every 1 (67%), 1.0 higher 4 for 1 (80%).
create function public.rating_expected(p_gap numeric) returns numeric
language sql immutable as $$
  select 1 / (1 + power(2::numeric, -2 * p_gap));
$$;

-- Step size: big for new players, smaller as they play more. The shape,
-- 1 / (results so far + 5)^0.4, is Kovalchik's (2016) for tennis Elo; 0.8
-- suits game shares on the NTRP scale.
create function public.rating_k(p_played int) returns numeric
language sql immutable as $$
  select 0.8 / power(p_played + 5, 0.4);
$$;

-- How much a result counts: in full from 20 games, in proportion below that.
create function public.rating_weight(p_games int) returns numeric
language sql immutable as $$
  select least(1, p_games / 20.0);
$$;

-- The official level after a result: the rating to the nearest 0.5, with a
-- 0.1 buffer past each halfway point, so it only goes up once the rating is
-- 0.1 past halfway to the next level (3.5 -> 4.0 at 3.85, not 3.75), and only
-- goes down once it is 0.1 past halfway to the one below (3.5 -> 3.0 below
-- 3.15, not 3.25).
create function public.rating_official(p_official numeric, p_rating numeric) returns numeric
language sql immutable as $$
  select case
    when round(p_rating, 2) >= p_official + 0.35 then rating_nearest(p_rating)
    when round(p_rating, 2) < p_official - 0.35 then rating_nearest(p_rating)
    else p_official end;
$$;

-- Sets seen from the other side.
create function public.rating_flip(p_sets jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_array(x -> 1, x -> 0) order by n), '[]'::jsonb)
    from jsonb_array_elements(p_sets) with ordinality t(x, n);
$$;

create function public.rating_teams_key(p_a bigint[], p_b bigint[]) returns text
language sql immutable as $$
  with s as (select array(select unnest(p_a) order by 1) a, array(select unnest(p_b) order by 1) b)
  select case when a[1] < b[1] then array_to_string(a, ',') || '|' || array_to_string(b, ',')
              else array_to_string(b, ',') || '|' || array_to_string(a, ',') end
    from s;
$$;

-- Whether a result counts: confirmed, or (Sunday Doubles only) still
-- unanswered 7 days after it was reported. Reported games need everyone.
create function public.rating_counted(p_source text, p_status text, p_reported_at timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select p_status = 'confirmed'
      or (p_source = 'sunday' and p_status = 'pending' and p_reported_at + interval '7 days' <= app_now());
$$;

-- Whether a result is waiting for this player's answer: a Sunday result
-- reported by an opponent, or a reported game they haven't answered yet.
create function public.rating_needs_answer(r rating_results, p_player bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select r.status = 'pending' and not rating_counted(r.source, r.status, r.reported_at)
     and case when r.source = 'sunday' then p_player = any (r.team2)
              else p_player = any (r.team1 || r.team2) and p_player <> r.reported_by
                   and not exists (select 1 from rating_confirmations c
                                    where c.result_id = r.id and c.player_id = p_player) end;
$$;

-- ---------- Working out everyone's ratings ----------
-- Goes through every counted result, oldest first. Each player starts at
-- their level in the Members table. One row per player per result; rated is
-- false (and the numbers null) when someone in it has no level.
create function public.rating_replay() returns table (
  result_id bigint, player_id bigint, rated boolean, played_before int,
  rating_before numeric, rating_after numeric, official_before numeric, official_after numeric,
  step numeric, weight numeric, expected numeric, actual numeric, change numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  st     jsonb := '{}';   -- player id -> {"r": rating, "o": official level, "n": results so far}
  nxt    jsonb;
  res    record;
  p      bigint;
  lvl    numeric;
  ok     boolean;
  g1     int;
  g2     int;
  r1     numeric;
  r2     numeric;
  e1     numeric;
  a1     numeric;
  w      numeric;
  mine_e numeric;
  mine_a numeric;
  s      jsonb;
  k      numeric;
  newr   numeric;
begin
  for res in select * from rating_results r where rating_counted(r.source, r.status, r.reported_at)
              order by r.played_on, r.id loop
    ok := true;
    foreach p in array res.team1 || res.team2 loop
      if not st ? p::text then
        select rating_level(level) into lvl from players where id = p;
        if lvl is null then ok := false;
        else st := st || jsonb_build_object(p::text, jsonb_build_object('r', lvl, 'o', rating_nearest(lvl), 'n', 0));
        end if;
      end if;
    end loop;
    select coalesce(sum((x ->> 0)::int), 0), coalesce(sum((x ->> 1)::int), 0) into g1, g2
      from jsonb_array_elements(res.sets) x;
    if not ok or g1 + g2 = 0 then
      foreach p in array res.team1 || res.team2 loop
        result_id := res.id; player_id := p; rated := false;
        played_before := null; rating_before := null; rating_after := null; official_before := null;
        official_after := null; step := null; weight := null; expected := null; actual := null; change := null;
        return next;
      end loop;
      continue;
    end if;

    select avg((st -> x::text ->> 'r')::numeric) into r1 from unnest(res.team1) x;
    select avg((st -> x::text ->> 'r')::numeric) into r2 from unnest(res.team2) x;
    e1 := rating_expected(r1 - r2);
    a1 := g1::numeric / (g1 + g2);
    w := rating_weight(g1 + g2);
    -- Everyone moves from their rating before this result; the new ratings
    -- are saved once all of them are worked out.
    nxt := '{}';
    foreach p in array res.team1 || res.team2 loop
      if p = any (res.team1) then mine_e := e1; mine_a := a1; else mine_e := 1 - e1; mine_a := 1 - a1; end if;
      s := st -> p::text;
      k := rating_k((s ->> 'n')::int);
      newr := least(7, greatest(1, (s ->> 'r')::numeric + k * w * (mine_a - mine_e)));
      result_id := res.id; player_id := p; rated := true;
      played_before := (s ->> 'n')::int;
      rating_before := (s ->> 'r')::numeric; rating_after := newr;
      official_before := (s ->> 'o')::numeric; official_after := rating_official((s ->> 'o')::numeric, newr);
      step := k; weight := w; expected := mine_e; actual := mine_a; change := newr - rating_before;
      nxt := nxt || jsonb_build_object(p::text, jsonb_build_object(
               'r', newr, 'o', official_after, 'n', played_before + 1));
      return next;
    end loop;
    st := st || nxt;
  end loop;
end;
$$;

-- ---------- Proposing scores ----------

-- Checks a score: 1 to 5 sets, each [games, games] from 0 to 7.
create function public.rating_check_sets(p_sets jsonb) returns void
language plpgsql immutable as $$
declare
  st jsonb;
  n  int := 0;
begin
  if p_sets is null or jsonb_typeof(p_sets) <> 'array' or jsonb_array_length(p_sets) not between 1 and 5 then
    raise exception 'Enter between 1 and 5 sets';
  end if;
  for st in select * from jsonb_array_elements(p_sets) loop
    n := n + 1;
    if jsonb_typeof(st) <> 'array' or jsonb_typeof(st -> 0) is distinct from 'number'
       or jsonb_typeof(st -> 1) is distinct from 'number'
       or (st ->> 0)::numeric not between 0 and 7 or (st ->> 1)::numeric not between 0 and 7
       or (st ->> 0)::numeric % 1 <> 0 or (st ->> 1)::numeric % 1 <> 0 then
      raise exception 'Set %: games must be whole numbers from 0 to 7', n;
    end if;
    if (st ->> 0)::int + (st ->> 1)::int = 0 then raise exception 'Set %: enter the games won', n; end if;
  end loop;
end;
$$;

-- A player proposes a different score (p_sets from their side): it becomes
-- the current score, everyone's confirmations are cleared, and the other
-- players are asked again. The 3rd dispute sends it to the developers instead
-- (the number is also in app/rating.html and app/rating-how.html).
create function public.rating_propose(p_result_id bigint, p_player bigint, p_sets jsonb, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  r    rating_results;
  mine bigint[];
  them bigint[];
begin
  select * into r from rating_results where id = p_result_id;
  mine := case when p_player = any (r.team1) then r.team1 else r.team2 end;
  them := case when p_player = any (r.team1) then r.team2 else r.team1 end;
  update rating_results set team1 = mine, team2 = them, sets = p_sets, reported_by = p_player,
         reported_at = app_now(), status = 'pending', decided_by = null, decided_at = null,
         auto_note = null, resolved_by = null
   where id = r.id;
  delete from rating_confirmations where result_id = r.id;
  insert into rating_proposals (result_id, proposed_by, team1, team2, sets, reason, proposed_at)
  values (r.id, p_player, mine, them, p_sets, nullif(trim(p_reason), ''), app_now());
  if rating_disputes(r.id) >= 3 then
    update rating_results set status = 'developers' where id = r.id;
  end if;
end;
$$;

-- Records a new result's first score.
create function public.rating_first_proposal(p_result_id bigint, p_reason text default null) returns void
language sql security definer set search_path = public as $$
  insert into rating_proposals (result_id, proposed_by, team1, team2, sets, reason, proposed_at)
  select id, reported_by, team1, team2, sets, p_reason, reported_at from rating_results where id = p_result_id;
$$;

-- How many times a result was disputed: scores proposed by a different
-- player from the one before (a reporter changing their own score isn't one).
create function public.rating_disputes(p_result_id bigint) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from (
    select proposed_by, lag(proposed_by) over (order by id) as before
      from rating_proposals where result_id = p_result_id) t
   where before is not null and proposed_by <> before;
$$;

create function public.rating_disputed(p_result_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select rating_disputes(p_result_id) > 0;
$$;

-- ---------- Sunday Doubles Game Reviews ----------
-- Turns one Game Review into results: each group of sets with the same
-- partners is one result, reported by the reviewing player. A review with a
-- different score from the current one proposes that score instead.
create function public.rating_sync_review(p_review_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  rv    game_reviews;
  day   date;
  g     record;
  e     rating_results;
  k     text;
  keys  text[] := '{}';
  seen  jsonb;
  rid   bigint;
begin
  select * into rv from game_reviews where id = p_review_id;
  if rv.id is null then return; end if;
  select play_date into day from sessions where id = rv.session_id;
  for g in
    select team1, team2, jsonb_agg(jsonb_build_array(team1_games, team2_games) order by set_number) sets
      from review_sets where review_id = p_review_id
     group by team1, team2
  loop
    k := rating_teams_key(g.team1, g.team2);
    keys := keys || k;
    e := null;
    select * into e from rating_results
     where source = 'sunday' and session_id = rv.session_id and court = rv.court and teams_key = k;
    if e.id is null then
      insert into rating_results (played_on, source, session_id, court, teams_key, team1, team2,
                                  sets, reported_by, reported_at)
      values (day, 'sunday', rv.session_id, rv.court, k, g.team1, g.team2, g.sets, rv.player_id, app_now())
      returning id into rid;
      perform rating_first_proposal(rid, 'From their Game Review');
    elsif e.status not in ('discarded', 'developers') then   -- (left to the developers)
      seen := case when rv.player_id = any (e.team1) then e.sets else rating_flip(e.sets) end;
      if seen <> g.sets then
        -- A different score (or the reporter changed theirs): it goes back to the others.
        perform rating_propose(e.id, rv.player_id, g.sets, 'From their Game Review');
      elsif not (rv.player_id = any (e.team1)) and e.status = 'pending' then
        -- An opponent's review agrees: that confirms it.
        update rating_results set status = 'confirmed', decided_by = rv.player_id,
               decided_at = app_now(), auto_note = 'matching Game Review'
         where id = e.id;
      end if;
    end if;
  end loop;
  -- Partner groups the reviewer no longer reports.
  delete from rating_results
   where source = 'sunday' and session_id = rv.session_id and reported_by = rv.player_id
     and status = 'pending' and not (teams_key = any (keys));
end;
$$;

do $$
declare f text;
begin
  select pg_get_functiondef('public.submit_review(bigint, jsonb, int, text)'::regprocedure) into f;
  if (length(f) - length(replace(f, '  return my_review();', ''))) / length('  return my_review();') <> 1 then
    raise exception 'submit_review changed; update this migration';
  end if;
  execute replace(f, '  return my_review();', '  perform rating_sync_review(rid);
  return my_review();');
end $$;

-- ---------- What players see ----------

-- The signed-in member's player.
create function public.rating_me() returns bigint
language sql stable security definer set search_path = public as $$
  select id from players where account_email = my_email() and active order by id limit 1;
$$;

-- A result as one player sees it: their side first.
create function public.rating_view(r rating_results, p_player bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', r.id, 'played_on', r.played_on, 'source', r.source, 'status', r.status,
    'counted', rating_counted(r.source, r.status, r.reported_at),
    'auto_confirmed', r.status = 'pending' and rating_counted(r.source, r.status, r.reported_at),
    'auto_confirms_at', case when r.source = 'sunday' then r.reported_at + interval '7 days' end,
    'kind', r.kind, 'league', (select name from rating_leagues where id = r.league_id),
    'format', case when cardinality(r.team1) = 1 then 'singles' else 'doubles' end,
    -- Reported games: every other player's answer so far.
    'answers', case when r.source = 'reported' then (
      select jsonb_agg(jsonb_build_object('name', player_name(x), 'answer', c.answer) order by player_name(x))
        from unnest(r.team1 || r.team2) x
        left join rating_confirmations c on c.result_id = r.id and c.player_id = x
       where x <> r.reported_by) end,
    'auto_note', r.auto_note, 'disputed', rating_disputed(r.id), 'disputes', rating_disputes(r.id),
    'reported_by', player_name(r.reported_by), 'reported_by_me', r.reported_by = p_player,
    'reported_at', r.reported_at,
    'decided_by', player_name(r.decided_by), 'resolved', r.resolved_by is not null,
    'partner', (select player_name(x) from unnest(case when p_player = any (r.team1) then r.team1 else r.team2 end) x
                 where x <> p_player limit 1),
    'opponents', (select jsonb_agg(player_name(x) order by player_name(x))
                    from unnest(case when p_player = any (r.team1) then r.team2 else r.team1 end) x),
    'sets', case when p_player = any (r.team1) then r.sets else rating_flip(r.sets) end,
    -- Every score proposed so far, from this player's side.
    'history', (select jsonb_agg(jsonb_build_object(
                  'by', player_name(pr.proposed_by), 'by_me', pr.proposed_by = p_player,
                  'sets', case when p_player = any (pr.team1) then pr.sets else rating_flip(pr.sets) end,
                  'reason', pr.reason, 'at', pr.proposed_at) order by pr.id)
                  from rating_proposals pr where pr.result_id = r.id),
    'first_reported_by_me', (select proposed_by from rating_proposals where result_id = r.id order by id limit 1)
                            = p_player);
$$;

create function public.my_rating() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me   bigint;
  pl   players;
  lvl  numeric;
  hist jsonb;
  last jsonb;
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  me := rating_me();
  select * into pl from players where id = me;
  lvl := rating_level(pl.level);

  select coalesce(jsonb_agg(rating_view(r, me) || jsonb_build_object(
           'rated', x.rated, 'played_before', x.played_before,
           'rating_before', round(x.rating_before, 4), 'rating_after', round(x.rating_after, 4),
           'official_before', x.official_before, 'official_after', x.official_after,
           'step', round(x.step, 4), 'weight', round(x.weight, 4),
           'expected', round(x.expected, 4), 'actual', round(x.actual, 4), 'change', round(x.change, 4))
           order by r.played_on, r.id), '[]'::jsonb)
    into hist
    from rating_replay() x join rating_results r on r.id = x.result_id
   where x.player_id = me;
  select h into last from jsonb_array_elements(hist) h where (h ->> 'rated')::boolean
   order by (h ->> 'played_before')::int desc limit 1;

  return jsonb_build_object(
    'now', app_now(),
    'test_mode', (select test_mode from settings),
    'developer', is_developer(),
    'player', case when me is null then null else jsonb_build_object(
                'id', me, 'name', pl.first_name || ' ' || pl.last_name, 'level', pl.level,
                'start', lvl, 'start_official', rating_nearest(lvl)) end,
    'rating', coalesce((last ->> 'rating_after')::numeric, lvl),
    'official', coalesce((last ->> 'official_after')::numeric, rating_nearest(lvl)),
    'played', coalesce((last ->> 'played_before')::int + 1, 0),
    'history', hist,
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

-- Confirm the current score, or dispute it by proposing the score you think
-- is right (p_sets, from your side), with an optional reason.
create function public.answer_rating_result(p_result_id bigint, p_confirm boolean, p_reason text default null,
                                            p_sets jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me       bigint;
  r        rating_results;
  current_ jsonb;
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  me := rating_me();
  select * into r from rating_results where id = p_result_id;
  if r.id is null or not (me = any (r.team1 || r.team2)) or me = r.reported_by
     or (r.source = 'sunday' and not (me = any (r.team2))) then
    raise exception 'That result is not waiting for your answer';
  end if;
  if r.status = 'developers' then
    raise exception 'This score was disputed 3 times, so the developers will settle it';
  end if;
  if exists (select 1 from rating_confirmations where result_id = r.id and player_id = me) then
    raise exception 'You have already answered that result';
  end if;
  if r.status <> 'pending' or rating_counted(r.source, r.status, r.reported_at) then
    raise exception 'That result has already been answered';
  end if;
  if char_length(p_reason) > 500 then raise exception 'The reason can be at most 500 characters'; end if;
  if not p_confirm then
    if p_sets is null then raise exception 'Enter the score you think is right'; end if;
    perform rating_check_sets(p_sets);
    if me = any (r.team1) then current_ := r.sets; else current_ := rating_flip(r.sets); end if;
    if p_sets = current_ then
      raise exception 'That is the same score. Choose Confirm if it is right, or change the score';
    end if;
    perform rating_propose(r.id, me, p_sets, p_reason);
    return my_rating();
  end if;
  insert into rating_confirmations (result_id, player_id, answer, answered_at)
  values (r.id, me, 'confirmed', app_now());
  -- Sunday: one opponent is enough. Reported games: everyone but the proposer.
  if r.source = 'sunday' or not exists (
          select 1 from unnest(r.team1 || r.team2) x
           where x <> r.reported_by
             and not exists (select 1 from rating_confirmations c
                              where c.result_id = r.id and c.player_id = x and c.answer = 'confirmed')) then
    update rating_results set status = 'confirmed', decided_by = me, decided_at = app_now() where id = r.id;
  end if;
  return my_rating();
end;
$$;

-- Active members to choose partners and opponents from (names only).
create function public.rating_players() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name)
                     order by p.first_name, p.last_name)
      from players p join accounts a on a.email = p.account_email and a.active and a.membership_current
     where p.active and p.id <> rating_me()), '[]'::jsonb);
end;
$$;

-- Leagues open for reporting games.
create function public.rating_leagues() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
                     from rating_leagues where active), '[]'::jsonb);
end;
$$;

-- p_kind: 'casual' or 'league' (with p_league_id). p_partner: null for singles.
-- p_sets: [[my games, their games], ...].
create function public.report_rating_game(p_played_on date, p_kind text, p_league_id bigint,
                                          p_partner bigint, p_opponents bigint[], p_sets jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me    bigint;
  today date := (app_now() at time zone 'America/New_York')::date;
  mine  bigint[];
  them  bigint[] := coalesce(p_opponents, '{}');
  p     bigint;
  k     text;
  rid   bigint;
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  me := rating_me();
  if p_played_on is null or p_played_on > today then raise exception 'Choose the day you played (not a future day)'; end if;
  if p_played_on < today - 30 then raise exception 'Only games from the last 30 days can be reported'; end if;
  if p_kind is null or p_kind not in ('casual', 'league') then
    raise exception 'Choose whether it was casual play or a league game';
  end if;
  if p_kind = 'league' and not exists (select 1 from rating_leagues where id = p_league_id and active) then
    raise exception 'Choose the league';
  end if;
  mine := case when p_partner is null then array[me] else array[me, p_partner] end;
  if cardinality(them) <> cardinality(mine) then
    raise exception 'Choose % opponent%', cardinality(mine), case when cardinality(mine) = 1 then '' else 's' end;
  end if;
  if (select count(distinct x) from unnest(mine || them) x) <> cardinality(mine || them) then
    raise exception 'Each player can only be in the game once';
  end if;
  foreach p in array mine || them loop
    if p <> me and not exists (select 1 from players pl join accounts a on a.email = pl.account_email
                                where pl.id = p and pl.active and a.active and a.membership_current) then
      raise exception 'Choose players from the member list';
    end if;
    if rating_level((select level from players where id = p)) is null then
      raise exception '% has no starting level yet, so this game can''t be rated. Please ask a developer to set it in the Members table',
        player_name(p);
    end if;
  end loop;
  perform rating_check_sets(p_sets);
  k := rating_teams_key(mine, them);
  if exists (select 1 from rating_results where played_on = p_played_on and teams_key = k and status <> 'discarded') then
    raise exception 'This game has already been reported';
  end if;
  insert into rating_results (played_on, source, kind, league_id, teams_key, team1, team2, sets, reported_by, reported_at)
  values (p_played_on, 'reported', p_kind, case when p_kind = 'league' then p_league_id end,
          k, mine, them, p_sets, me, app_now())
  returning id into rid;
  perform rating_first_proposal(rid);
  return my_rating();
end;
$$;

-- The player who first reported a game takes it back, while it doesn't count.
create function public.withdraw_rating_result(p_result_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r rating_results;
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  select * into r from rating_results where id = p_result_id;
  if r.id is null or r.source <> 'reported'
     or (select proposed_by from rating_proposals where result_id = r.id order by id limit 1) <> rating_me() then
    raise exception 'You can only withdraw games you reported here';
  end if;
  if r.status not in ('pending', 'developers') or rating_counted(r.source, r.status, r.reported_at) then
    raise exception 'That game already counts, so it can''t be withdrawn';
  end if;
  delete from rating_results where id = r.id;
  return my_rating();
end;
$$;

-- "What if": the change one result would make. Uses only the numbers given.
create function public.rating_preview(p_rating numeric, p_official numeric, p_played int,
                                      p_partner numeric, p_opponent1 numeric, p_opponent2 numeric,
                                      p_my_games int, p_their_games int)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  mine numeric;
  them numeric;
  e    numeric;
  a    numeric;
  w    numeric;
  k    numeric;
  newr numeric;
begin
  if p_rating is null or p_opponent1 is null then raise exception 'Enter your rating and your opponent''s'; end if;
  if (p_partner is null) <> (p_opponent2 is null) then
    raise exception 'For doubles, enter your partner and both opponents; for singles, leave the second opponent and partner empty';
  end if;
  if p_my_games is null or p_their_games is null or p_my_games < 0 or p_their_games < 0
     or p_my_games + p_their_games = 0 then
    raise exception 'Enter the games won by each side';
  end if;
  mine := case when p_partner is null then p_rating else (p_rating + p_partner) / 2 end;
  them := case when p_opponent2 is null then p_opponent1 else (p_opponent1 + p_opponent2) / 2 end;
  e := rating_expected(mine - them);
  a := p_my_games::numeric / (p_my_games + p_their_games);
  w := rating_weight(p_my_games + p_their_games);
  k := rating_k(greatest(coalesce(p_played, 0), 0));
  newr := least(7, greatest(1, p_rating + k * w * (a - e)));
  return jsonb_build_object('expected', round(e, 4), 'actual', round(a, 4), 'weight', round(w, 4),
    'step', round(k, 4), 'change', round(newr - p_rating, 4), 'rating_after', round(newr, 4),
    'official_after', rating_official(coalesce(p_official, rating_nearest(p_rating)), newr));
end;
$$;

-- ---------- Developers: disputes ----------

-- Games disputed 3 times (status 'developers'), then those still going back
-- and forth: not counted yet, and disputed at least once. Sides and scores are seen from team1, the
-- side of whoever proposed the current score.
create function public.dev_rating_disputes() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'played_on', r.played_on, 'source', r.source, 'court', r.court,
             'status', r.status, 'disputes', rating_disputes(r.id),
             'kind', r.kind, 'league', (select name from rating_leagues where id = r.league_id),
             'team1', (select jsonb_agg(player_name(x)) from unnest(r.team1) x),
             'team2', (select jsonb_agg(player_name(x)) from unnest(r.team2) x),
             'sets', r.sets, 'reported_by', player_name(r.reported_by), 'reported_at', r.reported_at,
             'waiting_for', (select jsonb_agg(player_name(x) order by player_name(x))
                               from unnest(case when r.source = 'sunday' then r.team2 else r.team1 || r.team2 end) x
                              where x <> r.reported_by
                                and not exists (select 1 from rating_confirmations c
                                                 where c.result_id = r.id and c.player_id = x)),
             'history', (select jsonb_agg(jsonb_build_object(
                           'by', player_name(pr.proposed_by), 'reason', pr.reason, 'at', pr.proposed_at,
                           'sets', case when pr.proposed_by = any (r.team1) then pr.sets else rating_flip(pr.sets) end)
                           order by pr.id)
                           from rating_proposals pr where pr.result_id = r.id))
           order by r.status <> 'developers', r.played_on, r.id)
      from rating_results r
     where r.status = 'developers'
        or (r.status = 'pending' and not rating_counted(r.source, r.status, r.reported_at)
            and rating_disputed(r.id))), '[]'::jsonb);
end;
$$;

-- Every result, newest first, with each player's answer: for following
-- leagues and checking reports. No ratings.
create function public.dev_rating_games() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  return jsonb_build_object(
    'leagues', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'active', l.active,
               'games', (select count(*) from rating_results r where r.league_id = l.id and r.status <> 'discarded'))
             order by l.active desc, l.name)
        from rating_leagues l), '[]'::jsonb),
    'games', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'played_on', r.played_on, 'source', r.source, 'kind', r.kind,
               'league_id', r.league_id, 'league', (select name from rating_leagues where id = r.league_id),
               'court', r.court, 'format', case when cardinality(r.team1) = 1 then 'singles' else 'doubles' end,
               'team1', (select jsonb_agg(jsonb_build_object('id', x, 'name', player_name(x))) from unnest(r.team1) x),
               'team2', (select jsonb_agg(jsonb_build_object('id', x, 'name', player_name(x))) from unnest(r.team2) x),
               'sets', r.sets, 'status', r.status, 'counted', rating_counted(r.source, r.status, r.reported_at),
               'reported_by', player_name(r.reported_by), 'reported_at', r.reported_at,
               'resolved_by', r.resolved_by, 'simulated', r.simulated,
               'disputed', rating_disputed(r.id), 'disputes', rating_disputes(r.id),
               'rounds', (select count(*) from rating_proposals pr where pr.result_id = r.id),
               'answers', (select jsonb_agg(jsonb_build_object('name', player_name(x), 'answer', c.answer)
                                            order by player_name(x))
                             from unnest(r.team1 || r.team2) x
                             left join rating_confirmations c on c.result_id = r.id and c.player_id = x
                            where x <> r.reported_by))
             order by r.played_on desc, r.id desc)
        from rating_results r), '[]'::jsonb));
end;
$$;

-- Adds (p_id null) or changes a league.
create function public.dev_save_league(p_id bigint, p_name text, p_active boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'Give the league a name (up to 80 characters)';
  end if;
  if exists (select 1 from rating_leagues where lower(trim(name)) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'There is already a league called %', trim(p_name);
  end if;
  if p_id is null then
    insert into rating_leagues (name, active) values (trim(p_name), coalesce(p_active, true));
  else
    update rating_leagues set name = trim(p_name), active = coalesce(p_active, active) where id = p_id;
    if not found then raise exception 'Unknown league'; end if;
  end if;
  return dev_rating_games();
end;
$$;

-- p_action: 'count' (optionally with corrected p_sets, seen from team1) or 'discard'.
create function public.dev_resolve_rating(p_result_id bigint, p_action text, p_sets jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r rating_results;
begin
  perform require_developer();
  select * into r from rating_results where id = p_result_id;
  if r.id is null or not (r.status = 'developers'
     or (r.status = 'pending' and not rating_counted(r.source, r.status, r.reported_at) and rating_disputed(r.id))) then
    raise exception 'That result is not disputed';
  end if;
  if p_action = 'discard' then
    update rating_results set status = 'discarded', resolved_by = my_email() where id = p_result_id;
  elsif p_action = 'count' then
    if p_sets is not null then perform rating_check_sets(p_sets); end if;
    update rating_results set status = 'confirmed', sets = coalesce(p_sets, sets), resolved_by = my_email()
     where id = p_result_id;
  else
    raise exception 'Unknown action';
  end if;
  return dev_rating_disputes();
end;
$$;

-- ---------- Dynamic Level ----------
-- Every player's official level from My Rating, in 0.5 steps: their Level in
-- the Members table to the nearest 0.5 until results move it (with the 0.1
-- buffer). Worked out when asked, like the ratings, so it is always up to
-- date, including when a Sunday result counts after 7 days. Developers see it
-- in the Members table (next to Level, which they still set), and the Sunday
-- Doubles scheduler uses it. Players without a Level have none.
create function public.rating_dynamic_levels() returns jsonb
language sql stable security definer set search_path = public as $$
  with last as (
    select distinct on (x.player_id) x.player_id, x.official_after
      from rating_replay() x where x.rated
     order by x.player_id, x.played_before desc)
  select coalesce(jsonb_object_agg(p.id, round(coalesce(l.official_after, rating_nearest(rating_level(p.level))), 1)::text)
                    filter (where rating_level(p.level) is not null), '{}'::jsonb)
    from players p left join last l on l.player_id = p.id;
$$;

-- The Members table gets a Dynamic Level column.
drop function public.dev_members();
create function public.dev_members() returns table (
  player_id bigint, first_name text, last_name text, email text, level text, dynamic_level text, sex text,
  membership text, sunday_doubles boolean, is_developer boolean, app_access text, invited_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  dyn jsonb;
begin
  perform require_developer();
  dyn := rating_dynamic_levels();
  return query
  select p.id, p.first_name, p.last_name, a.email, p.level, dyn ->> p.id::text, p.sex,
         case when a.active and a.membership_current then 'active' else 'inactive' end,
         p.sunday_doubles, a.is_developer,
         case when u.email_confirmed_at is not null then 'yes'
              when u.id is not null then 'invited' else 'pending' end,
         u.invited_at
    from players p
    join accounts a on a.email = p.account_email
    left join auth.users u on u.id = a.user_id
   where p.active
   order by lower(p.last_name), lower(p.first_name);
end;
$$;
revoke all on function public.dev_members() from anon, public;
grant execute on function public.dev_members() to authenticated;

-- The Sunday Doubles scheduler and This week use the Dynamic Level (the
-- Level, for players without a number there).
do $$
declare
  f   text;
  fn  text;
  old text := '''level'', p.level';
begin
  foreach fn in array array['dev_scheduler_data', 'dev_week'] loop
    select pg_get_functiondef(('public.' || fn)::regproc) into f;
    if (length(f) - length(replace(f, old, ''))) / length(old) <> 1 then
      raise exception '% changed; update this migration', fn;
    end if;
    execute replace(f, old, '''level'', coalesce((select rating_dynamic_levels()) ->> p.id::text, p.level)');
  end loop;
end $$;

-- ---------- Test mode: made-up results for the signed-in developer ----------
-- p_count results, one a week back from today, against random players, with
-- scores drawn from the players' levels plus some luck, casual or in a league.
-- The last 2 are reported by an opponent and wait only for the developer's answer.
create function public.dev_simulate_rating_results(p_count int) returns int
language plpgsql security definer set search_path = public as $$
declare
  me    bigint;
  today date := (app_now() at time zone 'America/New_York')::date;
  i     int;
  dbl   boolean;
  pick  bigint[];
  mine  bigint[];
  them  bigint[];
  e     numeric;
  pg    numeric;
  sets  jsonb;
  g1    int;
  g2    int;
  setn  int;
  waits boolean;
  lg    bigint;
  rid   bigint;
begin
  perform require_developer();
  if not (select test_mode from settings) then raise exception 'Only in test mode'; end if;
  if p_count is null or p_count not between 1 and 40 then raise exception 'Choose 1 to 40 results'; end if;
  me := rating_me();
  if rating_level((select level from players where id = me)) is null then
    raise exception 'Give yourself a level in the Members table first';
  end if;
  for i in 1 .. p_count loop
    dbl := random() < 0.7;
    select array_agg(id) into pick from (
      select p.id from players p where p.active and p.id <> me and rating_level(p.level) is not null
       order by random() limit case when dbl then 3 else 1 end) x;
    mine := case when dbl then array[me, pick[1]] else array[me] end;
    them := case when dbl then pick[2:3] else pick[1:1] end;
    select rating_expected(
             (select avg(rating_level(level)) from players where id = any (mine))
           - (select avg(rating_level(level)) from players where id = any (them))) into e;
    -- Luck on the day: a game-winning chance up to 15 points either side.
    pg := least(0.95, greatest(0.05, e + (random() - 0.5) * 0.3));
    sets := '[]';
    for setn in 1 .. 2 loop
      g1 := 0; g2 := 0;
      while not ((g1 >= 6 or g2 >= 6) and abs(g1 - g2) >= 2) and g1 < 7 and g2 < 7 loop
        if random() < pg then g1 := g1 + 1; else g2 := g2 + 1; end if;
      end loop;
      sets := sets || jsonb_build_array(jsonb_build_array(g1, g2));
    end loop;
    waits := i > p_count - 2;
    -- Half of them in a league, when there is one.
    lg := case when random() < 0.5 then (select id from rating_leagues where active order by random() limit 1) end;
    insert into rating_results (played_on, source, kind, league_id, teams_key, team1, team2, sets, reported_by,
                                reported_at, status, simulated)
    values (today - 7 * (p_count - i + 1) + 6, 'reported', case when lg is null then 'casual' else 'league' end, lg,
            rating_teams_key(mine, them),
            case when waits then them else mine end, case when waits then mine else them end,
            case when waits then rating_flip(sets) else sets end,
            case when waits then them[1] else me end,
            case when waits then app_now() else (today - 7 * (p_count - i + 1) + 6)::timestamptz end,
            case when waits then 'pending' else 'confirmed' end, true)
    returning id into rid;
    perform rating_first_proposal(rid);
    -- Everyone but the reporter confirmed; on the waiting ones, everyone but
    -- the developer too, so the developer's answer decides.
    insert into rating_confirmations (result_id, player_id, answer, answered_at)
    select rid, x, 'confirmed', app_now() from unnest(mine || them) x
     where x <> case when waits then them[1] else me end and not (waits and x = me);
  end loop;
  return p_count;
end;
$$;

create function public.dev_clear_simulated_ratings() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform require_developer();
  if not (select test_mode from settings) then raise exception 'Only in test mode'; end if;
  delete from rating_results where simulated;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.rating_level(text), public.rating_nearest(numeric), public.rating_expected(numeric),
  public.rating_k(int), public.rating_weight(int), public.rating_official(numeric, numeric),
  public.rating_flip(jsonb), public.rating_teams_key(bigint[], bigint[]),
  public.rating_counted(text, text, timestamptz), public.rating_needs_answer(rating_results, bigint),
  public.rating_replay(), public.rating_sync_review(bigint),
  public.rating_me(), public.rating_view(rating_results, bigint), public.rating_dynamic_levels(),
  public.rating_check_sets(jsonb), public.rating_propose(bigint, bigint, jsonb, text),
  public.rating_first_proposal(bigint, text), public.rating_disputes(bigint), public.rating_disputed(bigint)
  from anon, authenticated, public;
revoke all on function public.my_rating(), public.answer_rating_result(bigint, boolean, text, jsonb),
  public.rating_players(), public.rating_leagues(),
  public.report_rating_game(date, text, bigint, bigint, bigint[], jsonb),
  public.withdraw_rating_result(bigint),
  public.rating_preview(numeric, numeric, int, numeric, numeric, numeric, int, int),
  public.dev_rating_disputes(), public.dev_resolve_rating(bigint, text, jsonb),
  public.dev_rating_games(), public.dev_save_league(bigint, text, boolean),
  public.dev_simulate_rating_results(int), public.dev_clear_simulated_ratings()
  from anon, public;
grant execute on function public.my_rating(), public.answer_rating_result(bigint, boolean, text, jsonb),
  public.rating_players(), public.rating_leagues(),
  public.report_rating_game(date, text, bigint, bigint, bigint[], jsonb),
  public.withdraw_rating_result(bigint),
  public.rating_preview(numeric, numeric, int, numeric, numeric, numeric, int, int),
  public.dev_rating_disputes(), public.dev_resolve_rating(bigint, text, jsonb),
  public.dev_rating_games(), public.dev_save_league(bigint, text, boolean),
  public.dev_simulate_rating_results(int), public.dev_clear_simulated_ratings()
  to authenticated;
