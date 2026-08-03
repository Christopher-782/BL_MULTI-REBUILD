-- BL Multi Concept — Repair / backfill missing staff profiles
-- Safe to run multiple times.
-- Run in Supabase Dashboard -> SQL Editor.

begin;

-- Create a profile for every existing Auth user that does not already have one.
insert into public.profiles (id, full_name, role, status)
select
  u.id,
  coalesce(u.raw_user_meta_data ->> 'full_name', ''),
  'staff'::public.app_role,
  'active'::public.profile_status
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

commit;

-- Verify Auth users and their matching application profiles.
select
  u.id,
  u.email,
  u.email_confirmed_at,
  p.full_name,
  p.role,
  p.status
from auth.users u
left join public.profiles p on p.id = u.id
order by u.created_at desc;
