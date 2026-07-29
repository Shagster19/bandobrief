-- PERMANENT beta reset: removes every BandoBrief account and all community content.
-- Run in the SQL Editor for project rmecofvmccyycjbfrryp only.

begin;

delete from storage.objects where bucket_id = 'post-media';
delete from public.reports;
delete from public.posts;
delete from public.profiles;
delete from auth.users;

commit;
