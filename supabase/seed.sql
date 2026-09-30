-- Local test data only: fictitious players from sample_data.csv. Never put real
-- member data in this file (the repo is public).

update public.settings set test_mode = true,
  contact_emails = '{organizers@example.com,helper@example.com}';

insert into public.seasons (name, start_date) values ('2026', '2026-05-03');

insert into public.accounts (email, is_developer) values
  ('dev@example.com', true),
  ('alice.johnson@example.com', false),
  ('bob.smith@example.com', false),
  ('carol.lee@example.com', false),
  ('david.kim@example.com', false),
  ('emma.brown@example.com', false),
  ('frank.davis@example.com', false),
  ('grace.wilson@example.com', false),
  ('henry.moore@example.com', false),
  ('ivy.taylor@example.com', false),
  ('jack.anderson@example.com', false),
  ('karen.thomas@example.com', false),
  ('leo.martinez@example.com', false),
  ('mia.garcia@example.com', false),
  ('noah.robinson@example.com', false),
  ('olivia.clark@example.com', false),
  ('paul.rodriguez@example.com', false),
  ('quinn.lewis@example.com', false),
  ('ryan.walker@example.com', false),
  ('sara.hall@example.com', false),
  ('tom.allen@example.com', false),
  ('uma.young@example.com', false),
  ('victor.king@example.com', false),
  ('wendy.wright@example.com', false),
  ('xavier.scott@example.com', false),
  ('yara.green@example.com', false);

-- Zack Baker shares Yara Green's account, to test linked family members.
insert into public.players (account_email, first_name, last_name, level, sex) values
  ('dev@example.com', 'Dana', 'Developer', '3.5', 'F'),
  ('alice.johnson@example.com', 'Alice', 'Johnson', '3.5', 'F'),
  ('bob.smith@example.com', 'Bob', 'Smith', '3.5', 'M'),
  ('carol.lee@example.com', 'Carol', 'Lee', '4.0', 'F'),
  ('david.kim@example.com', 'David', 'Kim', '4.0', 'M'),
  ('emma.brown@example.com', 'Emma', 'Brown', '3.0', 'F'),
  ('frank.davis@example.com', 'Frank', 'Davis', '3.0', 'M'),
  ('grace.wilson@example.com', 'Grace', 'Wilson', '3.5', 'F'),
  ('henry.moore@example.com', 'Henry', 'Moore', '3.5', 'M'),
  ('ivy.taylor@example.com', 'Ivy', 'Taylor', '4.0', 'F'),
  ('jack.anderson@example.com', 'Jack', 'Anderson', '4.0', 'M'),
  ('karen.thomas@example.com', 'Karen', 'Thomas', '3.0', 'F'),
  ('leo.martinez@example.com', 'Leo', 'Martinez', '3.0', 'M'),
  ('mia.garcia@example.com', 'Mia', 'Garcia', '3.5', 'F'),
  ('noah.robinson@example.com', 'Noah', 'Robinson', '3.5', 'M'),
  ('olivia.clark@example.com', 'Olivia', 'Clark', '4.5', 'F'),
  ('paul.rodriguez@example.com', 'Paul', 'Rodriguez', '4.5', 'M'),
  ('quinn.lewis@example.com', 'Quinn', 'Lewis', '4.0', 'F'),
  ('ryan.walker@example.com', 'Ryan', 'Walker', '4.0', 'M'),
  ('sara.hall@example.com', 'Sara', 'Hall', '3.0', 'F'),
  ('tom.allen@example.com', 'Tom', 'Allen', '3.0', 'M'),
  ('uma.young@example.com', 'Uma', 'Young', '3.5', 'F'),
  ('victor.king@example.com', 'Victor', 'King', '3.5', 'M'),
  ('wendy.wright@example.com', 'Wendy', 'Wright', '4.5', 'F'),
  ('xavier.scott@example.com', 'Xavier', 'Scott', '4.5', 'M'),
  ('yara.green@example.com', 'Yara', 'Green', '4.0', 'F'),
  ('yara.green@example.com', 'Zack', 'Baker', '4.0', 'M');

-- More fictitious players, so the waitlist can be tested with 7 courts (28 spots).
insert into public.accounts (email) values
  ('amara.okafor@example.com'),
  ('beth.nolan@example.com'),
  ('chloe.park@example.com'),
  ('dina.russo@example.com'),
  ('elena.marsh@example.com'),
  ('fiona.byrne@example.com'),
  ('gwen.holt@example.com'),
  ('hana.sato@example.com'),
  ('arjun.mehta@example.com'),
  ('ben.carter@example.com'),
  ('caleb.ford@example.com'),
  ('diego.ramos@example.com'),
  ('eli.brooks@example.com'),
  ('finn.walsh@example.com'),
  ('gabe.stone@example.com'),
  ('hugo.lambert@example.com');
