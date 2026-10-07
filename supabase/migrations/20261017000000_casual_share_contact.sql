-- Casual Play: "Share my contact info for games" replaces the Singles,
-- Doubles or Either choice.
--
-- Every posted time now lines up with every other player's time that shares
-- at least an hour, at levels that suit both ways, on a different account
-- (casual_pairs), whatever their email settings. On the calendar, a player's
-- time is flagged where a singles game is possible (another player lines up)
-- and where a doubles game is possible (three other players who all line up
-- with each other share the same hour: casual_doubles).
--
-- Contact info (name and email address) is only passed on between players who
-- share it for that time: each player sets "Share my contact info for games"
-- (Yes/No) in My settings, and can change it for each time, like "Show my
-- name". When every player in a possible game shares, each of them sees the
-- others' email addresses. A player who shares can have the app email the
-- players who don't, telling them about the game (casual_invite and the
-- casual-invite function). Those emails list the name and email address of
-- the players who share, and nothing about the players who don't beyond what
-- the calendar already shows.
--
-- The "players line up with your time" emails (for players with "Email me"
-- on) follow the same rule: players who share get each other's details;
-- players who don't are asked to share.

alter table public.casual_prefs add column share_contact boolean not null default false;
alter table public.casual_slots add column share_contact boolean;   -- null: the account's setting
alter table public.casual_slots drop column play_type;

-- Who has been emailed by another player about a possible game: slot_id's
-- player asked other_slot_id's player (once per time, game and player).
create table public.casual_invites (
  slot_id       bigint not null references public.casual_slots (id) on delete cascade,
  other_slot_id bigint not null references public.casual_slots (id) on delete cascade,
  kind          text not null check (kind in ('singles', 'doubles')),
  sent_at       timestamptz not null,
  primary key (slot_id, other_slot_id, kind)
);
create index casual_invites_other_idx on public.casual_invites (other_slot_id);
alter table public.casual_invites enable row level security;
revoke all on public.casual_invites from anon, authenticated;

-- The wording of the two "line up" emails changed (no more "looking for"),
-- so earlier edits to them are dropped in favor of the new default wording.
delete from public.email_templates where key in ('casual_game', 'casual_reveal');

create function public.casual_slot_shares(p_slot_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(s.share_contact, cp.share_contact, false)
    from casual_slots s join players p on p.id = s.player_id
    left join casual_prefs cp on cp.account_email = p.account_email
   where s.id = p_slot_id;
$$;

-- Every pair of upcoming posted times that line up (both ways round), with
-- the time they share. A player who hasn't saved their settings yet sees
-- (and suits) their own level.
create or replace function public.casual_pairs()
returns table (slot_id bigint, other_id bigint, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  with s as (
    select s.id, s.starts_at, s.starts_at + s.minutes * interval '1 minute' as ends_at,
           p.account_email, casual_level(p.level) as lvl,
           coalesce(cp.levels, array[coalesce(casual_level(p.level), '3.5')]) as levels
      from casual_slots s
      join players p on p.id = s.player_id and p.active
      join accounts a on a.email = p.account_email and a.active and a.membership_current
      left join casual_prefs cp on cp.account_email = p.account_email
     where s.starts_at + s.minutes * interval '1 minute' > app_now() + interval '1 hour')
  select a.id, b.id, greatest(a.starts_at, b.starts_at), least(a.ends_at, b.ends_at)
    from s a join s b on a.account_email <> b.account_email
   where greatest(a.starts_at, b.starts_at) > app_now()
     and least(a.ends_at, b.ends_at) - greatest(a.starts_at, b.starts_at) >= interval '1 hour'
     and (b.lvl is null or b.lvl = any (a.levels))
     and (a.lvl is null or a.lvl = any (b.levels));
$$;

-- Possible doubles games: for each posted time and each hour (starting on the
-- hour or half hour) within it, the other players who make a four with it:
-- three players who all line up with that time and with each other, and are
-- all free for that hour.
create function public.casual_doubles()
returns table (slot_id bigint, starts_at timestamptz, others bigint[])
language sql stable security definer set search_path = public as $$
  with pr as materialized (select * from casual_pairs()),
  w as materialized (
    select pr.slot_id, pr.other_id, g as starts_at
      from pr, generate_series(pr.starts_at, pr.ends_at - interval '1 hour', interval '30 minutes') g)
  select a.slot_id, a.starts_at, array_agg(distinct x order by x)
    from w a
    join w b on b.slot_id = a.slot_id and b.starts_at = a.starts_at and b.other_id > a.other_id
    join w c on c.slot_id = a.slot_id and c.starts_at = a.starts_at and c.other_id > b.other_id
    join pr ab on ab.slot_id = a.other_id and ab.other_id = b.other_id
    join pr ac on ac.slot_id = a.other_id and ac.other_id = c.other_id
    join pr bc on bc.slot_id = b.other_id and bc.other_id = c.other_id
    cross join lateral unnest(array[a.other_id, b.other_id, c.other_id]) x
   group by a.slot_id, a.starts_at;
$$;

-- ---------- Settings ----------

create or replace function public.casual_my_prefs() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('show_name', show_name, 'share_contact', share_contact, 'notify', notify,
                               'levels', to_jsonb(levels), 'saved', true)
       from casual_prefs where account_email = my_email()),
    jsonb_build_object('show_name', false, 'share_contact', false, 'notify', false, 'saved', false, 'levels',
      to_jsonb(coalesce((select array[casual_level(level)] from players
                          where account_email = my_email() and active and casual_level(level) is not null
                          order by id limit 1), array['3.5']))));
