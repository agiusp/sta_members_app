-- STAMA - STA Members App: new default name and color, a link to the club
-- website, and a News page that developers post to.

-- ---------- Branding defaults and club website ----------
alter table public.settings
  alter column program_name set default 'STAMA - STA Members App',
  alter column brand_color set default '#372a7b',
  add column website_url text not null default 'https://www.statennis.com/'
    check (website_url ~ '^https://[^\s"<>]+$' and char_length(website_url) <= 200);

-- Switch copies still on the old defaults to the new ones.
update settings set program_name = 'STAMA - STA Members App' where program_name = 'STA Sunday Program';
update settings set brand_color = '#372a7b' where brand_color = '#2b6cb0';

create or replace function public.branding() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('program_name', program_name, 'brand_color', brand_color,
                            'logo', logo_data_url, 'website_url', website_url)
    from settings;
$$;

-- p_website: null leaves the club website as it is.
drop function public.dev_save_branding(text, text, text);
create function public.dev_save_branding(p_name text, p_color text, p_logo text, p_website text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if p_name is null or char_length(trim(p_name)) not between 1 and 60 then
    raise exception 'The program name must be 1 to 60 characters';
  end if;
  if p_color is null or p_color !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'The color must look like #372a7b';
  end if;
  if p_logo is not null and p_logo !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' then
    raise exception 'The logo must be a PNG, JPEG or WebP image';
  end if;
  if char_length(p_logo) > 400000 then
    raise exception 'The logo is too large. Please use a smaller image';
  end if;
  if p_website is not null and (trim(p_website) !~ '^https://[^\s"<>]+$' or char_length(trim(p_website)) > 200) then
    raise exception 'The club website must start with https://';
  end if;
  update settings set program_name = trim(p_name), brand_color = lower(p_color), logo_data_url = p_logo,
                      website_url = coalesce(trim(p_website), website_url)
   where id;
  return branding();
end;
$$;

revoke all on function public.dev_save_branding(text, text, text, text) from public;
grant execute on function public.dev_save_branding(text, text, text, text) to authenticated;

-- ---------- News ----------
-- Short announcements on the News page. Members read them; developers post,
-- edit and delete them.
create table public.news (
  id          bigint generated always as identity primary key,
  title       text not null check (char_length(trim(title)) between 1 and 120),
  body        text not null check (char_length(body) between 1 and 5000),
  posted_by   text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
alter table public.news enable row level security;
-- Changes only go through dev_save_news / dev_delete_news.
revoke all on public.news from anon, authenticated;

-- Newest first. Members only (an active account).
create function public.news_posts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if my_email() is null then raise exception 'Not a member'; end if;
  return jsonb_build_object(
    'is_developer', is_developer(),
    'posts', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', id, 'title', title, 'body', body, 'posted_by', posted_by,
                 'created_at', created_at, 'updated_at', updated_at) order by created_at desc, id desc)
               from (select * from news order by created_at desc, id desc limit 100) n), '[]'::jsonb));
end;
$$;

-- p_id null adds a new post; otherwise edits that post.
create function public.dev_save_news(p_id bigint, p_title text, p_body text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform require_developer();
  if p_title is null or char_length(trim(p_title)) not between 1 and 120 then
    raise exception 'The title must be 1 to 120 characters';
  end if;
  if p_body is null or char_length(trim(p_body)) not between 1 and 5000 then
    raise exception 'The text must be 1 to 5000 characters';
  end if;
  if p_id is null then
    insert into news (title, body, posted_by) values (trim(p_title), trim(p_body), my_email())
      returning id into v_id;
  else
    update news set title = trim(p_title), body = trim(p_body), updated_at = now()
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'That post no longer exists'; end if;
  end if;
  return v_id;
end;
$$;

create function public.dev_delete_news(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  delete from news where id = p_id;
end;
$$;

revoke all on function public.news_posts(), public.dev_save_news(bigint, text, text),
  public.dev_delete_news(bigint) from public, anon;
grant execute on function public.news_posts(), public.dev_save_news(bigint, text, text),
  public.dev_delete_news(bigint) to authenticated;
