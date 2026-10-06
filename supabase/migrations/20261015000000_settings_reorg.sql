-- Settings reorganized (Developers > Settings): an On/Off switch for every
-- email, and a waiting time before Casual Play emails go out.

-- ---------- Email On/Off switches ----------
-- One row per email that has been switched; no row means On. The timed-tasks
-- function skips emails that are Off. The setup-invite can't be switched off
-- (it's how members join the app).
create table public.email_switches (
  key        text primary key check (key <> 'setup_invite'),
  enabled    boolean not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.email_switches enable row level security;
revoke all on public.email_switches from anon, authenticated;

create function public.dev_set_email_switch(p_key text, p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if p_key is null or p_key !~ '^[a-z0-9_]+$' or p_key = 'setup_invite' then
    raise exception 'That email can''t be switched off';
  end if;
  insert into email_switches (key, enabled, updated_by) values (p_key, coalesce(p_enabled, true), my_email())
  on conflict (key) do update set enabled = excluded.enabled, updated_at = now(), updated_by = excluded.updated_by;
end;
$$;

create function public.dev_email_switches() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_developer();
  return coalesce((select jsonb_object_agg(key, enabled) from email_switches), '{}'::jsonb);
end;
$$;
revoke all on function public.dev_set_email_switch(text, boolean), public.dev_email_switches() from public, anon;
grant execute on function public.dev_set_email_switch(text, boolean), public.dev_email_switches() to authenticated;

-- The schedule's own On/Off switches move to the emails they controlled.
insert into email_switches (key, enabled)
select e.key, false
  from schedule s
  join (values ('play_invite', 'play_invite'), ('moved_off_waitlist', 'moved_off_waitlist'),
               ('dev_scheduler_open', 'dev_scheduler_open'), ('dev_reminder_1', 'dev_reminder_1'),
               ('dev_reminder_2', 'dev_reminder_2'), ('dev_locked_summary', 'dev_courts_locked'),
               ('dev_locked_summary', 'dev_weather_locked')) e (sched, key) on e.sched = s.key
 where not s.enabled
on conflict (key) do nothing;
update schedule set enabled = true where not enabled;

-- ---------- Casual Play: wait before emailing ----------
-- A posted time must stay up this long before anyone is emailed about it, so
-- a time posted by mistake can be taken back first.
alter table public.settings
  add column casual_email_delay_minutes int not null default 120 check (casual_email_delay_minutes between 0 and 1440);

-- Posted times are stamped with the app's clock (the test clock in test mode).
alter table public.casual_slots alter column created_at set default app_now();

do $$
declare f text;
begin
  select pg_get_functiondef('public.claim_casual_emails()'::regprocedure) into f;
  if position('join casual_slots o on o.id = pr.other_id' in f) = 0 then
    raise exception 'claim_casual_emails changed; update this migration';
  end if;
  execute replace(f, 'join casual_slots o on o.id = pr.other_id',
    'join casual_slots o on o.id = pr.other_id
                and o.created_at <= now_ - (select casual_email_delay_minutes from settings) * interval ''1 minute''
      join casual_slots ms on ms.id = pr.slot_id
                and ms.created_at <= now_ - (select casual_email_delay_minutes from settings) * interval ''1 minute''');
end $$;

create function public.dev_casual_settings() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_developer();
  return jsonb_build_object('email_delay_minutes', (select casual_email_delay_minutes from settings));
end;
$$;

create function public.dev_save_casual_settings(p_email_delay_minutes int) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if p_email_delay_minutes is null or p_email_delay_minutes not between 0 and 1440 then
    raise exception 'Choose a waiting time between 0 minutes and 24 hours';
  end if;
  update settings set casual_email_delay_minutes = p_email_delay_minutes where id;
  return dev_casual_settings();
end;
$$;
revoke all on function public.dev_casual_settings(), public.dev_save_casual_settings(int) from public, anon;
grant execute on function public.dev_casual_settings(), public.dev_save_casual_settings(int) to authenticated;
