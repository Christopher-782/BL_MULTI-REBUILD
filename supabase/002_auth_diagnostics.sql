-- Run in Supabase SQL Editor while debugging login.
-- Read-only: this does not change any data.

select
  id,
  email,
  email_confirmed_at,
  confirmed_at,
  last_sign_in_at,
  created_at
from auth.users
order by created_at desc;

select
  id,
  full_name,
  role,
  status,
  created_at
from public.profiles
order by created_at desc;
