-- Run this once in the Supabase SQL Editor to persist pilot profile pictures.
alter table public.profiles add column if not exists avatar_url text;
