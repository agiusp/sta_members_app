-- Copy Dynamic Level into Level (Developers > Settings > App settings), best
-- done at the end of a season or before the next one starts.
--
-- Ratings are worked out by replaying every counted result from each
-- player's starting level. Until now that was always their Level, so copying
-- Dynamic Level into Level would count their old results a second time. Now
-- the starting level is kept on its own (players.rating_start) when levels
-- are copied, so ratings don't move. Changing a Level by hand (or by
-- uploading the member list) still restarts that player's rating from it.

alter table public.players add column rating_start text;
alter table public.settings add column levels_copied_at timestamptz;

-- Where a player's rating starts: their Level, or their Level from before
-- Dynamic Level was copied into it.
create function public.players_rating_start() returns trigger
language plpgsql as $$
begin
  if new.level is distinct from old.level then
    new.rating_start := case when current_setting('sta.copying_levels', true) = 'on'
                             then coalesce(old.rating_start, old.level) end;
  end if;
  return new;
end;
$$;
create trigger players_rating_start before update of level on public.players
  for each row execute function public.players_rating_start();

-- rating_replay and rating_dynamic_levels start from it.
do $$
declare
  f text;
begin
  f := pg_get_functiondef('public.rating_replay'::regproc);
  if position('select rating_level(level) into lvl from players where id = p;' in f) = 0 then
    raise exception 'rating_replay changed; update this migration';
  end if;
  execute replace(f, 'select rating_level(level) into lvl from players where id = p;',
                     'select rating_level(coalesce(rating_start, level)) into lvl from players where id = p;');
  f := pg_get_functiondef('public.rating_dynamic_levels'::regproc);
  if (length(f) - length(replace(f, 'rating_level(p.level)', ''))) / length('rating_level(p.level)') <> 2 then
    raise exception 'rating_dynamic_levels changed; update this migration';
  end if;
  execute replace(f, 'rating_level(p.level)', 'rating_level(coalesce(p.rating_start, p.level))');
end $$;

-- 'start_level': the level the rating started from (shown on My Rating).
create or replace function public.rating_summary(p_player bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  pl   players;
  lvl  numeric;
  hist jsonb;
  last jsonb;
begin
  select * into pl from players where id = p_player;
  lvl := rating_level(coalesce(pl.rating_start, pl.level));
  hist := rating_history(p_player);
  select h into last from jsonb_array_elements(hist) h where (h ->> 'rated')::boolean
   order by (h ->> 'played_before')::int desc limit 1;
  return jsonb_build_object(
    'player', case when pl.id is null then null else jsonb_build_object(
                'id', pl.id, 'name', pl.first_name || ' ' || pl.last_name, 'level', pl.level,
                'start_level', coalesce(pl.rating_start, pl.level),
                'start', lvl, 'start_official', rating_nearest(lvl)) end,
    'rating', coalesce((last ->> 'rating_after')::numeric, lvl),
    'official', coalesce((last ->> 'official_after')::numeric, rating_nearest(lvl)),
    'played', coalesce((last ->> 'played_before')::int + 1, 0),
    'history', hist);
end;
$$;

-- Members whose Level differs from their Dynamic Level; with p_apply, copies
-- Dynamic Level into Level for all of them.
create function public.dev_copy_dynamic_levels(p_apply boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  changes jsonb;
begin
  perform require_developer();
  with dyn as (select rating_dynamic_levels() d)
  select coalesce(jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.first_name || ' ' || p.last_name,
                                               'level', p.level, 'dynamic_level', dyn.d ->> p.id::text)
                            order by lower(p.last_name), lower(p.first_name)), '[]'::jsonb)
    into changes
    from players p, dyn
   where p.active and dyn.d ? p.id::text and (dyn.d ->> p.id::text) is distinct from p.level;
  if p_apply then
    perform set_config('sta.copying_levels', 'on', true);
    update players p set level = c ->> 'dynamic_level'
      from jsonb_array_elements(changes) c where p.id = (c ->> 'player_id')::bigint;
    perform set_config('sta.copying_levels', 'off', true);
    update settings set levels_copied_at = now() where id;
  end if;
  return jsonb_build_object('changes', changes, 'copied_at', (select levels_copied_at from settings));
end;
$$;

revoke all on function public.players_rating_start() from anon, authenticated, public;
revoke all on function public.dev_copy_dynamic_levels(boolean) from anon, public;
grant execute on function public.dev_copy_dynamic_levels(boolean) to authenticated;
