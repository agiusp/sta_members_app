-- App Messages (Developers > Settings > App Messages): developers can change
-- the wording of the messages the app shows members on its pages. Only edits
-- are stored; the default wording is in app/common.js (MESSAGES).

create table public.app_messages (
  key        text primary key check (key ~ '^[a-z0-9_]+$'),
  text       text not null check (char_length(trim(text)) between 1 and 2000),
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.app_messages enable row level security;
revoke all on public.app_messages from anon, authenticated;

-- Everyone, signed in or not (the sign-in page has messages too). Nothing
-- private: this is the wording shown on the app's pages.
create function public.app_messages() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(key, text), '{}'::jsonb) from app_messages;
$$;
revoke all on function public.app_messages() from public;
grant execute on function public.app_messages() to anon, authenticated;

-- p_text null or blank: back to the default wording.
create function public.dev_save_app_message(p_key text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if p_key is null or p_key !~ '^[a-z0-9_]+$' then raise exception 'Unknown message'; end if;
  if trim(coalesce(p_text, '')) = '' then
    delete from app_messages where key = p_key;
  elsif char_length(p_text) > 2000 then
    raise exception 'Keep the message under 2000 characters';
  else
    insert into app_messages (key, text, updated_by) values (p_key, trim(p_text), my_email())
    on conflict (key) do update set text = excluded.text, updated_at = now(), updated_by = excluded.updated_by;
  end if;
  return app_messages();
end;
$$;
revoke all on function public.dev_save_app_message(text, text) from public, anon;
grant execute on function public.dev_save_app_message(text, text) to authenticated;

-- The message for Inactive members moves here; keep any wording a developer
-- already wrote.
insert into app_messages (key, text)
select 'inactive', dues_message from settings
 where dues_message <> 'Our records show that your STA membership has not been renewed for this year. Please pay your membership dues, and your access to the STA Members App will be restored.';