insert into public.players (account_email, first_name, last_name, level, sex) values
  ('amara.okafor@example.com', 'Amara', 'Okafor', '3.5', 'F'),
  ('beth.nolan@example.com', 'Beth', 'Nolan', '3.0', 'F'),
  ('chloe.park@example.com', 'Chloe', 'Park', '4.0', 'F'),
  ('dina.russo@example.com', 'Dina', 'Russo', '3.5', 'F'),
  ('elena.marsh@example.com', 'Elena', 'Marsh', '4.0', 'F'),
  ('fiona.byrne@example.com', 'Fiona', 'Byrne', '3.0', 'F'),
  ('gwen.holt@example.com', 'Gwen', 'Holt', '4.5', 'F'),
  ('hana.sato@example.com', 'Hana', 'Sato', '3.5', 'F'),
  ('arjun.mehta@example.com', 'Arjun', 'Mehta', '3.5', 'M'),
  ('ben.carter@example.com', 'Ben', 'Carter', '3.0', 'M'),
  ('caleb.ford@example.com', 'Caleb', 'Ford', '4.0', 'M'),
  ('diego.ramos@example.com', 'Diego', 'Ramos', '3.5', 'M'),
  ('eli.brooks@example.com', 'Eli', 'Brooks', '4.0', 'M'),
  ('finn.walsh@example.com', 'Finn', 'Walsh', '3.0', 'M'),
  ('gabe.stone@example.com', 'Gabe', 'Stone', '4.5', 'M'),
  ('hugo.lambert@example.com', 'Hugo', 'Lambert', '3.5', 'M');

-- Two past Sundays of play history (from fictitious_past_play.csv), so the
-- ball roster and repeat-grouping check have something to work from.
insert into public.sessions (play_date, season_id, num_courts, signups_open_at, signups_close_at,
                             courts_publish_at, org_play, locked_at, locked_by)
select d, (select id from public.seasons where name = '2026'), 5,
       ((d - 6) + time '09:00') at time zone 'America/New_York',
       ((d - 1) + time '12:00') at time zone 'America/New_York',
       ((d - 1) + time '20:00') at time zone 'America/New_York',
       'mixed',
       ((d - 1) + time '15:00') at time zone 'America/New_York',
       'dev@example.com'
  from (values (date '2026-09-06'), (date '2026-09-13')) v (d);

insert into public.assignments (session_id, court, player_id, brings_balls)
select s.id, h.court, p.id, h.balls
  from (values
  (date '2026-09-06', 'Alice Johnson', 1, true),
  (date '2026-09-13', 'Alice Johnson', 1, false),
  (date '2026-09-06', 'Bob Smith', 1, false),
  (date '2026-09-13', 'Bob Smith', 1, true),
  (date '2026-09-06', 'Carol Lee', 1, false),
  (date '2026-09-13', 'Carol Lee', 1, false),
  (date '2026-09-06', 'David Kim', 1, false),
  (date '2026-09-13', 'David Kim', 1, false),
  (date '2026-09-06', 'Emma Brown', 2, true),
  (date '2026-09-13', 'Emma Brown', 3, false),
  (date '2026-09-06', 'Frank Davis', 2, false),
  (date '2026-09-06', 'Grace Wilson', 2, false),
  (date '2026-09-13', 'Grace Wilson', 3, false),
  (date '2026-09-06', 'Henry Moore', 2, false),
  (date '2026-09-13', 'Henry Moore', 4, true),
  (date '2026-09-06', 'Ivy Taylor', 3, true),
  (date '2026-09-06', 'Jack Anderson', 3, false),
  (date '2026-09-13', 'Jack Anderson', 2, true),
  (date '2026-09-06', 'Karen Thomas', 3, false),
  (date '2026-09-13', 'Karen Thomas', 2, false),
  (date '2026-09-06', 'Leo Martinez', 3, false),
  (date '2026-09-13', 'Leo Martinez', 4, false),
  (date '2026-09-06', 'Mia Garcia', 4, true),
  (date '2026-09-13', 'Mia Garcia', 2, false),
  (date '2026-09-06', 'Noah Robinson', 4, false),
  (date '2026-09-13', 'Noah Robinson', 2, false),
  (date '2026-09-06', 'Olivia Clark', 4, false),
  (date '2026-09-13', 'Olivia Clark', 5, false),
  (date '2026-09-06', 'Paul Rodriguez', 4, false),
  (date '2026-09-13', 'Paul Rodriguez', 3, true),
  (date '2026-09-06', 'Quinn Lewis', 5, true),
  (date '2026-09-13', 'Quinn Lewis', 4, false),
  (date '2026-09-06', 'Ryan Walker', 5, false),
  (date '2026-09-13', 'Ryan Walker', 3, false),
  (date '2026-09-06', 'Sara Hall', 5, false),
  (date '2026-09-13', 'Sara Hall', 4, false),
  (date '2026-09-06', 'Tom Allen', 5, false),
  (date '2026-09-13', 'Tom Allen', 5, false),
  (date '2026-09-13', 'Uma Young', 5, true),
  (date '2026-09-13', 'Victor King', 5, false)
  ) h (play_date, name, court, balls)
  join public.sessions s on s.play_date = h.play_date
  join public.players p on p.first_name || ' ' || p.last_name = h.name;
