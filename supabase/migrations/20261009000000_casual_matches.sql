-- Casual Play matches: singles (2 players) and doubles (4 players).
--
-- A match forms among players who ticked "Email me about Casual Play
-- matches", whose levels suit each other both ways (each player's level is
-- one the other chose), whose times share at least an hour, and who are open
-- to that kind of game (each posted time says Singles, Doubles or Either).
--
-- If everyone in a match shows their name for that time, they all get an
-- invitation with each other's names and email addresses. Otherwise only the
-- players whose names are hidden are emailed, and asked to show their name for
-- that time; once everyone is shown, the invitations go out.
--
-- Replaces the earlier "someone overlaps you" emails (casual_alerts).

-- ---------- Posted times: kind of game, and "show my name" per time ----------
alter table public.casual_slots
  add column play_type text not null default 'either' check (play_type in ('singles', 'doubles', 'either')),
  -- null = follow the account's "Show my name" setting
  add column show_name boolean;

drop function public.claim_casual_alerts();
drop table public.casual_alerts;

create table public.casual_matches (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('singles', 'doubles')),
  starts_at  timestamptz not null,   -- the time all players share
  ends_at    timestamptz not null,
  created_at timestamptz not null default now(),
  invited_at timestamptz             -- when the invitations were queued
);

create table public.casual_match_players (
  match_id        bigint not null references public.casual_matches (id) on delete cascade,
  slot_id         bigint not null references public.casual_slots (id) on delete cascade,
  reveal_asked_at timestamptz,       -- when this player was asked to show their name
  primary key (match_id, slot_id)
);
create index casual_match_players_slot_idx on public.casual_match_players (slot_id);

-- Emails waiting to go out (sent by the timed-tasks function).
create table public.casual_outbox (
  id         bigint generated always as identity primary key,
  match_id   bigint not null references public.casual_matches (id) on delete cascade,
  slot_id    bigint not null references public.casual_slots (id) on delete cascade,
  kind       text not null check (kind in ('invite', 'reveal')),
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);

alter table public.casual_matches       enable row level security;
alter table public.casual_match_players enable row level security;
alter table public.casual_outbox        enable row level security;
revoke all on public.casual_matches, public.casual_match_players, public.casual_outbox from anon, authenticated;

-- ---------- Helpers ----------

-- Whether a posted time shows the player's name.
create function public.casual_slot_shown(p_slot_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(s.show_name, cp.show_name, false)
    from casual_slots s join players p on p.id = s.player_id
    left join casual_prefs cp on cp.account_email = p.account_email
   where s.id = p_slot_id;
$$;

-- Whether two posted times can be in the same match of this kind.
create function public.casual_can_pair(p_a bigint, p_b bigint, p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select a.player_id <> b.player_id
       and a.play_type in (p_kind, 'either') and b.play_type in (p_kind, 'either')
       and a.starts_at > app_now() and b.starts_at > app_now()
       and least(a.starts_at + a.minutes * interval '1 minute', b.starts_at + b.minutes * interval '1 minute')
           - greatest(a.starts_at, b.starts_at) >= interval '1 hour'
       and (casual_level(pa.level) is null or casual_level(pa.level) = any (cb.levels))
       and (casual_level(pb.level) is null or casual_level(pb.level) = any (ca.levels))
      from casual_slots a
      join players pa on pa.id = a.player_id and pa.active
      join accounts aa on aa.email = pa.account_email and aa.active
      join casual_prefs ca on ca.account_email = pa.account_email and ca.notify
      cross join casual_slots b
      join players pb on pb.id = b.player_id and pb.active
      join accounts ab on ab.email = pb.account_email and ab.active
      join casual_prefs cb on cb.account_email = pb.account_email and cb.notify
     where a.id = p_a and b.id = p_b), false);
$$;

create function public.casual_in_match(p_slot_id bigint, p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from casual_match_players mp join casual_matches m on m.id = mp.match_id
                  where mp.slot_id = p_slot_id and m.kind = p_kind);
$$;

