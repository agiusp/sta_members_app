-- "Review my Game": players who were on a court last Sunday record the sets
-- they played (partner, opponents, games won), and rate how much they enjoyed
-- the game (1 = did not enjoy, 5 = enjoyed it very much) with optional comments. Stored for the future
-- player-rating-update. Each player reviews separately, so the same set may
-- be recorded by several players on a court; player-rating-update reconciles.
--
-- Review window (US Eastern): from the end of play (Sunday 10:30am) until
-- the next Sunday at 9am.

create table public.game_reviews (
  id           bigint generated always as identity primary key,
  session_id   bigint not null references public.sessions (id),
  player_id    bigint not null references public.players (id),
  court        int not null,
  enjoyment    int not null check (enjoyment between 1 and 5),
  comments     text check (char_length(comments) <= 1000),
  submitted_by text not null,
  submitted_at timestamptz not null,
  unique (session_id, player_id)
);

-- team1 is "player set 1": the reviewing player and their partner (just the
-- reviewing player in singles). team2 is "player set 2", their opponents.
create table public.review_sets (
  review_id   bigint not null references public.game_reviews (id) on delete cascade,
  set_number  int not null check (set_number between 1 and 5),
  team1       bigint[] not null,
  team2       bigint[] not null,
  team1_games int not null check (team1_games between 0 and 7),
  team2_games int not null check (team2_games between 0 and 7),
  primary key (review_id, set_number)
);

alter table public.game_reviews enable row level security;
alter table public.review_sets  enable row level security;
revoke all on public.game_reviews, public.review_sets from anon;
revoke insert, update, delete on public.game_reviews, public.review_sets from authenticated;
create policy game_reviews_read on public.game_reviews for select to authenticated
  using (is_developer() or player_id in (select id from players where account_email = my_email()));
create policy review_sets_read on public.review_sets for select to authenticated
  using (review_id in (select id from game_reviews));

-- The Sunday being reviewed: the most recent one whose play has ended.
create function public.review_session_id() returns bigint
language sql stable security definer set search_path = public as $$
  select id from sessions
   where ((play_date + time '10:30') at time zone 'America/New_York') <= app_now()
   order by play_date desc limit 1;
$$;

create function public.review_window_closes(p_play_date date) returns timestamptz
language sql immutable as $$
  select ((p_play_date + 7) + time '09:00') at time zone 'America/New_York';
$$;

create function public.player_name(p_id bigint) returns text
language sql stable security definer set search_path = public as $$
  select first_name || ' ' || last_name from players where id = p_id;
$$;

-- A review as shown to players: each set with names and games.
create function public.review_json(p_review_id bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'submitted_at', r.submitted_at,
    'enjoyment', r.enjoyment,
    'comments', r.comments,
    'sets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'set_number', s.set_number,
               'partner_id', (select x from unnest(s.team1) x where x <> r.player_id limit 1),
               'team1', (select jsonb_agg(player_name(x) order by x <> r.player_id, player_name(x)) from unnest(s.team1) x),
               'team2', (select jsonb_agg(player_name(x) order by player_name(x)) from unnest(s.team2) x),
               'team1_games', s.team1_games, 'team2_games', s.team2_games)
             order by s.set_number)
        from review_sets s where s.review_id = r.id), '[]'::jsonb))
    from game_reviews r where r.id = p_review_id;
$$;

-- Everything the Review my Game tab needs, for the signed-in member's players.
create function public.my_review() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me   text := my_email();
  sid  bigint := review_session_id();
  sess sessions;
begin
  if me is null then raise exception 'Not a member'; end if;
  if sid is null then return jsonb_build_object('session', null); end if;
  select * into sess from sessions where id = sid;
  return jsonb_build_object(
    'now', app_now(),
    'session', jsonb_build_object('id', sid, 'play_date', sess.play_date,
                                  'closes_at', review_window_closes(sess.play_date)),
    'open', app_now() < review_window_closes(sess.play_date),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.first_name || ' ' || p.last_name,
               'played', a.player_id is not null,
               'court', a.court,
               'courtmates', coalesce((
                 select jsonb_agg(jsonb_build_object('id', m.player_id, 'name', player_name(m.player_id))
                                  order by player_name(m.player_id))
                   from assignments m
                  where a.player_id is not null and m.session_id = sid
                    and m.court = a.court and m.player_id <> p.id), '[]'::jsonb),
               'review', (select review_json(r.id) from game_reviews r
                           where r.session_id = sid and r.player_id = p.id))
             order by p.first_name, p.last_name)
        from players p
        left join assignments a on a.session_id = sid and a.player_id = p.id
                               and (select locked_at from sessions where id = sid) is not null
       where p.account_email = me and p.active), '[]'::jsonb));
