-- Run once to enable privacy-rounded map activity and pilot following.
alter table public.profiles
  add column if not exists activity_lat double precision,
  add column if not exists activity_lng double precision,
  add column if not exists activity_updated_at timestamptz;

create index if not exists profiles_recent_activity_idx
  on public.profiles (activity_updated_at desc)
  where show_activity = true and activity_lat is not null and activity_lng is not null;

create table if not exists public.follows (
  follower_id uuid not null references public.profiles on delete cascade,
  following_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

alter table public.follows enable row level security;
create policy "pilots view their follows" on public.follows for select using (auth.uid() = follower_id);
create policy "pilots follow others" on public.follows for insert with check (auth.uid() = follower_id);
create policy "pilots unfollow others" on public.follows for delete using (auth.uid() = follower_id);
