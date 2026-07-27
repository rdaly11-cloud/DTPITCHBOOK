-- Run this once in the Supabase SQL editor for your project
-- (Dashboard -> SQL Editor -> New query -> paste -> Run)

create table if not exists pitches (
  id text primary key,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists bookings (
  id text primary key,
  pitch_id text not null references pitches(id) on delete cascade,
  date date not null,
  start_time text not null,
  end_time text not null,
  coach text not null,
  team text not null,
  notes text default '',
  created_at timestamptz not null default now()
);

create index if not exists bookings_date_idx on bookings (date);
create index if not exists bookings_pitch_date_idx on bookings (pitch_id, date);

-- Seed two starter pitches (safe to skip/edit if you'd rather add your own in-app)
insert into pitches (id, name, sort_order) values
  ('p1', 'Main Pitch', 1),
  ('p2', 'Training Pitch', 2)
on conflict (id) do nothing;

-- Row Level Security
-- This app has no login system - anyone with the link can view and book pitches,
-- same as a shared noticeboard. That means the policies below intentionally allow
-- open read/write access via the public "anon" key. Do not put anything sensitive
-- in this database. If you later want to require sign-in, tighten these policies
-- and add Supabase Auth - ask Claude for help wiring that up.

alter table pitches enable row level security;
alter table bookings enable row level security;

create policy "anon can read pitches" on pitches for select using (true);
create policy "anon can write pitches" on pitches for insert with check (true);
create policy "anon can update pitches" on pitches for update using (true);
create policy "anon can delete pitches" on pitches for delete using (true);

create policy "anon can read bookings" on bookings for select using (true);
create policy "anon can write bookings" on bookings for insert with check (true);
create policy "anon can update bookings" on bookings for update using (true);
create policy "anon can delete bookings" on bookings for delete using (true);

-- Enable realtime updates so all coaches see new bookings live without refreshing
alter publication supabase_realtime add table bookings;
alter publication supabase_realtime add table pitches;