end;
$$;

-- p_sets: [{"partner_id": 12 or null for singles, "my_games": 6, "their_games": 3}, ...]
-- p_enjoyment: 1 (did not enjoy) to 5 (enjoyed it very much). p_comments: optional.
-- The teams are worked out here from the court, never taken from the page.
create function public.submit_review(p_player_id bigint, p_sets jsonb,
                                     p_enjoyment int default null, p_comments text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me     text := my_email();
  sid    bigint := review_session_id();
  sess   sessions;
  crt    int;
  mates  bigint[];
  rid    bigint;
  st     jsonb;
  n      int := 0;
  partner bigint;
  mine   int;
  theirs int;
begin
  if me is null then raise exception 'Not a member'; end if;
  if not exists (select 1 from players where id = p_player_id and account_email = me) then
    raise exception 'That player is not linked to your account';
  end if;
  if sid is null then raise exception 'There is no game to review yet'; end if;
  select * into sess from sessions where id = sid;
  if app_now() >= review_window_closes(sess.play_date) then
    raise exception 'Reviews for this game closed %', et_label(review_window_closes(sess.play_date));
  end if;
  select court into crt from assignments
   where session_id = sid and player_id = p_player_id and sess.locked_at is not null;
  if crt is null then
    raise exception 'Our records show this player did not play on that Sunday, so there is no game to review';
  end if;
  select array_agg(player_id) into mates from assignments
   where session_id = sid and court = crt and player_id <> p_player_id;

  if jsonb_typeof(p_sets) <> 'array' or jsonb_array_length(p_sets) not between 1 and 5 then
    raise exception 'Enter between 1 and 5 sets';
  end if;
  if p_enjoyment is null or p_enjoyment not between 1 and 5 then
    raise exception 'Please rate how much you enjoyed the game, from 1 to 5';
  end if;
  if char_length(p_comments) > 1000 then
    raise exception 'Comments can be at most 1000 characters';
  end if;

  delete from game_reviews where session_id = sid and player_id = p_player_id;
  insert into game_reviews (session_id, player_id, court, enjoyment, comments, submitted_by, submitted_at)
  values (sid, p_player_id, crt, p_enjoyment, nullif(trim(p_comments), ''), me, app_now())
  returning id into rid;

  for st in select * from jsonb_array_elements(p_sets) loop
    n := n + 1;
    partner := nullif(st->>'partner_id', '')::bigint;
    mine := (st->>'my_games')::int;
    theirs := (st->>'their_games')::int;
    if mine is null or theirs is null or mine not between 0 and 7 or theirs not between 0 and 7 then
      raise exception 'Set %: games must be whole numbers from 0 to 7', n;
    end if;
    if coalesce(array_length(mates, 1), 0) = 1 then
      -- Singles: the player is player set 1, the opponent player set 2.
      insert into review_sets values (rid, n, array[p_player_id], mates, mine, theirs);
    else
      if partner is null or not (partner = any (mates)) then
        raise exception 'Set %: choose your partner from the players on your court', n;
      end if;
      insert into review_sets values (rid, n, array[p_player_id, partner],
        array(select x from unnest(mates) x where x <> partner order by x), mine, theirs);
    end if;
  end loop;
  return my_review();
end;
$$;

revoke all on function public.review_session_id(), public.review_window_closes(date),
  public.player_name(bigint), public.review_json(bigint) from anon, authenticated, public;
revoke all on function public.my_review(), public.submit_review(bigint, jsonb, int, text) from anon, public;
grant execute on function public.my_review(), public.submit_review(bigint, jsonb, int, text) to authenticated;
