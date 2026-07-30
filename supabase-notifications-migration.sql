-- Run once in the Supabase SQL Editor to enable private in-app pilot notifications.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles on delete cascade,
  actor_id uuid not null references public.profiles on delete cascade,
  type text not null check (type in ('follow')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (recipient_id <> actor_id)
);

create index if not exists notifications_recipient_created_idx
  on public.notifications (recipient_id, created_at desc);

alter table public.notifications enable row level security;

create policy "pilots read their notifications" on public.notifications for select
  using (auth.uid() = recipient_id);
create policy "pilots create follow notifications" on public.notifications for insert
  with check (
    auth.uid() = actor_id
    and recipient_id <> actor_id
    and type = 'follow'
    and exists (
      select 1 from public.follows
      where follower_id = auth.uid() and following_id = recipient_id
    )
  );
create policy "pilots mark their notifications read" on public.notifications for update
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);
create policy "pilots clear their notifications" on public.notifications for delete
  using (auth.uid() = recipient_id);
