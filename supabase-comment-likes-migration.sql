-- Run this upgrade once in the Supabase SQL Editor.
create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

alter table public.post_likes enable row level security;
alter table public.comment_likes enable row level security;

drop policy if exists "likes are readable" on public.post_likes;
drop policy if exists "users add their own like" on public.post_likes;
drop policy if exists "users remove their own like" on public.post_likes;
create policy "likes are readable" on public.post_likes for select using (true);
create policy "users add their own like" on public.post_likes for insert with check (auth.uid() = user_id);
create policy "users remove their own like" on public.post_likes for delete using (auth.uid() = user_id);

drop policy if exists "comment likes are readable" on public.comment_likes;
drop policy if exists "users add their own comment like" on public.comment_likes;
drop policy if exists "users remove their own comment like" on public.comment_likes;
create policy "comment likes are readable" on public.comment_likes for select using (true);
create policy "users add their own comment like" on public.comment_likes for insert with check (auth.uid() = user_id);
create policy "users remove their own comment like" on public.comment_likes for delete using (auth.uid() = user_id);