$$;

drop function public.casual_save_prefs(boolean, boolean, text[]);
create function public.casual_save_prefs(p_show_name boolean, p_notify boolean, p_levels text[],
                                         p_share_contact boolean default null) returns jsonb
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
  insert into casual_prefs (account_email, show_name, notify, levels, share_contact)
  values (me, coalesce(p_show_name, false), coalesce(p_notify, false), p_levels, coalesce(p_share_contact, false))
  on conflict (account_email) do update
    set show_name = excluded.show_name, notify = excluded.notify, levels = excluded.levels,
        share_contact = coalesce(p_share_contact, casual_prefs.share_contact);
  return casual_my_prefs();
end;
$$;

-- ---------- Posting a time ----------

drop function public.casual_submit(bigint, date, time, int, text, boolean);
create function public.casual_submit(p_player_id bigint, p_date date, p_start time, p_minutes int,
                                     p_show_name boolean default null, p_share_contact boolean default null) returns bigint
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

  insert into casual_slots (player_id, starts_at, minutes, show_name, share_contact)
  values (p_player_id, start_, p_minutes, p_show_name, p_share_contact)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.casual_set_slot_share(p_slot_id bigint, p_share boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  me text := my_email();
begin
  if me is null then raise exception 'Not a member'; end if;
  update casual_slots s set share_contact = coalesce(p_share, false)
    from players p
   where s.id = p_slot_id and p.id = s.player_id and p.account_email = me;
  if not found then raise exception 'That availability is not yours, or was already removed'; end if;
end;
$$;

-- ---------- The calendar ----------
-- For your own times: the players whose times line up with them (their name
-- if they show it or share their contact info; their email address only if
-- you both share), whether you've emailed them about a game, and the possible
-- doubles games.
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
      with mine as materialized (
        select s.id from casual_slots s join players p on p.id = s.player_id where p.account_email = me),
      pr as materialized (select pr.* from casual_pairs() pr where pr.slot_id in (select id from mine)),
      dbl as materialized (select d.* from casual_doubles() d where d.slot_id in (select id from mine))
      select jsonb_agg(jsonb_build_object(
               'id', case when mine then s.id end,
               'player_id', case when mine then s.player_id end,
               'mine', mine,
               'day', (s.starts_at at time zone 'America/New_York')::date,
               'start', (extract(hour from s.starts_at at time zone 'America/New_York') * 60
                         + extract(minute from s.starts_at at time zone 'America/New_York'))::int,
               'minutes', s.minutes,
               'level', casual_level(p.level),
               'sex', p.sex,
               'shown', casual_slot_shown(s.id),
               'shares', case when mine then casual_slot_shares(s.id) end,
               'name', case when mine or casual_slot_shown(s.id) then p.first_name || ' ' || p.last_name end,
               'lines_up', case when mine then coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'slot_id', pr.other_id,
                           'name', case when casual_slot_shown(pr.other_id) or casual_slot_shares(pr.other_id)
                                        then op.first_name || ' ' || op.last_name end,
                           'level', casual_level(op.level), 'sex', op.sex,
                           'shares', casual_slot_shares(pr.other_id),
                           'email', case when casual_slot_shares(s.id) and casual_slot_shares(pr.other_id)
                                         then op.account_email end,
                           'asked', coalesce((select jsonb_agg(i.kind order by i.kind) from casual_invites i
                                               where i.slot_id = s.id and i.other_slot_id = pr.other_id), '[]'::jsonb),
                           'starts_at', pr.starts_at, 'ends_at', pr.ends_at)
                         order by pr.starts_at, os.created_at)
                    from pr
                    join casual_slots os on os.id = pr.other_id
                    join players op on op.id = os.player_id
                   where pr.slot_id = s.id), '[]'::jsonb) end,
               'doubles', case when mine then coalesce((
                  select jsonb_agg(jsonb_build_object('starts_at', d.starts_at, 'others', to_jsonb(d.others))
                                   order by d.starts_at)
                    from dbl d where d.slot_id = s.id), '[]'::jsonb) end)
             order by s.starts_at)
        from casual_slots s
        join players p on p.id = s.player_id and p.active
        join accounts a on a.email = p.account_email and a.active and a.membership_current
        cross join lateral (select p.account_email = me as mine) m
       where s.starts_at + s.minutes * interval '1 minute' > now_
         and (s.starts_at at time zone 'America/New_York')::date < today_ + 28), '[]'::jsonb));
