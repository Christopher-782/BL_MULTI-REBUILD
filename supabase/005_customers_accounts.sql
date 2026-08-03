-- =========================================================
-- FINTECH REBUILD - STEP 3
-- Customers + customer accounts
-- Run AFTER 004_staff_authorization_audit.sql
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'customer_status'
      and n.nspname = 'public'
  ) then
    create type public.customer_status as enum (
      'active',
      'suspended',
      'closed'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'account_status'
      and n.nspname = 'public'
  ) then
    create type public.account_status as enum (
      'active',
      'frozen',
      'closed'
    );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'account_type'
      and n.nspname = 'public'
  ) then
    create type public.account_type as enum (
      'savings',
      'current',
      'business'
    );
  end if;
end
$$;

-- ---------------------------------------------------------
-- 2. NUMBER SEQUENCES
-- ---------------------------------------------------------

create sequence if not exists public.customer_number_seq start with 1 increment by 1;
create sequence if not exists public.account_number_seq start with 1 increment by 1;

revoke all on sequence public.customer_number_seq from anon, authenticated;
revoke all on sequence public.account_number_seq from anon, authenticated;

-- ---------------------------------------------------------
-- 3. TABLES
-- ---------------------------------------------------------

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  customer_number text not null unique,
  first_name text not null,
  middle_name text,
  last_name text not null,
  phone text not null,
  email text,
  gender text,
  date_of_birth date,
  address text,
  city text,
  state text,
  occupation text,
  next_of_kin_name text,
  next_of_kin_phone text,
  status public.customer_status not null default 'active',
  created_by uuid not null references public.profiles(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_gender_check check (
    gender is null or gender in ('male', 'female', 'other', 'prefer_not_to_say')
  )
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  account_number text not null unique,
  account_type public.account_type not null default 'savings',
  currency text not null default 'NGN',
  status public.account_status not null default 'active',
  cached_balance_minor bigint not null default 0,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_currency_check check (currency = upper(currency) and char_length(currency) = 3)
);

-- Keep one phone number tied to one customer record.
create unique index if not exists customers_phone_unique_idx
  on public.customers (phone);

create index if not exists customers_name_idx
  on public.customers (last_name, first_name);

create index if not exists customers_status_idx
  on public.customers (status);

create index if not exists customers_created_at_idx
  on public.customers (created_at desc);

create index if not exists accounts_customer_id_idx
  on public.accounts (customer_id);

create index if not exists accounts_status_idx
  on public.accounts (status);

-- ---------------------------------------------------------
-- 4. AUTHORIZATION HELPERS
-- ---------------------------------------------------------

create or replace function private.can_manage_customers()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.current_app_role() = any (
      array['super_admin', 'admin', 'manager', 'staff']::public.app_role[]
    ),
    false
  );
$$;

create or replace function private.can_view_customers()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.is_active_user(), false);
$$;

revoke all on function private.can_manage_customers() from public;
revoke all on function private.can_view_customers() from public;
grant execute on function private.can_manage_customers() to authenticated;
grant execute on function private.can_view_customers() to authenticated;

-- ---------------------------------------------------------
-- 5. RLS + TABLE PRIVILEGES
-- ---------------------------------------------------------

alter table public.customers enable row level security;
alter table public.accounts enable row level security;

revoke all on table public.customers from anon, authenticated;
revoke all on table public.accounts from anon, authenticated;

grant select on table public.customers to authenticated;
grant select on table public.accounts to authenticated;

drop policy if exists "active staff can view customers" on public.customers;
create policy "active staff can view customers"
on public.customers
for select
to authenticated
using ((select private.can_view_customers()));

drop policy if exists "active staff can view accounts" on public.accounts;
create policy "active staff can view accounts"
on public.accounts
for select
to authenticated
using ((select private.can_view_customers()));

-- ---------------------------------------------------------
-- 6. INTERNAL HELPERS
-- ---------------------------------------------------------

