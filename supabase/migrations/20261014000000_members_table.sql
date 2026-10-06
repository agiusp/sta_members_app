-- The Members Table, and who may use what.
--
-- One row per person, each with their own email address (one sign-in each;
-- no more family members sharing an email). Developers add and edit members
-- in the app: name, email, level, sex, Membership (Active/Inactive), Sunday
-- Doubles (Yes/No) and Developer. App Access is filled in by the app: Yes once
-- the member has accepted the invitation; otherwise "Pending STA Member App
-- Invitation" (Send Invite not clicked yet) or "Invited".
--
-- Inactive members can sign in but see only the dues message: every member
-- function treats them as not a member. Marking them Active again restores
-- their access. Sunday Doubles (sign-up, courts, game review and its emails)
-- is only for Active members approved for it (Sunday Doubles = Yes).

-- ---------- Sunday Doubles approval ----------
alter table public.players add column sunday_doubles boolean not null default false;
-- Everyone already in the app came from the Sunday Doubles program.
update players set sunday_doubles = true;

-- ---------- One email per person ----------
-- Split any family members sharing an email. Only made-up @example.com test
-- data can be split automatically; anything else needs a real email first.
do $$
declare p record;
begin
  for p in select pl.* from players pl
            where pl.active and exists (select 1 from players o where o.account_email = pl.account_email
                                         and o.active and o.id < pl.id) loop
    if p.account_email not like '%@example.com' then
      raise exception 'Players % % and others share the email %. Give each their own email first.',
        p.first_name, p.last_name, p.account_email;
    end if;
    insert into accounts (email, membership_current)
    select lower(p.first_name || '.' || p.last_name || '@example.com'), membership_current
      from accounts where email = p.account_email
    on conflict (email) do nothing;
    update players set account_email = lower(p.first_name || '.' || p.last_name || '@example.com') where id = p.id;
  end loop;
end $$;
create unique index players_one_per_email on public.players (account_email) where active;

-- ---------- Who counts as a member ----------
-- Inactive (or removed) members are not members: every member function
-- refuses them, and they see the dues message.
create or replace function public.my_email() returns text
language sql stable security definer set search_path = public as $$
  select email from accounts where user_id = auth.uid() and active and membership_current;
$$;

-- Members approved for Sunday Doubles.
create function public.my_sd_email() returns text
language sql stable security definer set search_path = public as $$
  select a.email from accounts a
   where a.user_id = auth.uid() and a.active and a.membership_current
     and exists (select 1 from players p where p.account_email = a.email and p.active and p.sunday_doubles);
$$;
revoke all on function public.my_sd_email() from public, anon, authenticated;

-- Developers must be Active members too.
create or replace function public.is_developer() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select a.is_developer and a.membership_current
            and (not s.dev_two_step or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
       from accounts a cross join settings s
      where a.user_id = auth.uid() and a.active),
    false);
$$;

create or replace function public.keep_a_developer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from accounts where is_developer and active and membership_current) then
    raise exception 'There must be at least one Active developer. Make someone else a developer first';
  end if;
  return null;
end;
$$;

-- Sunday Doubles functions use my_sd_email() instead of my_email(), so
-- members not approved for Sunday Doubles can't see or do anything there.
do $$
declare f text;
begin
  for f in select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('my_week', 'sign_up', 'cancel_signup', 'my_courts', 'my_review', 'submit_review') loop
    execute replace(f, 'my_email()', 'my_sd_email()');
  end loop;
end $$;

-- The Monday play-invite goes only to members approved for Sunday Doubles,
-- and test sign-ups are only for them.
do $$
declare f text;
begin
  select pg_get_functiondef('public.claim_due_tasks()'::regprocedure) into f;
  if position('where a.active and a.membership_current and u.email_confirmed_at is not null' in f) = 0 then
    raise exception 'claim_due_tasks changed; update this migration';
  end if;
  execute replace(f, 'where a.active and a.membership_current and u.email_confirmed_at is not null',
    'where a.active and a.membership_current and u.email_confirmed_at is not null
           and exists (select 1 from players sp where sp.account_email = a.email and sp.active and sp.sunday_doubles)');

  select pg_get_functiondef('public.dev_simulate_signups(int)'::regprocedure) into f;
  execute replace(f, 'where pl.active
', 'where pl.active and pl.sunday_doubles
');

  -- Casual Play: only Active members' times show and line up.
  select pg_get_functiondef('public.casual_calendar()'::regprocedure) into f;
  execute replace(f, 'join accounts a on a.email = p.account_email and a.active',
                     'join accounts a on a.email = p.account_email and a.active and a.membership_current');
  select pg_get_functiondef('public.casual_pairs()'::regprocedure) into f;
  execute replace(f, 'join accounts a on a.email = p.account_email and a.active',
                     'join accounts a on a.email = p.account_email and a.active and a.membership_current');
end $$;

-- ---------- What the pages need to know ----------
-- For every page: whether this sign-in may use the app, Sunday Doubles, and
-- the Developers pages (and whether this sign-in still needs its code).
create function public.my_access() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'member', my_email() is not null,
    'sunday_doubles', my_sd_email() is not null,
    'developer', coalesce((select is_developer and membership_current from accounts
                            where user_id = auth.uid() and active), false),
    'confirmed', is_developer(),
    'dues_message', (select dues_message from settings));
$$;
revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated;

create or replace function public.my_developer() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'developer', coalesce((select is_developer and membership_current from accounts
                            where user_id = auth.uid() and active), false),
    'confirmed', is_developer());
