-- BL Multi Concept — Step 1 Supabase foundation
-- Run this ONCE in Supabase Dashboard -> SQL Editor.
-- This step creates staff profiles and the role/status foundation only.
-- Financial tables deliberately come later.

begin;

create type public.app_role as enum (
  'super_admin',
  'admin',
  'manager',
  'staff',
  'auditor'
);

create type public.profile_status as enum (
  'active',
  'suspended',
  'disabled'
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  role public.app_role not null default 'staff',
  status public.profile_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Application staff profile mapped one-to-one to Supabase Auth users.';
comment on column public.profiles.role is 'Authorization role. Never accept this value directly from public signup metadata.';

-- Every new Auth user gets a staff profile.
-- SECURITY DEFINER is needed because auth.users is outside normal client access.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, role, status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    'staff'::public.app_role,
    'active'::public.profile_status
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

-- Keep updated_at accurate without trusting the browser.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

alter table public.profiles enable row level security;

-- Step 1 deliberately grants only self-read access from the browser.
-- Staff management and role changes will be handled later through restricted functions.
create policy "authenticated users can read own profile"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

-- Least privilege: browser users can read their profile, not modify roles/status directly.
revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;
grant select on table public.profiles to authenticated;

commit;
