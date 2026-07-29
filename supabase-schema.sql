-- Run this once in the Supabase SQL Editor before inviting beta testers.
create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  handle text unique not null check (handle ~ '^[A-Za-z0-9._-]{3,24}$'),
  first_name text default '', last_name text default '', home text default '', drone text default '',
  hide_exact_location boolean not null default true, show_activity boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  area_label text, hide_exact_location boolean not null default true,
  media jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts on delete cascade,
  reporter_id uuid not null references public.profiles on delete cascade,
  reason text not null check (char_length(reason) between 3 and 280),
  created_at timestamptz not null default now(),
  unique (post_id, reporter_id)
);

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.reports enable row level security;

create policy "profiles are readable" on public.profiles for select using (true);
create policy "users update their profile" on public.profiles for update using (auth.uid() = id);
create policy "posts are readable" on public.posts for select using (true);
create policy "users create their posts" on public.posts for insert with check (auth.uid() = author_id);
create policy "users delete their posts" on public.posts for delete using (auth.uid() = author_id);
create policy "users submit one report" on public.reports for insert with check (auth.uid() = reporter_id);

create or replace function public.create_profile_for_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, handle, first_name, last_name)
  values (new.id, new.raw_user_meta_data ->> 'handle', coalesce(new.raw_user_meta_data ->> 'first_name', ''), coalesce(new.raw_user_meta_data ->> 'last_name', ''));
  return new;
end;
$$;
create trigger create_profile_after_signup after insert on auth.users for each row execute procedure public.create_profile_for_user();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-media', 'post-media', true, 262144000, array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime'])
on conflict (id) do nothing;
create policy "beta users upload their media" on storage.objects for insert to authenticated
  with check (bucket_id = 'post-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "public reads beta media" on storage.objects for select using (bucket_id = 'post-media');
create policy "users delete their media" on storage.objects for delete to authenticated
  using (bucket_id = 'post-media' and (storage.foldername(name))[1] = auth.uid()::text);
