-- Branding, so each club's copy of the app can have its own look:
-- program name, brand color and logo (Developer area > Emails, schedule and
-- settings). The name also fills {{program_name}} in emails.
--
-- The logo is stored in the database as a small image (data URL), so no file
-- storage service is needed. PNG, JPEG or WebP only: SVG can carry scripts.

alter table public.settings
  add column program_name  text not null default 'STA Sunday Program'
    check (char_length(trim(program_name)) between 1 and 60),
  add column brand_color   text not null default '#2b6cb0'
    check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  add column logo_data_url text
    check (logo_data_url is null
           or (logo_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'
               and char_length(logo_data_url) <= 400000));

-- Public: every page (including the sign-in page, before anyone signs in)
-- shows the name, color and logo. Nothing personal.
create function public.branding() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('program_name', program_name, 'brand_color', brand_color,
                            'logo', logo_data_url)
    from settings;
$$;

-- p_logo: a data URL, or null to remove the logo.
create function public.dev_save_branding(p_name text, p_color text, p_logo text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform require_developer();
  if p_name is null or char_length(trim(p_name)) not between 1 and 60 then
    raise exception 'The program name must be 1 to 60 characters';
  end if;
  if p_color is null or p_color !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'The color must look like #2b6cb0';
  end if;
  if p_logo is not null and p_logo !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' then
    raise exception 'The logo must be a PNG, JPEG or WebP image';
  end if;
  if char_length(p_logo) > 400000 then
    raise exception 'The logo is too large. Please use a smaller image';
  end if;
  update settings set program_name = trim(p_name), brand_color = lower(p_color), logo_data_url = p_logo
   where id;
  return branding();
end;
$$;

revoke all on function public.branding(), public.dev_save_branding(text, text, text) from public;
grant execute on function public.branding() to anon, authenticated;
grant execute on function public.dev_save_branding(text, text, text) to authenticated;
