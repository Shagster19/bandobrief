-- Run once in the Supabase SQL Editor to let pilots see who follows them.
-- A pilot can read follows they created and follows where they are the followed pilot.
drop policy if exists "pilots view their follows" on public.follows;
create policy "pilots view their network" on public.follows for select
  using (auth.uid() = follower_id or auth.uid() = following_id);