end;
$$;

-- ---------- Emailing players who don't share their contact info ----------
-- A player who shares their contact info for one of their times asks the app
-- to email the players in a possible game (1 other player for singles, 3 for
-- doubles) who don't share theirs. Checks that they all still line up and
-- share an hour, records who is emailed (once per time, game and player),
-- and returns what the casual-invite function needs to send the emails.
create function public.casual_invite(p_slot_id bigint, p_others bigint[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me       text := my_email();
  n        int := coalesce(cardinality(p_others), 0);
  kind_    text := 'singles';
  all_     bigint[];
  from_    timestamptz;
  to_      timestamptz;
  result   jsonb;
begin
  if me is null then raise exception 'Not a member'; end if;
  if not exists (select 1 from casual_slots s join players p on p.id = s.player_id
                  where s.id = p_slot_id and p.account_email = me) then
    raise exception 'That availability is not yours, or was already removed';
  end if;
  if not casual_slot_shares(p_slot_id) then
    raise exception 'Turn on "Share my contact info for games" for this time first';
  end if;
  if n not in (1, 3) or p_slot_id = any (p_others)
     or n <> (select count(distinct x) from unnest(p_others) x where x is not null) then
    raise exception 'Choose 1 player for singles or 3 for doubles';
  end if;
  if n = 3 then kind_ := 'doubles'; end if;
  all_ := array[p_slot_id] || p_others;
  -- Every two of them line up (both ways round), and they share an hour.
  if (select count(*) from casual_pairs() pr where pr.slot_id = any (all_) and pr.other_id = any (all_)) <> (n + 1) * n then
    raise exception 'Those players no longer line up with your time';
  end if;
  select max(starts_at), min(starts_at + minutes * interval '1 minute') into from_, to_
    from casual_slots where id = any (all_);
  if to_ - from_ < interval '1 hour' then
    raise exception 'Those players are not all free for the same hour';
  end if;
  if not exists (select 1 from unnest(p_others) x where not casual_slot_shares(x)) then
    raise exception 'They all share their contact info: copy their email addresses instead';
  end if;
  if not exists (select 1 from unnest(p_others) x
                  where not casual_slot_shares(x)
                    and not exists (select 1 from casual_invites i
                                     where i.slot_id = p_slot_id and i.other_slot_id = x and i.kind = kind_)) then
    raise exception 'You have already emailed them about this game';
  end if;

  with sent as (
    insert into casual_invites (slot_id, other_slot_id, kind, sent_at)
    select p_slot_id, x, kind_, app_now() from unnest(p_others) x
     where not casual_slot_shares(x)
    on conflict do nothing
    returning other_slot_id)
  select jsonb_build_object(
           'kind', kind_, 'starts_at', from_, 'ends_at', to_,
           'inviter', (select p.first_name || ' ' || p.last_name from casual_slots s join players p on p.id = s.player_id
                        where s.id = p_slot_id),
           'recipients', (select jsonb_agg(jsonb_build_object('slot_id', s.id, 'email', p.account_email,
                                                             'first_name', p.first_name) order by s.id)
                            from sent join casual_slots s on s.id = sent.other_slot_id
                            join players p on p.id = s.player_id),
           'players', (select jsonb_agg(jsonb_build_object(
                                'slot_id', s.id,
                                'name', case when casual_slot_shares(s.id) or casual_slot_shown(s.id)
                                             then p.first_name || ' ' || p.last_name end,
                                'email', case when casual_slot_shares(s.id) then p.account_email end,
                                'sex', p.sex, 'level', casual_level(p.level))
                              order by array_position(all_, s.id))
                         from casual_slots s join players p on p.id = s.player_id where s.id = any (all_)))
    into result;
  return result;
end;
$$;

-- ---------- The "players line up with your time" emails ----------
-- As before, but only for players with "Email me" on, and contact info goes
-- only between players who share it for those times: a player who shares is
-- emailed whenever a new player who also shares lines up, with everyone's
-- name and email address; a player who doesn't share is emailed whenever a
-- new player lines up, asking them to share.
create or replace function public.claim_casual_emails() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  now_ timestamptz := app_now();
  wait_ interval := (select casual_email_delay_minutes from settings) * interval '1 minute';
  result jsonb;
begin
  create temporary table casual_due on commit drop as
  with pr as (
    select pr.*, casual_slot_shares(pr.slot_id) as me_shares, casual_slot_shares(pr.other_id) as o_shares,
           o.player_id as other_player,
           t.slot_id is not null as told, coalesce(t.with_contacts, false) as told_contacts
      from casual_pairs() pr
      join casual_slots o on o.id = pr.other_id and o.created_at <= now_ - wait_
      join casual_slots ms on ms.id = pr.slot_id and ms.created_at <= now_ - wait_
      join players mp on mp.id = ms.player_id
      join casual_prefs mcp on mcp.account_email = mp.account_email and mcp.notify
      left join casual_told t on t.slot_id = pr.slot_id and t.other_player_id = o.player_id)
  select pr.*, case when me_shares then not told_contacts else not told end as is_new,
         count(*) filter (where me_shares and not o_shares) over (partition by pr.slot_id) as hidden_count
    from pr;
  -- Sharing: only players who also share are listed. Not sharing: everyone.
  delete from casual_due where me_shares and not o_shares;
  delete from casual_due d where not exists (select 1 from casual_due n where n.slot_id = d.slot_id and n.is_new);

  insert into casual_told (slot_id, other_player_id, with_contacts, told_at)
  select distinct on (slot_id, other_player) slot_id, other_player, me_shares, now_ from casual_due
   order by slot_id, other_player
  on conflict (slot_id, other_player_id) do update
    set with_contacts = casual_told.with_contacts or excluded.with_contacts, told_at = excluded.told_at;

  select jsonb_agg(x order by x->>'starts_at', x->>'slot_id') into result from (
    select jsonb_build_object(
             'kind', case when bool_or(d.me_shares) then 'game' else 'reveal' end,
             'email', p.account_email, 'first_name', p.first_name, 'slot_id', s.id,
             'starts_at', s.starts_at, 'ends_at', s.starts_at + s.minutes * interval '1 minute',
             'hidden_count', max(d.hidden_count),
             'others', jsonb_agg(jsonb_build_object(
                         'name', case when d.o_shares or casual_slot_shown(d.other_id) then op.first_name || ' ' || op.last_name end,
                         'email', case when d.me_shares and d.o_shares then op.account_email end,
                         'level', casual_level(op.level), 'sex', op.sex,
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

revoke all on function public.casual_slot_shares(bigint), public.casual_doubles(), public.casual_pairs(),
  public.claim_casual_emails(), public.casual_save_prefs(boolean, boolean, text[], boolean),
  public.casual_submit(bigint, date, time, int, boolean, boolean), public.casual_set_slot_share(bigint, boolean),
  public.casual_invite(bigint, bigint[])
  from public, anon, authenticated;
grant execute on function public.casual_save_prefs(boolean, boolean, text[], boolean),
  public.casual_submit(bigint, date, time, int, boolean, boolean), public.casual_set_slot_share(bigint, boolean),
  public.casual_invite(bigint, bigint[]) to authenticated;
