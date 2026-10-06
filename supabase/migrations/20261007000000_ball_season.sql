-- The season of the upcoming Sunday, so the Scheduler can count how many
-- times each player brought balls this season (Modify bring-ball assignments).
create function public.dev_current_season() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_developer();
  return (select jsonb_build_object('name', se.name, 'start_date', se.start_date, 'end_date', se.end_date)
            from sessions s join seasons se on se.id = s.season_id
           where s.id = current_session_id());
end;
$$;

revoke all on function public.dev_current_season() from public, anon;
grant execute on function public.dev_current_season() to authenticated;
