-- Casual Play calendar: members post when they're available to play (1, 1.5
-- or 2 hours, between 6am and 9pm US Eastern, up to 4 weeks ahead) and see
-- when others at their chosen levels are available.
--
-- casual_slots: one row per posted availability.
-- casual_prefs: per account: the 1 or 2 levels shown, "Show my name", and
--   whether to get "Casual Play match" emails.
-- casual_alerts: emails waiting to go out (sent by the timed-tasks function).
--
-- Other members see the sex and level of everyone who posts availability, and
-- the name only of players whose account has "Show my name" on.

create table public.casual_slots (
  id         bigint generated always as identity primary key,
  player_id  bigint not null references public.players (id) on delete cascade,
  starts_at  timestamptz not null,
  minutes    int not null check (minutes in (60, 90, 120)),
  created_at timestamptz not null default now()
);
create index casual_slots_starts_at_idx on public.casual_slots (starts_at);

create table public.casual_prefs (
  account_email text primary key references public.accounts (email) on update cascade on delete cascade,
  show_name     boolean not null default false,
  notify        boolean not null default false,
  levels        text[] not null default '{}'
);

create table public.casual_alerts (
  id              bigint generated always as identity primary key,
  recipient_email text not null references public.accounts (email) on update cascade on delete cascade,
  slot_id         bigint not null references public.casual_slots (id) on delete cascade,
  created_at      timestamptz not null default now(),
  notified_at     timestamptz,
  unique (recipient_email, slot_id)
);

alter table public.casual_slots  enable row level security;
alter table public.casual_prefs  enable row level security;
alter table public.casual_alerts enable row level security;
-- Only through the functions below.
revoke all on public.casual_slots, public.casual_prefs, public.casual_alerts from anon, authenticated;

-- ---------- Helpers ----------

-- The level choices on the calendar: '2.5' (2.5 and below), '3.0', '3.5',
-- '4.0', '4.5', '5.0+'. Null when a player's level is missing or unreadable;
-- those players show up whatever levels are chosen.
create function public.casual_level(p_level text) returns text
language plpgsql immutable as $$
declare n numeric;
begin
  begin n := trim(p_level)::numeric; exception when others then return null; end;
  if n is null then return null; end if;
  if n >= 5 then return '5.0+'; end if;
  if n <= 2.5 then return '2.5'; end if;
  return to_char(round(n * 2) / 2, 'FM9.0');
end;
$$;

create function public.casual_levels() returns text[]
language sql immutable as $$ select array['2.5', '3.0', '3.5', '4.0', '4.5', '5.0+'] $$;

-- Today's date, US Eastern (follows the test clock).
create function public.casual_today() returns date
language sql stable security definer set search_path = public as $$
  select (app_now() at time zone 'America/New_York')::date;
$$;

-- The caller's settings, with defaults (their first player's level) if never saved.
create function public.casual_my_prefs() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('show_name', show_name, 'notify', notify, 'levels', to_jsonb(levels), 'saved', true)
       from casual_prefs where account_email = my_email()),
    jsonb_build_object('show_name', false, 'notify', false, 'saved', false, 'levels',
      to_jsonb(coalesce((select array[casual_level(level)] from players
                          where account_email = my_email() and active and casual_level(level) is not null
                          order by id limit 1), array['3.5']))));
$$;

-- ---------- What members see ----------

-- The 4 weeks from today: who is available when. Others' names only if
-- their account shows names. Times are US Eastern: day + start (minutes
-- after midnight).
create function public.casual_calendar() returns jsonb
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
               'level', casual_level(p.level),
               'sex', p.sex,
               'name', case when mine or coalesce(cp.show_name, false)
                            then p.first_name || ' ' || p.last_name end)
             order by s.starts_at)
        from casual_slots s
        join players p on p.id = s.player_id and p.active
        join accounts a on a.email = p.account_email and a.active
        left join casual_prefs cp on cp.account_email = p.account_email
        cross join lateral (select p.account_email = me as mine) m
       where s.starts_at + s.minutes * interval '1 minute' > now_
         and (s.starts_at at time zone 'America/New_York')::date < today_ + 28), '[]'::jsonb));
