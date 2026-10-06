-- The app name shows as "STA" (with "STA Members App" under it), and
-- developers can upload the list of current members.

alter table public.settings alter column program_name set default 'STA - STA Members App';
update settings set program_name = 'STA - STA Members App' where program_name = 'STAMA - STA Members App';

-- Developers > Members and this week > Upload current members. The page
-- matches the uploaded list to accounts (by email or player name) and shows
-- what will change; this then marks those accounts current and every other
-- account lapsed, in one step. Removed accounts are left as they are.
create function public.dev_set_current_members(p_current_emails text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  list text[];
begin
  perform require_developer();
  select coalesce(array_agg(distinct lower(trim(e))), '{}') into list
    from unnest(p_current_emails) e where trim(coalesce(e, '')) <> '';
  -- An empty list would mark every member lapsed: almost certainly a mistake.
  if cardinality(list) = 0 then
    raise exception 'None of the uploaded members match anyone in the app, so nothing was changed';
  end if;
  update accounts set membership_current = (email = any (list))
   where active and membership_current is distinct from (email = any (list));
  return jsonb_build_object(
    'current', (select count(*) from accounts where active and membership_current),
    'lapsed',  (select count(*) from accounts where active and not membership_current));
end;
$$;

revoke all on function public.dev_set_current_members(text[]) from public, anon;
grant execute on function public.dev_set_current_members(text[]) to authenticated;
