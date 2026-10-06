-- Demo mode, for the temporary online demo with made-up players only.
--
-- When settings.demo is on, emails are not sent: they are kept in demo_inbox,
-- and the Demo inbox page shows each person the emails they would have got
-- (developers see all of them). Every page also says it's a demo.
-- settings.demo can only be changed in the database itself; it stays off
-- everywhere except the demo.

alter table public.settings add column demo boolean not null default false;

create table public.demo_inbox (
  id         bigint generated always as identity primary key,
  to_email   text not null,
  subject    text not null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index demo_inbox_to_idx on public.demo_inbox (to_email, created_at desc);
alter table public.demo_inbox enable row level security;
revoke all on public.demo_inbox from anon, authenticated;

-- Newest first: your own emails, or everyone's for developers.
create function public.demo_inbox() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me  text := my_email();
  dev boolean := is_developer();
begin
  if me is null then raise exception 'Not a member'; end if;
  if not (select demo from settings) then raise exception 'Only in the demo'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
             'id', id, 'to', to_email, 'subject', subject, 'body', body, 'at', created_at)
             order by created_at desc, id desc)
           from (select * from demo_inbox where dev or to_email = me
                  order by created_at desc, id desc limit 300) d), '[]'::jsonb);
end;
$$;
revoke all on function public.demo_inbox() from public, anon;
grant execute on function public.demo_inbox() to authenticated;

create or replace function public.branding() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('program_name', program_name, 'brand_color', brand_color,
                            'logo', logo_data_url, 'website_url', website_url, 'demo', demo)
    from settings;
$$;