-- Queues the match's emails: invitations once everyone shows their name,
-- otherwise a one-time "show your name" email to each hidden player.
create function public.casual_queue_emails(p_match_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if (select invited_at from casual_matches where id = p_match_id) is not null then return; end if;
  if (select bool_and(casual_slot_shown(slot_id)) from casual_match_players where match_id = p_match_id) then
    update casual_matches set invited_at = app_now() where id = p_match_id;
    insert into casual_outbox (match_id, slot_id, kind)
    select p_match_id, slot_id, 'invite' from casual_match_players where match_id = p_match_id;
  else
    insert into casual_outbox (match_id, slot_id, kind)
    select p_match_id, slot_id, 'reveal' from casual_match_players
     where match_id = p_match_id and reveal_asked_at is null and not casual_slot_shown(slot_id);
    update casual_match_players set reveal_asked_at = app_now()
     where match_id = p_match_id and reveal_asked_at is null and not casual_slot_shown(slot_id);
  end if;
end;
$$;

create function public.casual_make_match(p_kind text, p_slots bigint[]) returns void
language plpgsql security definer set search_path = public as $$
declare mid bigint;
begin
  insert into casual_matches (kind, starts_at, ends_at)
  select p_kind, max(starts_at), min(starts_at + minutes * interval '1 minute')
    from casual_slots where id = any (p_slots)
  returning id into mid;
  insert into casual_match_players (match_id, slot_id) select mid, unnest(p_slots);
  perform casual_queue_emails(mid);
end;
$$;

-- Looks for a singles partner and a doubles four for this posted time, among
-- times not already in a match of that kind (earliest posted first).
create function public.casual_find_matches(p_slot_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  s     casual_slots;
  other bigint;
  cand  casual_slots;
  grp   bigint[];
  ws    timestamptz;
  we    timestamptz;
begin
  select * into s from casual_slots where id = p_slot_id;
  if not found then return; end if;

  if s.play_type in ('singles', 'either') and not casual_in_match(s.id, 'singles') then
    select o.id into other from casual_slots o
     where o.id <> s.id and not casual_in_match(o.id, 'singles') and casual_can_pair(s.id, o.id, 'singles')
     order by o.created_at, o.id limit 1;
    if other is not null then perform casual_make_match('singles', array[s.id, other]); end if;
  end if;

  if s.play_type in ('doubles', 'either') and not casual_in_match(s.id, 'doubles') then
    grp := array[s.id];
    ws := s.starts_at;
    we := s.starts_at + s.minutes * interval '1 minute';
    for cand in select o.* from casual_slots o
                 where o.id <> s.id and not casual_in_match(o.id, 'doubles') and casual_can_pair(s.id, o.id, 'doubles')
                 order by o.created_at, o.id loop
      if least(we, cand.starts_at + cand.minutes * interval '1 minute') - greatest(ws, cand.starts_at) >= interval '1 hour'
         and (select bool_and(casual_can_pair(g, cand.id, 'doubles')) from unnest(grp) g)
         and cand.player_id <> all (select player_id from casual_slots where id = any (grp)) then
        grp := grp || cand.id;
        ws := greatest(ws, cand.starts_at);
        we := least(we, cand.starts_at + cand.minutes * interval '1 minute');
        exit when cardinality(grp) = 4;
      end if;
    end loop;
    if cardinality(grp) = 4 then perform casual_make_match('doubles', grp); end if;
  end if;
end;
$$;

-- ---------- What members can do ----------

-- Post availability: p_date and p_start are US Eastern, e.g. '2026-10-10', '09:30'.
-- p_play_type: 'singles', 'doubles' or 'either'. p_show_name: null follows the account setting.
drop function public.casual_submit(bigint, date, time, int);
create function public.casual_submit(p_player_id bigint, p_date date, p_start time, p_minutes int,
                                     p_play_type text default 'either', p_show_name boolean default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  me     text := my_email();
  today_ date := casual_today();
  start_ timestamptz;
  end_   timestamptz;
  v_id   bigint;
begin
  if me is null then raise exception 'Not a member'; end if;
  if not exists (select 1 from players where id = p_player_id and account_email = me and active) then
    raise exception 'That player is not linked to your account';
  end if;
  if not (select membership_current from accounts where email = me) then
    raise exception '%', (select dues_message from settings);
  end if;
  if p_minutes is null or p_minutes not in (60, 90, 120) then
    raise exception 'Choose 1, 1.5 or 2 hours';
  end if;
  if p_play_type is null or p_play_type not in ('singles', 'doubles', 'either') then
    raise exception 'Choose Singles, Doubles or Either';
  end if;
  if p_start is null or extract(second from p_start) <> 0 or extract(minute from p_start) not in (0, 30) then
    raise exception 'Start on the hour or half hour';
  end if;
  if p_start < time '06:00' or p_start + p_minutes * interval '1 minute' > time '21:00'
     or p_start + p_minutes * interval '1 minute' < p_start then
    raise exception 'Casual Play times are between 6am and 9pm';
  end if;
  if p_date is null or p_date < today_ or p_date >= today_ + 28 then
    raise exception 'Choose a day in the next 4 weeks';
  end if;
  start_ := (p_date + p_start) at time zone 'America/New_York';
  end_   := start_ + p_minutes * interval '1 minute';
  if start_ <= app_now() then raise exception 'That time has already started'; end if;
  if exists (select 1 from casual_slots
              where player_id = p_player_id
                and starts_at < end_ and starts_at + minutes * interval '1 minute' > start_) then
    raise exception 'You are already available for part of that time. Unsubmit it first to change it';
  end if;

  insert into casual_slots (player_id, starts_at, minutes, play_type, show_name)
  values (p_player_id, start_, p_minutes, p_play_type, p_show_name)
  returning id into v_id;
  perform casual_find_matches(v_id);
  return v_id;
end;
$$;

-- Show or hide the name on one of your posted times.
create function public.casual_set_slot_name(p_slot_id bigint, p_show_name boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  me  text := my_email();
  mid bigint;
begin
  if me is null then raise exception 'Not a member'; end if;
  update casual_slots s set show_name = coalesce(p_show_name, false)
    from players p
   where s.id = p_slot_id and p.id = s.player_id and p.account_email = me;
  if not found then raise exception 'That availability is not yours, or was already removed'; end if;
  for mid in select match_id from casual_match_players where slot_id = p_slot_id loop
    perform casual_queue_emails(mid);
  end loop;
end;
$$;

create or replace function public.casual_unsubmit(p_slot_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  me     text := my_email();
  others bigint[];
  sid    bigint;
begin
  if me is null then raise exception 'Not a member'; end if;
  if not exists (select 1 from casual_slots s join players p on p.id = s.player_id
                  where s.id = p_slot_id and p.account_email = me) then
    raise exception 'That availability is not yours, or was already removed';
  end if;
  -- The other players in matches that haven't been announced yet: those
  -- matches dissolve, and those players look for new matches.
  select coalesce(array_agg(distinct mp2.slot_id), '{}') into others
    from casual_match_players mp
    join casual_matches m on m.id = mp.match_id and m.invited_at is null
    join casual_match_players mp2 on mp2.match_id = m.id and mp2.slot_id <> p_slot_id
   where mp.slot_id = p_slot_id;
  delete from casual_matches m using casual_match_players mp
   where mp.match_id = m.id and mp.slot_id = p_slot_id and m.invited_at is null;
  delete from casual_slots where id = p_slot_id;
  foreach sid in array others loop
    perform casual_find_matches(sid);
  end loop;
end;
$$;

create or replace function public.casual_save_prefs(p_show_name boolean, p_notify boolean, p_levels text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me  text := my_email();
  sid bigint;
  mid bigint;
begin
  if me is null then raise exception 'Not a member'; end if;
  if p_levels is null or cardinality(p_levels) not between 1 and 2
     or not (p_levels <@ casual_levels())
     or cardinality(p_levels) <> (select count(distinct l) from unnest(p_levels) l) then
    raise exception 'Choose 1 or 2 play levels';
  end if;
  insert into casual_prefs (account_email, show_name, notify, levels)
  values (me, coalesce(p_show_name, false), coalesce(p_notify, false), p_levels)
  on conflict (account_email) do update
    set show_name = excluded.show_name, notify = excluded.notify, levels = excluded.levels;
  -- Times that follow the account setting may now show the name.
  for mid in select distinct mp.match_id from casual_match_players mp
               join casual_slots s on s.id = mp.slot_id join players p on p.id = s.player_id
              where p.account_email = me loop
    perform casual_queue_emails(mid);
  end loop;
  -- Newly opted in (or new levels): look for matches for upcoming times.
  if p_notify then
    for sid in select s.id from casual_slots s join players p on p.id = s.player_id
                where p.account_email = me and s.starts_at > app_now() order by s.starts_at loop
      perform casual_find_matches(sid);
    end loop;
  end if;
  return casual_my_prefs();
end;
$$;

-- The calendar, now with each time's kind of game, its own "show my name",
-- and (for your own times) the matches it is in.
create or replace function public.casual_calendar() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me     text := my_email();
  now_   timestamptz := app_now();
  today_ date := casual_today();
  local_now timestamp := app_now() at time zone 'America/New_York';
begin
  if me is null then raise exception 'Not a member'; end if;
  return jsonb_build_object(
    'now', now_,
    'today', today_,
    'now_minutes', (extract(hour from local_now) * 60 + extract(minute from local_now))::int,
    'days', 28,
    'test_mode', (select test_mode from settings),
    'levels', to_jsonb(casual_levels()),
    'prefs', casual_my_prefs(),
    'membership_current', (select membership_current from accounts where email = me),
    'dues_message', (select dues_message from settings),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'first_name', p.first_name, 'last_name', p.last_name,
                                          'level', casual_level(p.level), 'sex', p.sex) order by p.first_name)
        from players p where p.account_email = me and p.active), '[]'::jsonb),
    'slots', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', case when mine then s.id end,
               'player_id', case when mine then s.player_id end,
               'mine', mine,
               'day', (s.starts_at at time zone 'America/New_York')::date,
               'start', (extract(hour from s.starts_at at time zone 'America/New_York') * 60
                         + extract(minute from s.starts_at at time zone 'America/New_York'))::int,
               'minutes', s.minutes,
               'play_type', s.play_type,
               'level', casual_level(p.level),
               'sex', p.sex,
               'shown', casual_slot_shown(s.id),
               'name', case when mine or casual_slot_shown(s.id) then p.first_name || ' ' || p.last_name end,
               'matches', case when mine then coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'kind', m.kind, 'starts_at', m.starts_at, 'ends_at', m.ends_at,
                           'invited', m.invited_at is not null,
                           'waiting_for', (select count(*) from casual_match_players o
                                            where o.match_id = m.id and not casual_slot_shown(o.slot_id)))
                         order by m.kind desc)
                    from casual_match_players mp join casual_matches m on m.id = mp.match_id
                   where mp.slot_id = s.id), '[]'::jsonb) end)
             order by s.starts_at)
        from casual_slots s
        join players p on p.id = s.player_id and p.active
        join accounts a on a.email = p.account_email and a.active
        cross join lateral (select p.account_email = me as mine) m
       where s.starts_at + s.minutes * interval '1 minute' > now_
         and (s.starts_at at time zone 'America/New_York')::date < today_ + 28), '[]'::jsonb));
