-- Casual Play games: instead of pairing players into fixed singles or
-- doubles matches, everyone whose time lines up with yours hears about
-- everyone else, and the players decide among themselves who plays (singles,
-- or doubles if they find four, perhaps by inviting a fourth player).
--
-- Two posted times line up when both players ticked "Email me when players
-- line up with my times", their levels suit each other both ways (each
-- player's level is one the other chose), the times share at least an hour
-- that hasn't started yet, the game types fit (Either fits anything; Singles
-- and Doubles don't fit each other), and they are on different accounts.
--
-- At each email run, a player whose name is shown for a time is emailed when
-- a new player who also shows their name lines up with it, with everyone's
-- name and email address. A player whose name is hidden for a time is emailed
-- when a new player lines up with it, asking them to show their name.

drop function public.claim_casual_emails();
drop function public.casual_find_matches(bigint);
drop function public.casual_make_match(text, bigint[]);
drop function public.casual_queue_emails(bigint);
drop function public.casual_in_match(bigint, text);
drop function public.casual_can_pair(bigint, bigint, text);
drop table public.casual_outbox;
drop table public.casual_match_players;
drop table public.casual_matches;

-- Who has been told about whom: slot_id's player has been emailed about
-- other_slot_id (with_contacts: with name and email, not just "show your name").
create table public.casual_told (
  slot_id       bigint not null references public.casual_slots (id) on delete cascade,
  other_slot_id bigint not null references public.casual_slots (id) on delete cascade,
  with_contacts boolean not null,
  told_at       timestamptz not null,
  primary key (slot_id, other_slot_id)
);
create index casual_told_other_idx on public.casual_told (other_slot_id);
alter table public.casual_told enable row level security;
revoke all on public.casual_told from anon, authenticated;

-- Every pair of upcoming posted times that line up (both ways round), with
-- the time they share.
create function public.casual_pairs()
returns table (slot_id bigint, other_id bigint, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  with s as (
    select s.id, s.starts_at, s.starts_at + s.minutes * interval '1 minute' as ends_at, s.play_type,
           p.account_email, casual_level(p.level) as lvl, cp.levels
      from casual_slots s
      join players p on p.id = s.player_id and p.active
      join accounts a on a.email = p.account_email and a.active
      join casual_prefs cp on cp.account_email = p.account_email and cp.notify
     where s.starts_at + s.minutes * interval '1 minute' > app_now() + interval '1 hour')
  select a.id, b.id, greatest(a.starts_at, b.starts_at), least(a.ends_at, b.ends_at)
    from s a join s b on a.account_email <> b.account_email
   where not (a.play_type = 'singles' and b.play_type = 'doubles')
     and not (a.play_type = 'doubles' and b.play_type = 'singles')
     and greatest(a.starts_at, b.starts_at) > app_now()
     and least(a.ends_at, b.ends_at) - greatest(a.starts_at, b.starts_at) >= interval '1 hour'
     and (b.lvl is null or b.lvl = any (a.levels))
     and (a.lvl is null or a.lvl = any (b.levels));
$$;

-- ---------- What members can do (no matching at the moment of posting now) ----------

create or replace function public.casual_submit(p_player_id bigint, p_date date, p_start time, p_minutes int,
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
  return v_id;
end;
$$;

create or replace function public.casual_set_slot_name(p_slot_id bigint, p_show_name boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  me text := my_email();
begin
  if me is null then raise exception 'Not a member'; end if;
  update casual_slots s set show_name = coalesce(p_show_name, false)
    from players p
   where s.id = p_slot_id and p.id = s.player_id and p.account_email = me;
  if not found then raise exception 'That availability is not yours, or was already removed'; end if;
end;
$$;

create or replace function public.casual_unsubmit(p_slot_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  me text := my_email();
begin
  if me is null then raise exception 'Not a member'; end if;
  delete from casual_slots s using players p
   where s.id = p_slot_id and p.id = s.player_id and p.account_email = me;
  if not found then raise exception 'That availability is not yours, or was already removed'; end if;
end;
$$;

create or replace function public.casual_save_prefs(p_show_name boolean, p_notify boolean, p_levels text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me text := my_email();
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
  return casual_my_prefs();
end;
$$;

-- The calendar: for your own times, the players whose times line up with them.
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
               'lines_up', case when mine then coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'name', case when casual_slot_shown(pr.other_id) then op.first_name || ' ' || op.last_name end,
                           'level', casual_level(op.level), 'sex', op.sex, 'play_type', os.play_type,
                           'starts_at', pr.starts_at, 'ends_at', pr.ends_at)
                         order by pr.starts_at, os.created_at)
                    from casual_pairs() pr
                    join casual_slots os on os.id = pr.other_id
                    join players op on op.id = os.player_id
                   where pr.slot_id = s.id), '[]'::jsonb) end)
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

-- One email per posted time that has a new player lining up with it since
-- the last email (see the top of this file), listing everyone who lines up.
create function public.claim_casual_emails() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  now_ timestamptz := app_now();
  result jsonb;
begin
  create temporary table casual_due on commit drop as
  with pr as (
    select pr.*, casual_slot_shown(pr.slot_id) as me_shown, casual_slot_shown(pr.other_id) as o_shown,
           t.slot_id is not null as told, coalesce(t.with_contacts, false) as told_contacts
      from casual_pairs() pr
      left join casual_told t on t.slot_id = pr.slot_id and t.other_slot_id = pr.other_id)
  select pr.*, case when me_shown then not told_contacts else not told end as is_new,
         count(*) filter (where me_shown and not o_shown) over (partition by pr.slot_id) as hidden_count
    from pr;
  -- Shown: only players who show their name are listed. Hidden: everyone.
  delete from casual_due where me_shown and not o_shown;
  delete from casual_due d where not exists (select 1 from casual_due n where n.slot_id = d.slot_id and n.is_new);

  insert into casual_told (slot_id, other_slot_id, with_contacts, told_at)
  select slot_id, other_id, me_shown, now_ from casual_due
  on conflict (slot_id, other_slot_id) do update
    set with_contacts = casual_told.with_contacts or excluded.with_contacts, told_at = excluded.told_at;

  select jsonb_agg(x order by x->>'starts_at', x->>'slot_id') into result from (
    select jsonb_build_object(
             'kind', case when bool_or(d.me_shown) then 'game' else 'reveal' end,
             'email', p.account_email, 'first_name', p.first_name, 'slot_id', s.id,
             'starts_at', s.starts_at, 'ends_at', s.starts_at + s.minutes * interval '1 minute',
             'play_type', s.play_type, 'hidden_count', max(d.hidden_count),
             'others', jsonb_agg(jsonb_build_object(
                         'name', case when d.o_shown then op.first_name || ' ' || op.last_name end,
                         'email', case when d.me_shown then op.account_email end,
                         'level', casual_level(op.level), 'sex', op.sex, 'play_type', os.play_type,
                         'starts_at', d.starts_at, 'ends_at', d.ends_at, 'new', d.is_new)
                       order by d.starts_at, os.created_at)) as x
      from casual_due d
      join casual_slots s on s.id = d.slot_id
      join players p on p.id = s.player_id
      join casual_slots os on os.id = d.other_id
      join players op on op.id = os.player_id
     group by s.id, p.account_email, p.first_name) q;
  drop table casual_due;
  return coalesce(result, '[]'::jsonb);
end;
$$;

revoke all on function public.casual_pairs(), public.claim_casual_emails() from public, anon, authenticated;
