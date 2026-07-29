-- Run this once in the Supabase SQL Editor to enable likes and comments.
create table if not exists public.post_likes (
  post_id uuid not null references public.posts on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts on delete cascade,
  author_id uuid not null references public.profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

alter table public.post_likes enable row level security;
alter table public.comments enable row level security;

create policy "likes are readable" on public.post_likes for select using (true);
create policy "users add their own like" on public.post_likes for insert with check (auth.uid() = user_id);
create policy "users remove their own like" on public.post_likes for delete using (auth.uid() = user_id);
create policy "comments are readable" on public.comments for select using (true);
create policy "users add their own comments" on public.comments for insert with check (auth.uid() = author_id);
create policy "users delete their own comments" on public.comments for delete using (auth.uid() = author_id);