end;
$$;

-- ---------- Emails (called by the timed-tasks function only) ----------

-- Hands out waiting match emails, once each. Skipped if the time has started
-- or the player has turned Casual Play emails off since.
create function public.claim_casual_emails() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  now_ timestamptz := app_now();
  result jsonb;
begin
  with due as (
    update casual_outbox set sent_at = now_ where sent_at is null
    returning match_id, slot_id, kind
  )
  select jsonb_agg(jsonb_build_object(
           'kind', d.kind, 'email', p.account_email, 'first_name', p.first_name, 'slot_id', d.slot_id,
           'match_kind', m.kind, 'starts_at', m.starts_at, 'ends_at', m.ends_at,
           'others', (select jsonb_agg(jsonb_build_object(
                               'name', case when casual_slot_shown(o.slot_id) then op.first_name || ' ' || op.last_name end,
                               -- email addresses only in invitations, when everyone shows their name
                               'email', case when d.kind = 'invite' then op.account_email end,
                               'level', casual_level(op.level), 'sex', op.sex)
                             order by os.created_at)
                        from casual_match_players o
                        join casual_slots os on os.id = o.slot_id
                        join players op on op.id = os.player_id
                       where o.match_id = m.id and o.slot_id <> d.slot_id))
         order by d.match_id, d.slot_id)
    into result
    from due d
    join casual_matches m on m.id = d.match_id
    join casual_slots s on s.id = d.slot_id
    join players p on p.id = s.player_id and p.active
    join casual_prefs cp on cp.account_email = p.account_email and cp.notify
   where m.starts_at > now_;
  return coalesce(result, '[]'::jsonb);
end;
$$;

revoke all on function public.casual_submit(bigint, date, time, int, text, boolean),
  public.casual_set_slot_name(bigint, boolean), public.claim_casual_emails(),
  public.casual_slot_shown(bigint), public.casual_can_pair(bigint, bigint, text), public.casual_in_match(bigint, text),
  public.casual_queue_emails(bigint), public.casual_make_match(text, bigint[]), public.casual_find_matches(bigint)
  from public, anon, authenticated;
grant execute on function public.casual_submit(bigint, date, time, int, text, boolean),
  public.casual_set_slot_name(bigint, boolean) to authenticated;