$$;

-- ---------- The Members Table (developers) ----------
-- app_access: 'yes' (accepted the invitation), 'invited' (waiting for them to
-- accept) or 'pending' (Send Invite not clicked yet).
drop function public.dev_members();
create function public.dev_members() returns table (
  player_id bigint, first_name text, last_name text, email text, level text, sex text,
  membership text, sunday_doubles boolean, is_developer boolean, app_access text, invited_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_developer();
  return query
  select p.id, p.first_name, p.last_name, a.email, p.level, p.sex,
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
revoke all on function public.dev_members() from public, anon;
grant execute on function public.dev_members() to authenticated;

-- Adds a member (p_player_id null) or changes one. Returns the player id.
-- A new member's App Access is "Pending STA Member App Invitation" until a
-- developer clicks Send Invite. The email can only change before the member
-- has accepted the invitation (an unaccepted invitation is cancelled).
create function public.dev_save_member(p_player_id bigint, p_first_name text, p_last_name text, p_email text,
                                       p_level text, p_sex text, p_active boolean, p_sunday_doubles boolean,
                                       p_developer boolean) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  email_ text := lower(trim(coalesce(p_email, '')));
  level_ text := nullif(trim(coalesce(p_level, '')), '');
  sex_   text := nullif(upper(trim(coalesce(p_sex, ''))), '');
  pl     players;
  acc    accounts;
  owner  text;
begin
  perform require_developer();
  if trim(coalesce(p_first_name, '')) = '' or trim(coalesce(p_last_name, '')) = '' then
    raise exception 'Enter a first and last name';
  end if;
  if email_ !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address'; end if;
  if level_ is not null and level_ !~ '^[1-7]\.[05]$' then raise exception 'Level must look like 3.5'; end if;
  if sex_ is not null and sex_ not in ('M', 'F') then raise exception 'Sex must be M or F'; end if;
  if p_active is null or p_sunday_doubles is null or p_developer is null then
    raise exception 'Choose Membership, Sunday Doubles and Developer';
  end if;

  if p_player_id is null then
    select first_name || ' ' || last_name into owner from players where account_email = email_ and active;
    if owner is not null or exists (select 1 from accounts where email = email_) then
      raise exception 'That email already belongs to %', coalesce(owner, 'another member');
    end if;
    insert into accounts (email, is_developer, active, membership_current)
    values (email_, p_developer, true, p_active);
    insert into players (account_email, first_name, last_name, level, sex, sunday_doubles)
    values (email_, trim(p_first_name), trim(p_last_name), level_, sex_, p_sunday_doubles)
    returning * into pl;
    return pl.id;
  end if;

  select * into pl from players where id = p_player_id and active;
  if not found then raise exception 'That member no longer exists'; end if;
  select * into acc from accounts where email = pl.account_email;
  if email_ <> acc.email then
    select first_name || ' ' || last_name into owner from players where account_email = email_ and active;
    if owner is not null or exists (select 1 from accounts where email = email_) then
      raise exception 'That email already belongs to %', coalesce(owner, 'another member');
    end if;
    if exists (select 1 from auth.users where id = acc.user_id and email_confirmed_at is not null) then
      raise exception 'This member has already joined the app, so their email can''t be changed here';
    end if;
    -- Cancel an invitation that wasn't accepted; it went to the old address.
    update accounts set user_id = null where email = acc.email;
    begin
      delete from auth.users where id = acc.user_id;
    exception when insufficient_privilege then null;   -- unlinked anyway: it can't reach this member
    end;
    update accounts set email = email_ where email = acc.email;
  end if;
  update accounts set is_developer = p_developer, active = true, membership_current = p_active where email = email_;
  update players set first_name = trim(p_first_name), last_name = trim(p_last_name), level = level_, sex = sex_,
                     sunday_doubles = p_sunday_doubles
   where id = pl.id;
  return pl.id;
end;
$$;
revoke all on function public.dev_save_member(bigint, text, text, text, text, text, boolean, boolean, boolean) from public, anon;
grant execute on function public.dev_save_member(bigint, text, text, text, text, text, boolean, boolean, boolean) to authenticated;

-- The dues message now covers the whole app, not just signing up.
alter table public.settings alter column dues_message set default
  'Our records show that your STA membership has not been renewed for this year. Please pay your membership dues, and your access to the STA Members App will be restored.';
update settings set dues_message =
  'Our records show that your STA membership has not been renewed for this year. Please pay your membership dues, and your access to the STA Members App will be restored.'
 where dues_message = 'Our records show that your STA membership has not been renewed for this year. Please pay your membership dues first, and then you''ll be able to sign up.';