create or replace function private.next_customer_number()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'BLM' || lpad(nextval('public.customer_number_seq')::text, 7, '0');
$$;

create or replace function private.next_account_number()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select '21' || lpad(nextval('public.account_number_seq')::text, 8, '0');
$$;

create or replace function private.current_actor_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email
  from auth.users u
  where u.id = (select auth.uid())
  limit 1;
$$;

revoke all on function private.next_customer_number() from public;
revoke all on function private.next_account_number() from public;
revoke all on function private.current_actor_email() from public;

-- ---------------------------------------------------------
-- 7. CREATE CUSTOMER + INITIAL ACCOUNT (ATOMIC)
-- ---------------------------------------------------------

create or replace function public.create_customer_with_account(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_middle_name text default null,
  p_email text default null,
  p_gender text default null,
  p_date_of_birth date default null,
  p_address text default null,
  p_city text default null,
  p_state text default null,
  p_occupation text default null,
  p_next_of_kin_name text default null,
  p_next_of_kin_phone text default null,
  p_account_type public.account_type default 'savings'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_customer public.customers;
  v_account public.accounts;
  v_customer_number text;
  v_account_number text;
  v_phone text := btrim(coalesce(p_phone, ''));
  v_first_name text := btrim(coalesce(p_first_name, ''));
  v_last_name text := btrim(coalesce(p_last_name, ''));
  v_middle_name text := nullif(btrim(coalesce(p_middle_name, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_gender text := nullif(lower(btrim(coalesce(p_gender, ''))), '');
begin
  if v_actor_id is null or not private.can_manage_customers() then
    raise exception 'You do not have permission to create customers.' using errcode = '42501';
  end if;

  if v_first_name = '' or v_last_name = '' then
    raise exception 'First name and last name are required.' using errcode = '22023';
  end if;

  if v_phone = '' then
    raise exception 'Phone number is required.' using errcode = '22023';
  end if;

  if v_gender is not null and v_gender not in ('male', 'female', 'other', 'prefer_not_to_say') then
    raise exception 'Invalid gender value.' using errcode = '22023';
  end if;

  if exists (select 1 from public.customers c where c.phone = v_phone) then
    raise exception 'A customer already exists with this phone number.' using errcode = '23505';
  end if;

  v_customer_number := private.next_customer_number();
  v_account_number := private.next_account_number();

  insert into public.customers (
    customer_number,
    first_name,
    middle_name,
    last_name,
    phone,
    email,
    gender,
    date_of_birth,
    address,
    city,
    state,
    occupation,
    next_of_kin_name,
    next_of_kin_phone,
    status,
    created_by,
    updated_by
  ) values (
    v_customer_number,
    v_first_name,
    v_middle_name,
    v_last_name,
    v_phone,
    v_email,
    v_gender,
    p_date_of_birth,
    nullif(btrim(coalesce(p_address, '')), ''),
    nullif(btrim(coalesce(p_city, '')), ''),
    nullif(btrim(coalesce(p_state, '')), ''),
    nullif(btrim(coalesce(p_occupation, '')), ''),
    nullif(btrim(coalesce(p_next_of_kin_name, '')), ''),
    nullif(btrim(coalesce(p_next_of_kin_phone, '')), ''),
    'active'::public.customer_status,
    v_actor_id,
    v_actor_id
  )
  returning * into v_customer;

  insert into public.accounts (
    customer_id,
    account_number,
    account_type,
    currency,
    status,
    cached_balance_minor,
    created_by
  ) values (
    v_customer.id,
    v_account_number,
    p_account_type,
    'NGN',
    'active'::public.account_status,
    0,
    v_actor_id
  )
  returning * into v_account;

  insert into public.audit_logs (
    actor_id,
    actor_name,
    actor_email,
    action,
    entity_type,
    entity_id,
    description,
    metadata
  )
  select
    v_actor_id,
    p.full_name,
    private.current_actor_email(),
    'customer.created',
    'customer',
    v_customer.id,
    'Created customer ' || v_customer.customer_number || ' with account ' || v_account.account_number || '.',
    jsonb_build_object(
      'customer_number', v_customer.customer_number,
      'account_number', v_account.account_number,
      'account_type', v_account.account_type
    )
  from public.profiles p
  where p.id = v_actor_id;

  return jsonb_build_object(
    'customer', to_jsonb(v_customer),
    'account', to_jsonb(v_account)
  );
end;
$$;

-- ---------------------------------------------------------
-- 8. UPDATE CUSTOMER
-- ---------------------------------------------------------

create or replace function public.update_customer(
  p_customer_id uuid,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_middle_name text default null,
  p_email text default null,
  p_gender text default null,
  p_date_of_birth date default null,
  p_address text default null,
  p_city text default null,
  p_state text default null,
  p_occupation text default null,
  p_next_of_kin_name text default null,
  p_next_of_kin_phone text default null,
  p_status public.customer_status default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_existing public.customers;
  v_updated public.customers;
  v_phone text := btrim(coalesce(p_phone, ''));
  v_first_name text := btrim(coalesce(p_first_name, ''));
  v_last_name text := btrim(coalesce(p_last_name, ''));
  v_gender text := nullif(lower(btrim(coalesce(p_gender, ''))), '');
begin
  if v_actor_id is null or not private.can_manage_customers() then
    raise exception 'You do not have permission to update customers.' using errcode = '42501';
  end if;

  if v_first_name = '' or v_last_name = '' or v_phone = '' then
    raise exception 'First name, last name and phone number are required.' using errcode = '22023';
  end if;

  if v_gender is not null and v_gender not in ('male', 'female', 'other', 'prefer_not_to_say') then
    raise exception 'Invalid gender value.' using errcode = '22023';
  end if;

  select * into v_existing
  from public.customers c
  where c.id = p_customer_id;

  if not found then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.customers c
    where c.phone = v_phone
      and c.id <> p_customer_id
  ) then
    raise exception 'Another customer already uses this phone number.' using errcode = '23505';
  end if;

  update public.customers
  set
    first_name = v_first_name,
    middle_name = nullif(btrim(coalesce(p_middle_name, '')), ''),
    last_name = v_last_name,
    phone = v_phone,
    email = nullif(lower(btrim(coalesce(p_email, ''))), ''),
    gender = v_gender,
    date_of_birth = p_date_of_birth,
    address = nullif(btrim(coalesce(p_address, '')), ''),
    city = nullif(btrim(coalesce(p_city, '')), ''),
    state = nullif(btrim(coalesce(p_state, '')), ''),
    occupation = nullif(btrim(coalesce(p_occupation, '')), ''),
    next_of_kin_name = nullif(btrim(coalesce(p_next_of_kin_name, '')), ''),
    next_of_kin_phone = nullif(btrim(coalesce(p_next_of_kin_phone, '')), ''),
    status = p_status,
    updated_by = v_actor_id,
    updated_at = now()
  where id = p_customer_id
  returning * into v_updated;

  insert into public.audit_logs (
    actor_id,
    actor_name,
    actor_email,
    action,
    entity_type,
    entity_id,
    description,
    metadata
  )
  select
    v_actor_id,
    p.full_name,
    private.current_actor_email(),
    'customer.updated',
    'customer',
    v_updated.id,
    'Updated customer ' || v_updated.customer_number || '.',
    jsonb_build_object(
      'before', to_jsonb(v_existing) - 'updated_at',
      'after', to_jsonb(v_updated) - 'updated_at'
    )
  from public.profiles p
  where p.id = v_actor_id;

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 9. CREATE AN ADDITIONAL ACCOUNT
-- ---------------------------------------------------------

create or replace function public.create_customer_account(
  p_customer_id uuid,
  p_account_type public.account_type default 'savings'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_customer public.customers;
  v_account public.accounts;
  v_account_number text;
begin
  if v_actor_id is null or not private.can_manage_customers() then
    raise exception 'You do not have permission to create customer accounts.' using errcode = '42501';
  end if;

  select * into v_customer
  from public.customers c
  where c.id = p_customer_id;

  if not found then
    raise exception 'Customer not found.' using errcode = 'P0002';
  end if;

  if v_customer.status = 'closed'::public.customer_status then
    raise exception 'You cannot create an account for a closed customer.' using errcode = '22023';
  end if;

  v_account_number := private.next_account_number();

  insert into public.accounts (
    customer_id,
    account_number,
    account_type,
    currency,
    status,
    cached_balance_minor,
    created_by
  ) values (
    p_customer_id,
    v_account_number,
    p_account_type,
    'NGN',
    'active'::public.account_status,
    0,
    v_actor_id
  )
  returning * into v_account;

  insert into public.audit_logs (
    actor_id,
    actor_name,
    actor_email,
    action,
    entity_type,
    entity_id,
    description,
    metadata
  )
  select
    v_actor_id,
    p.full_name,
    private.current_actor_email(),
    'account.created',
    'account',
    v_account.id,
    'Created account ' || v_account.account_number || ' for customer ' || v_customer.customer_number || '.',
    jsonb_build_object(
      'customer_id', v_customer.id,
      'customer_number', v_customer.customer_number,
      'account_number', v_account.account_number,
      'account_type', v_account.account_type
    )
  from public.profiles p
  where p.id = v_actor_id;

  return to_jsonb(v_account);
end;
$$;

-- ---------------------------------------------------------
-- 10. ACCOUNT STATUS MANAGEMENT
-- ---------------------------------------------------------

create or replace function public.update_account_status(
  p_account_id uuid,
  p_status public.account_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_existing public.accounts;
  v_updated public.accounts;
begin
  if v_actor_id is null or not private.can_manage_customers() then
    raise exception 'You do not have permission to update customer accounts.' using errcode = '42501';
  end if;

  select * into v_existing
  from public.accounts a
  where a.id = p_account_id;

  if not found then
    raise exception 'Account not found.' using errcode = 'P0002';
  end if;

  update public.accounts
  set status = p_status, updated_at = now()
  where id = p_account_id
  returning * into v_updated;

  insert into public.audit_logs (
    actor_id,
    actor_name,
    actor_email,
    action,
    entity_type,
    entity_id,
    description,
    metadata
  )
  select
    v_actor_id,
    p.full_name,
    private.current_actor_email(),
    'account.status_updated',
    'account',
    v_updated.id,
    'Changed account ' || v_updated.account_number || ' status to ' || v_updated.status::text || '.',
    jsonb_build_object(
      'before_status', v_existing.status,
      'after_status', v_updated.status,
      'customer_id', v_updated.customer_id
    )
  from public.profiles p
  where p.id = v_actor_id;

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 11. RPC PRIVILEGES
-- ---------------------------------------------------------

revoke execute on function public.create_customer_with_account(
  text, text, text, text, text, text, date, text, text, text, text, text, text, public.account_type
) from public, anon;

grant execute on function public.create_customer_with_account(
  text, text, text, text, text, text, date, text, text, text, text, text, text, public.account_type
) to authenticated;

revoke execute on function public.update_customer(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, public.customer_status
) from public, anon;

grant execute on function public.update_customer(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, public.customer_status
) to authenticated;

revoke execute on function public.create_customer_account(uuid, public.account_type)
  from public, anon;
grant execute on function public.create_customer_account(uuid, public.account_type)
  to authenticated;

revoke execute on function public.update_account_status(uuid, public.account_status)
  from public, anon;
grant execute on function public.update_account_status(uuid, public.account_status)
  to authenticated;

commit;
