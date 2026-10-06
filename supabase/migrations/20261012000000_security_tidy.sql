-- Security tidy-ups before going live.
--
-- 1. Sessions, seasons and settings are readable by developers only (members
--    could see which developer locked the courts, and the contact emails and
--    test clock). Members get what they need through the app's functions.
-- 2. Helper functions that were callable by anyone are locked down.
-- 3. News posts show the poster's email address to developers only.
-- 4. Casual Play: re-posting a time no longer re-sends "new player" emails to
--    the players it lines up with (they are told once per player, not per
--    posted time), and a player can have at most 40 upcoming times. This
--    stops one member from flooding others with emails.
-- 5. Two-step sign-in for developers: developer powers need a sign-in
--    confirmed with a code from an authenticator app (Supabase "aal2").
--    settings.dev_two_step can only be changed in the database itself (the
--    automated tests switch it off); online it must stay on.

-- ---------- 1. Developer-only tables ----------
drop policy sessions_read on public.sessions;
create policy sessions_read on public.sessions for select to authenticated using (is_developer());
drop policy seasons_read on public.seasons;
create policy seasons_read on public.seasons for select to authenticated using (is_developer());
drop policy settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (is_developer());

-- ---------- 2. Helper functions ----------
revoke all on function public.late_lock_until(date) from public, anon, authenticated;
revoke all on function public.keep_a_developer() from public, anon, authenticated;
revoke all on function public.dev_save_branding(text, text, text, text) from public, anon;
grant execute on function public.dev_save_branding(text, text, text, text) to authenticated;

-- ---------- 3. News ----------
create or replace function public.news_posts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare dev boolean := is_developer();
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  return jsonb_build_object(
    'is_developer', dev,
    'posts', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', id, 'title', title, 'body', body, 'posted_by', case when dev then posted_by end,
                 'created_at', created_at, 'updated_at', updated_at) order by created_at desc, id desc)
               from (select * from news order by created_at desc, id desc limit 100) n), '[]'::jsonb));
end;
$$;

-- ---------- 4. Casual Play ----------
drop table public.casual_told;
-- slot_id's player has been emailed about other_player_id (with_contacts:
-- with name and email address, not just "show your name").
create table public.casual_told (
  slot_id         bigint not null references public.casual_slots (id) on delete cascade,
  other_player_id bigint not null references public.players (id) on delete cascade,
  with_contacts   boolean not null,
  told_at         timestamptz not null,
  primary key (slot_id, other_player_id)
);
alter table public.casual_told enable row level security;
revoke all on public.casual_told from anon, authenticated;

create or replace function public.claim_casual_emails() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  now_ timestamptz := app_now();
  result jsonb;
begin
  create temporary table casual_due on commit drop as
  with pr as (
    select pr.*, casual_slot_shown(pr.slot_id) as me_shown, casual_slot_shown(pr.other_id) as o_shown,
           o.player_id as other_player,
           t.slot_id is not null as told, coalesce(t.with_contacts, false) as told_contacts
      from casual_pairs() pr
      join casual_slots o on o.id = pr.other_id
      left join casual_told t on t.slot_id = pr.slot_id and t.other_player_id = o.player_id)
  select pr.*, case when me_shown then not told_contacts else not told end as is_new,
         count(*) filter (where me_shown and not o_shown) over (partition by pr.slot_id) as hidden_count
    from pr;
  -- Shown: only players who show their name are listed. Hidden: everyone.
  delete from casual_due where me_shown and not o_shown;
  delete from casual_due d where not exists (select 1 from casual_due n where n.slot_id = d.slot_id and n.is_new);

  insert into casual_told (slot_id, other_player_id, with_contacts, told_at)
  select distinct on (slot_id, other_player) slot_id, other_player, me_shown, now_ from casual_due
   order by slot_id, other_player
  on conflict (slot_id, other_player_id) do update
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

revoke all on function public.claim_casual_emails() from public, anon, authenticated;

create function public.casual_slot_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from casual_slots
       where player_id = new.player_id and starts_at + minutes * interval '1 minute' > app_now()) >= 40 then
    raise exception 'You already have 40 upcoming times posted. Unsubmit some first';
  end if;
  return new;
end;
$$;
revoke all on function public.casual_slot_limit() from public, anon, authenticated;
create trigger casual_slot_limit before insert on public.casual_slots
  for each row execute function public.casual_slot_limit();

-- ---------- 5. Two-step sign-in for developers ----------
alter table public.settings add column dev_two_step boolean not null default true;

create or replace function public.is_developer() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select a.is_developer
            and (not s.dev_two_step or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
       from accounts a cross join settings s
      where a.user_id = auth.uid() and a.active),
    false);
$$;

-- For the pages: whether this account is a developer, and whether this
-- sign-in has been confirmed with a code (so developer pages can ask for it).
create function public.my_developer() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'developer', coalesce((select is_developer from accounts where user_id = auth.uid() and active), false),
    'confirmed', is_developer());
$$;
revoke all on function public.my_developer() from public, anon;
grant execute on function public.my_developer() to authenticated;
