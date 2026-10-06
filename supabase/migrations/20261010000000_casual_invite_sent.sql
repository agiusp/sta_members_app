-- Casual Play: a match counts as "invited" only once the invitations have
-- actually gone out by email, not when they are queued. Before that, a
-- player who takes back their time dissolves the match (and its waiting
-- emails), so no one is sent an invitation to a match missing a player.

comment on column public.casual_matches.invited_at is 'when the invitations were sent';
update casual_matches m set invited_at = null
 where not exists (select 1 from casual_outbox o where o.match_id = m.id and o.kind = 'invite' and o.sent_at is not null);

create or replace function public.casual_queue_emails(p_match_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from casual_outbox where match_id = p_match_id and kind = 'invite') then return; end if;
  if (select bool_and(casual_slot_shown(slot_id)) from casual_match_players where match_id = p_match_id) then
    insert into casual_outbox (match_id, slot_id, kind)
    select p_match_id, slot_id, 'invite' from casual_match_players where match_id = p_match_id;
  else
    insert into casual_outbox (match_id, slot_id, kind)
    select p_match_id, slot_id, 'reveal' from casual_match_players
     where match_id = p_match_id and reveal_asked_at is null and not casual_slot_shown(slot_id);
    update casual_match_players set reveal_asked_at = app_now()
     where match_id = p_match_id and reveal_asked_at is null and not casual_slot_shown(slot_id);
  end if;
end;
$$;

-- Hands out waiting match emails, once each. Skipped if the time has started,
-- or if no other player is left in the match.
create or replace function public.claim_casual_emails() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  now_ timestamptz := app_now();
  result jsonb;
begin
  with due as (
    update casual_outbox set sent_at = now_ where sent_at is null
    returning match_id, slot_id, kind
  ), invited as (
    update casual_matches set invited_at = now_
     where invited_at is null and id in (select match_id from due where kind = 'invite')
  ), rows as (
    select d.*, m.kind as match_kind, m.starts_at, m.ends_at, p.account_email, p.first_name,
           (select jsonb_agg(jsonb_build_object(
                     'name', case when casual_slot_shown(o.slot_id) then op.first_name || ' ' || op.last_name end,
                     -- email addresses only in invitations, and only of players showing their name
                     'email', case when d.kind = 'invite' and casual_slot_shown(o.slot_id) then op.account_email end,
                     'level', casual_level(op.level), 'sex', op.sex)
                   order by os.created_at)
              from casual_match_players o
              join casual_slots os on os.id = o.slot_id
              join players op on op.id = os.player_id
             where o.match_id = m.id and o.slot_id <> d.slot_id) as others
      from due d
      join casual_matches m on m.id = d.match_id
      join casual_slots s on s.id = d.slot_id
      join players p on p.id = s.player_id and p.active
      join casual_prefs cp on cp.account_email = p.account_email and cp.notify
     where m.starts_at > now_
  )
  select jsonb_agg(jsonb_build_object(
           'kind', r.kind, 'email', r.account_email, 'first_name', r.first_name, 'slot_id', r.slot_id,
           'match_kind', r.match_kind, 'starts_at', r.starts_at, 'ends_at', r.ends_at, 'others', r.others)
         order by r.match_id, r.slot_id)
    into result
    from rows r
   where r.others is not null;
  return coalesce(result, '[]'::jsonb);
end;
$$;

revoke all on function public.casual_queue_emails(bigint), public.claim_casual_emails() from public, anon, authenticated;