end;
$$;

create function public.casual_save_prefs(p_show_name boolean, p_notify boolean, p_levels text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me text := my_email();
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

-- Post availability: p_date and p_start are US Eastern, e.g. '2026-10-10', '09:30'.
create function public.casual_submit(p_player_id bigint, p_date date, p_start time, p_minutes int) returns bigint
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

  insert into casual_slots (player_id, starts_at, minutes) values (p_player_id, start_, p_minutes)
    returning id into v_id;

  -- "Casual Play match" emails: to other accounts that asked for them, that
  -- are available for at least an hour of this time, at a level they chose.
  insert into casual_alerts (recipient_email, slot_id)
  select distinct cp.account_email, v_id
    from casual_prefs cp
    join accounts a on a.email = cp.account_email and a.active and a.user_id is not null
    join players op on op.account_email = cp.account_email and op.active
    join casual_slots os on os.player_id = op.id
   where cp.notify
     and cp.account_email <> me
     and least(os.starts_at + os.minutes * interval '1 minute', end_) - greatest(os.starts_at, start_) >= interval '1 hour'
     and (casual_level((select level from players where id = p_player_id)) is null
          or casual_level((select level from players where id = p_player_id)) = any (cp.levels))
  on conflict do nothing;
  return v_id;
end;
$$;

create function public.casual_unsubmit(p_slot_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare me text := my_email();
begin
  if me is null then raise exception 'Not a member'; end if;
  delete from casual_slots s using players p
   where s.id = p_slot_id and p.id = s.player_id and p.account_email = me;
  if not found then raise exception 'That availability is not yours, or was already removed'; end if;
end;
$$;

-- ---------- Emails (called by the timed-tasks function only) ----------

-- Hands out the waiting "Casual Play match" emails, once each, grouped by
-- recipient. An alert is dropped if, by now, the recipient turned the emails
-- off, the time has started, or the two times no longer overlap by an hour.
create function public.claim_casual_alerts() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  now_ timestamptz := app_now();
  result jsonb;
begin
  with due as (
    update casual_alerts set notified_at = now_ where notified_at is null
    returning recipient_email, slot_id
  ), matches as (
    select d.recipient_email, s.starts_at, s.minutes, p.sex, casual_level(p.level) as level,
           case when coalesce(cp_them.show_name, false) then p.first_name || ' ' || p.last_name end as name,
           (select string_agg(distinct op.first_name, ' and ')
              from players op join casual_slots os on os.player_id = op.id
             where op.account_email = d.recipient_email and op.active
               and least(os.starts_at + os.minutes * interval '1 minute', s.starts_at + s.minutes * interval '1 minute')
                   - greatest(os.starts_at, s.starts_at) >= interval '1 hour') as first_names
      from due d
      join casual_slots s on s.id = d.slot_id
      join players p on p.id = s.player_id and p.active
      join casual_prefs cp_me on cp_me.account_email = d.recipient_email and cp_me.notify
      left join casual_prefs cp_them on cp_them.account_email = p.account_email
     where s.starts_at > now_
  )
  select jsonb_agg(jsonb_build_object('email', recipient_email, 'first_names', first_names, 'matches', ms))
    into result
    from (select recipient_email, min(first_names) as first_names,
                 jsonb_agg(jsonb_build_object('starts_at', starts_at, 'minutes', minutes, 'sex', sex,
                                              'level', level, 'name', name) order by starts_at) as ms
            from matches where first_names is not null
           group by recipient_email) g;
  return coalesce(result, '[]'::jsonb);
end;
$$;

revoke all on function public.casual_calendar(), public.casual_save_prefs(boolean, boolean, text[]),
  public.casual_submit(bigint, date, time, int), public.casual_unsubmit(bigint),
  public.casual_my_prefs(), public.casual_today(), public.claim_casual_alerts() from public, anon;
grant execute on function public.casual_calendar(), public.casual_save_prefs(boolean, boolean, text[]),
  public.casual_submit(bigint, date, time, int), public.casual_unsubmit(bigint) to authenticated;
revoke all on function public.claim_casual_alerts() from authenticated;
