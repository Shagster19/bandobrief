-- Run once after supabase-notifications-migration.sql if it was applied before this fix.
-- Require a real follow before an alert can be created, and allow re-follow alerts.
alter table public.notifications
  drop constraint if exists notifications_recipient_id_actor_id_type_key;

drop policy if exists "pilots create follow notifications" on public.notifications;
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
