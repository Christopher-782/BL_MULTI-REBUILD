-- =========================================================
-- FINTECH REBUILD - STEP 5B
-- Overdraft facilities
--
-- Run AFTER:
--   009_loans_repayments.sql
--
-- Design:
-- - An overdraft is an approved LIMIT on one customer account.
-- - It is NOT disbursed as a lump-sum loan.
-- - An active overdraft increases the amount available for withdrawal.
-- - The account balance may become negative, but never beyond the
--   approved active overdraft limit.
-- - Normal deposits automatically reduce a negative balance.
-- - An overdraft cannot be closed while the account is negative.
-- - No overdraft interest/fee is calculated in this step.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1. ENUM + SEQUENCE
-- ---------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'overdraft_status'
      and n.nspname = 'public'
  ) then
    create type public.overdraft_status as enum (
      'pending',
      'active',
      'rejected',
      'closed'
    );
  end if;
end
$$;

create sequence if not exists public.overdraft_number_seq
  start with 1
  increment by 1;

revoke all on sequence public.overdraft_number_seq
from anon, authenticated;

-- ---------------------------------------------------------
-- 2. TABLE
-- ---------------------------------------------------------

create table if not exists public.overdrafts (
  id uuid primary key default gen_random_uuid(),

  overdraft_number text not null unique,

  customer_id uuid not null
    references public.customers(id)
    on delete restrict,

  account_id uuid not null
    references public.accounts(id)
    on delete restrict,

  limit_minor bigint not null,

  status public.overdraft_status
    not null
    default 'pending',

  purpose text,
  expiry_date date,

  requested_by uuid not null
    references public.profiles(id)
    on delete restrict,

  requested_by_name text not null,
  requested_at timestamptz not null default now(),

  approved_by uuid
    references public.profiles(id)
    on delete restrict,

  approved_by_name text,
  approved_at timestamptz,

  rejected_by uuid
    references public.profiles(id)
    on delete restrict,

  rejected_by_name text,
  rejected_at timestamptz,
  rejection_reason text,

  closed_by uuid
    references public.profiles(id)
    on delete restrict,

  closed_by_name text,
  closed_at timestamptz,
  close_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint overdrafts_limit_positive
    check (limit_minor > 0)
);

create index if not exists overdrafts_customer_id_idx
  on public.overdrafts(customer_id);

create index if not exists overdrafts_account_id_idx
  on public.overdrafts(account_id);

create index if not exists overdrafts_status_requested_at_idx
  on public.overdrafts(status, requested_at desc);

-- Only one pending OR active facility per account.
create unique index if not exists overdrafts_one_open_facility_per_account_idx
  on public.overdrafts(account_id)
  where status in (
    'pending'::public.overdraft_status,
    'active'::public.overdraft_status
  );

-- ---------------------------------------------------------
-- 3. AUTHORIZATION
-- ---------------------------------------------------------

create or replace function private.can_request_overdrafts()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.is_active_user()
    and private.current_app_role() = any (
      array[
        'super_admin',
        'admin',
        'manager',
        'staff'
      ]::public.app_role[]
    ),
    false
  );
$$;

create or replace function private.can_approve_overdrafts()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    private.is_active_user()
    and private.current_app_role() = any (
      array[
        'super_admin',
        'admin',
        'manager'
      ]::public.app_role[]
    ),
    false
  );
$$;

revoke all on function private.can_request_overdrafts()
from public;

revoke all on function private.can_approve_overdrafts()
from public;

grant execute on function private.can_request_overdrafts()
to authenticated;

grant execute on function private.can_approve_overdrafts()
to authenticated;

-- ---------------------------------------------------------
-- 4. INTERNAL HELPERS
-- ---------------------------------------------------------

create or replace function private.next_overdraft_number()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'OD' ||
    lpad(
      nextval('public.overdraft_number_seq')::text,
      6,
      '0'
    );
$$;

create or replace function private.active_overdraft_limit(
  p_account_id uuid
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select o.limit_minor
      from public.overdrafts o
      where o.account_id = p_account_id
        and o.status = 'active'::public.overdraft_status
        and (
          o.expiry_date is null
          or o.expiry_date >= current_date
        )
      order by o.approved_at desc nulls last
      limit 1
    ),
    0
  );
$$;

create or replace function private.account_available_to_withdraw(
  p_account_id uuid
)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_limit bigint;
begin
  select a.cached_balance_minor
  into v_balance
  from public.accounts a
  where a.id = p_account_id;

  if not found then
    return 0;
  end if;

  v_limit :=
    private.active_overdraft_limit(
      p_account_id
    );

  return greatest(
    v_balance + v_limit,
    0
  );
end;
$$;

revoke all on function private.next_overdraft_number()
from public;

revoke all on function private.active_overdraft_limit(uuid)
from public;

revoke all on function private.account_available_to_withdraw(uuid)
from public;

grant execute on function private.active_overdraft_limit(uuid)
to authenticated;

grant execute on function private.account_available_to_withdraw(uuid)
to authenticated;

-- ---------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------

alter table public.overdrafts
enable row level security;

revoke all on table public.overdrafts
from anon, authenticated;

grant select on table public.overdrafts
to authenticated;

drop policy if exists
  "active staff can view overdrafts"
on public.overdrafts;

create policy
  "active staff can view overdrafts"
on public.overdrafts
for select
to authenticated
using ((select private.is_active_user()));

-- ---------------------------------------------------------
-- 6. DIRECTORY VIEW
-- ---------------------------------------------------------

create or replace view public.overdraft_directory
with (security_invoker = true)
as
select
  o.id,
  o.overdraft_number,
  o.limit_minor,
  o.status,
  o.purpose,
  o.expiry_date,

  o.requested_by,
  o.requested_by_name,
  o.requested_at,

  o.approved_by,
  o.approved_by_name,
  o.approved_at,

  o.rejected_by,
  o.rejected_by_name,
  o.rejected_at,
  o.rejection_reason,

  o.closed_by,
  o.closed_by_name,
  o.closed_at,
  o.close_reason,

  o.created_at,
  o.updated_at,

  c.id as customer_id,
  c.customer_number,

  concat_ws(
    ' ',
    c.first_name,
    nullif(c.middle_name, ''),
    c.last_name
  ) as customer_name,

  c.phone as customer_phone,
  c.status as customer_status,

  a.id as account_id,
  a.account_number,
  a.account_type,
  a.currency,
  a.status as account_status,
  a.cached_balance_minor as account_balance_minor,

  greatest(
    -a.cached_balance_minor,
    0
  ) as used_minor,

  case
    when o.status = 'active'::public.overdraft_status
      and (
        o.expiry_date is null
        or o.expiry_date >= current_date
      )
    then greatest(
      o.limit_minor -
      greatest(-a.cached_balance_minor, 0),
      0
    )
    else 0
  end as overdraft_available_minor,

  case
    when o.status = 'active'::public.overdraft_status
      and (
        o.expiry_date is null
        or o.expiry_date >= current_date
      )
    then greatest(
      a.cached_balance_minor +
      o.limit_minor,
      0
    )
    else greatest(
      a.cached_balance_minor,
      0
    )
  end as total_withdrawable_minor,

  case
    when o.status = 'active'::public.overdraft_status
      and o.expiry_date is not null
      and o.expiry_date < current_date
    then true
    else false
  end as expired

from public.overdrafts o
join public.customers c
  on c.id = o.customer_id
join public.accounts a
  on a.id = o.account_id;

revoke all on table public.overdraft_directory
from anon, authenticated;

grant select on table public.overdraft_directory
to authenticated;

-- ---------------------------------------------------------
-- 7. REQUEST OVERDRAFT
-- ---------------------------------------------------------

create or replace function public.request_overdraft(
  p_account_id uuid,
  p_limit_minor bigint,
  p_expiry_date date default null,
  p_purpose text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_account public.accounts;
  v_customer public.customers;
  v_overdraft public.overdrafts;
begin
  if v_actor_id is null
    or not private.can_request_overdrafts() then
    raise exception
      'You do not have permission to create overdraft requests.'
      using errcode = '42501';
  end if;

  if p_limit_minor is null
    or p_limit_minor <= 0 then
    raise exception
      'Overdraft limit must be greater than zero.'
      using errcode = '22023';
  end if;

  if p_expiry_date is not null
    and p_expiry_date < current_date then
    raise exception
      'Overdraft expiry date cannot be in the past.'
      using errcode = '22023';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id = p_account_id;

  if not found then
    raise exception
      'Account not found.'
      using errcode = 'P0002';
  end if;

  if v_account.status <> 'active'::public.account_status then
    raise exception
      'The selected account must be active.'
      using errcode = '22023';
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id = v_account.customer_id;

  if v_customer.status <> 'active'::public.customer_status then
    raise exception
      'The customer must be active.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.overdrafts o
    where o.account_id = v_account.id
      and o.status in (
        'pending'::public.overdraft_status,
        'active'::public.overdraft_status
      )
  ) then
    raise exception
      'This account already has a pending or active overdraft facility.'
      using errcode = '23505';
  end if;

  v_actor_name :=
    private.current_actor_name();

  insert into public.overdrafts (
    overdraft_number,
    customer_id,
    account_id,
    limit_minor,
    status,
    purpose,
    expiry_date,
    requested_by,
    requested_by_name
  )
  values (
    private.next_overdraft_number(),
    v_customer.id,
    v_account.id,
    p_limit_minor,
    'pending'::public.overdraft_status,
    nullif(btrim(coalesce(p_purpose, '')), ''),
    p_expiry_date,
    v_actor_id,
    v_actor_name
  )
  returning *
  into v_overdraft;

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
  values (
    v_actor_id,
    v_actor_name,
    private.current_actor_email(),
    'overdraft.requested',
    'overdraft',
    v_overdraft.id,
    'Created overdraft request ' ||
      v_overdraft.overdraft_number || '.',
    jsonb_build_object(
      'overdraft_number',
        v_overdraft.overdraft_number,
      'customer_number',
        v_customer.customer_number,
      'account_number',
        v_account.account_number,
      'limit_minor',
        v_overdraft.limit_minor,
      'expiry_date',
        v_overdraft.expiry_date
    )
  );

  return to_jsonb(v_overdraft);
end;
$$;

-- ---------------------------------------------------------
-- 8. APPROVE OVERDRAFT
-- ---------------------------------------------------------

create or replace function public.approve_overdraft(
  p_overdraft_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_overdraft public.overdrafts;
  v_account public.accounts;
  v_customer public.customers;
  v_updated public.overdrafts;
begin
  if v_actor_id is null
    or not private.can_approve_overdrafts() then
    raise exception
      'You do not have permission to approve overdrafts.'
      using errcode = '42501';
  end if;

  v_actor_name :=
    private.current_actor_name();

  select *
  into v_overdraft
  from public.overdrafts o
  where o.id = p_overdraft_id
  for update;

  if not found then
    raise exception
      'Overdraft request not found.'
      using errcode = 'P0002';
  end if;

  if v_overdraft.status <> 'pending'::public.overdraft_status then
    raise exception
      'Only pending overdraft requests can be approved.'
      using errcode = '22023';
  end if;

  if v_overdraft.requested_by = v_actor_id then
    raise exception
      'Maker-checker protection: you cannot approve your own overdraft request.'
      using errcode = '42501';
  end if;

  if v_overdraft.expiry_date is not null
    and v_overdraft.expiry_date < current_date then
    raise exception
      'This overdraft request has an expiry date in the past.'
      using errcode = '22023';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id = v_overdraft.account_id
  for update;

  if not found then
    raise exception
      'Account not found.'
      using errcode = 'P0002';
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id = v_overdraft.customer_id;

  if v_account.status <> 'active'::public.account_status
    or v_customer.status <> 'active'::public.customer_status then
    raise exception
      'The customer and account must both be active before approval.'
      using errcode = '22023';
  end if;

  update public.overdrafts
  set
    status = 'active'::public.overdraft_status,
    approved_by = v_actor_id,
    approved_by_name = v_actor_name,
    approved_at = now(),
    updated_at = now()
  where id = v_overdraft.id
  returning *
  into v_updated;

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
  values (
    v_actor_id,
    v_actor_name,
    private.current_actor_email(),
    'overdraft.approved',
    'overdraft',
    v_updated.id,
    'Approved overdraft ' ||
      v_updated.overdraft_number || '.',
    jsonb_build_object(
      'overdraft_number',
        v_updated.overdraft_number,
      'limit_minor',
        v_updated.limit_minor,
      'expiry_date',
        v_updated.expiry_date
    )
  );

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 9. REJECT OVERDRAFT
-- ---------------------------------------------------------

create or replace function public.reject_overdraft(
  p_overdraft_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_overdraft public.overdrafts;
  v_reason text :=
    nullif(btrim(coalesce(p_reason, '')), '');
  v_updated public.overdrafts;
begin
  if v_actor_id is null
    or not private.can_approve_overdrafts() then
    raise exception
      'You do not have permission to reject overdrafts.'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception
      'A rejection reason is required.'
      using errcode = '22023';
  end if;

  v_actor_name :=
    private.current_actor_name();

  select *
  into v_overdraft
  from public.overdrafts o
  where o.id = p_overdraft_id
  for update;

  if not found then
    raise exception
      'Overdraft request not found.'
      using errcode = 'P0002';
  end if;

  if v_overdraft.status <> 'pending'::public.overdraft_status then
    raise exception
      'Only pending overdraft requests can be rejected.'
      using errcode = '22023';
  end if;

  if v_overdraft.requested_by = v_actor_id then
    raise exception
      'Maker-checker protection: you cannot reject your own overdraft request.'
      using errcode = '42501';
  end if;

  update public.overdrafts
  set
    status = 'rejected'::public.overdraft_status,
    rejected_by = v_actor_id,
    rejected_by_name = v_actor_name,
    rejected_at = now(),
    rejection_reason = v_reason,
    updated_at = now()
  where id = v_overdraft.id
  returning *
  into v_updated;

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
  values (
    v_actor_id,
    v_actor_name,
    private.current_actor_email(),
    'overdraft.rejected',
    'overdraft',
    v_updated.id,
    'Rejected overdraft ' ||
      v_updated.overdraft_number || '.',
    jsonb_build_object(
      'overdraft_number',
        v_updated.overdraft_number,
      'reason',
        v_reason
    )
  );

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 10. CLOSE ACTIVE OVERDRAFT
-- Customer must first clear all overdraft usage through deposits.
-- ---------------------------------------------------------

create or replace function public.close_overdraft(
  p_overdraft_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_overdraft public.overdrafts;
  v_account public.accounts;
  v_updated public.overdrafts;
  v_reason text :=
    nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor_id is null
    or not private.can_approve_overdrafts() then
    raise exception
      'You do not have permission to close overdrafts.'
      using errcode = '42501';
  end if;

  v_actor_name :=
    private.current_actor_name();

  select *
  into v_overdraft
  from public.overdrafts o
  where o.id = p_overdraft_id
  for update;

  if not found then
    raise exception
      'Overdraft facility not found.'
      using errcode = 'P0002';
  end if;

  if v_overdraft.status <> 'active'::public.overdraft_status then
    raise exception
      'Only active overdrafts can be closed.'
      using errcode = '22023';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id = v_overdraft.account_id
  for update;

  if v_account.cached_balance_minor < 0 then
    raise exception
      'This overdraft cannot be closed while the account balance is negative. Deposit enough funds to clear the overdraft usage first.'
      using errcode = '22003';
  end if;

  update public.overdrafts
  set
    status = 'closed'::public.overdraft_status,
    closed_by = v_actor_id,
    closed_by_name = v_actor_name,
    closed_at = now(),
    close_reason = v_reason,
    updated_at = now()
  where id = v_overdraft.id
  returning *
  into v_updated;

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
  values (
    v_actor_id,
    v_actor_name,
    private.current_actor_email(),
    'overdraft.closed',
    'overdraft',
    v_updated.id,
    'Closed overdraft ' ||
      v_updated.overdraft_number || '.',
    jsonb_build_object(
      'overdraft_number',
        v_updated.overdraft_number,
      'reason',
        v_reason
    )
  );

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 11. REBUILD CUSTOMER LOOKUP WITH OVERDRAFT INFORMATION
-- ---------------------------------------------------------

create or replace function public.get_customer_transaction_context(
  p_customer_number text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
  v_accounts jsonb;
begin
  if auth.uid() is null
    or not private.is_active_user() then
    raise exception
      'Your staff account is not active.'
      using errcode = '42501';
  end if;

  select *
  into v_customer
  from public.customers c
  where c.customer_number =
    btrim(coalesce(p_customer_number, ''));

  if not found then
    raise exception
      'Customer number was not found.'
      using errcode = 'P0002';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',
          a.id,
        'account_number',
          a.account_number,
        'account_type',
          a.account_type,
        'currency',
          a.currency,
        'status',
          a.status,
        'cached_balance_minor',
          a.cached_balance_minor,
        'zero_since',
          a.zero_since,
        'zeroed_by_full_withdrawal',
          a.zeroed_by_full_withdrawal,

        'charge_required',
          coalesce(
            (
              private.account_charge_requirement(a.id)
              ->> 'required'
            )::boolean,
            false
          ),

        'charge_reason',
          private.account_charge_requirement(a.id)
          ->> 'reason',

        'overdraft_limit_minor',
          private.active_overdraft_limit(a.id),

        'overdraft_used_minor',
          greatest(
            -a.cached_balance_minor,
            0
          ),

        'overdraft_available_minor',
          greatest(
            private.active_overdraft_limit(a.id) -
            greatest(-a.cached_balance_minor, 0),
            0
          ),

        'withdrawable_minor',
          private.account_available_to_withdraw(a.id),

        'overdraft_number',
          (
            select o.overdraft_number
            from public.overdrafts o
            where o.account_id = a.id
              and o.status =
                'active'::public.overdraft_status
              and (
                o.expiry_date is null
                or o.expiry_date >= current_date
              )
            order by o.approved_at desc nulls last
            limit 1
          )
      )
      order by a.created_at asc
    ),
    '[]'::jsonb
  )
  into v_accounts
  from public.accounts a
  where a.customer_id = v_customer.id;

  return jsonb_build_object(
    'customer',
      jsonb_build_object(
        'id',
          v_customer.id,
        'customer_number',
          v_customer.customer_number,
        'first_name',
          v_customer.first_name,
        'middle_name',
          v_customer.middle_name,
        'last_name',
          v_customer.last_name,
        'phone',
          v_customer.phone,
        'status',
          v_customer.status
      ),
    'accounts',
      v_accounts
  );
end;
$$;

-- ---------------------------------------------------------
-- 12. REPLACE TRANSACTION INITIATION
-- Withdrawals may use an ACTIVE, unexpired overdraft.
-- ---------------------------------------------------------

create or replace function public.initiate_transaction(
  p_account_id uuid,
  p_type public.transaction_type,
  p_amount_minor bigint,
  p_charge_minor bigint,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_account public.accounts;
  v_customer public.customers;
  v_transaction public.transactions;
  v_charge_requirement jsonb;
  v_charge_required boolean := false;
  v_charge_reason text := null;
  v_charge bigint := coalesce(p_charge_minor, 0);
  v_net bigint;
  v_overdraft_limit bigint := 0;
  v_available bigint := 0;
begin
  if v_actor_id is null
    or not private.can_initiate_transactions() then
    raise exception
      'You do not have permission to initiate transactions.'
      using errcode = '42501';
  end if;

  if p_type not in (
    'deposit'::public.transaction_type,
    'withdrawal'::public.transaction_type
  ) then
    raise exception
      'Only deposits and withdrawals can be initiated directly.'
      using errcode = '22023';
  end if;

  if p_amount_minor is null
    or p_amount_minor <= 0 then
    raise exception
      'Transaction amount must be greater than zero.'
      using errcode = '22023';
  end if;

  if v_charge < 0 then
    raise exception
      'Charge cannot be negative.'
      using errcode = '22023';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id = p_account_id;

  if not found then
    raise exception
      'Account not found.'
      using errcode = 'P0002';
  end if;

  if v_account.status <> 'active'::public.account_status then
    raise exception
      'Only active accounts can receive new transactions.'
      using errcode = '22023';
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id = v_account.customer_id;

  if v_customer.status <> 'active'::public.customer_status then
    raise exception
      'Only active customers can receive new transactions.'
      using errcode = '22023';
  end if;

  if p_type = 'deposit'::public.transaction_type then
    v_charge_requirement :=
      private.account_charge_requirement(
        v_account.id
      );

    v_charge_required :=
      coalesce(
        (
          v_charge_requirement
          ->> 'required'
        )::boolean,
        false
      );

    v_charge_reason :=
      v_charge_requirement
      ->> 'reason';

    if v_charge_required
      and v_charge <= 0 then
      raise exception
        'A deposit charge is mandatory. %',
        coalesce(
          v_charge_reason,
          'This account requires a charge.'
        )
        using errcode = '22023';
    end if;

    if v_charge >= p_amount_minor then
      raise exception
        'Deposit charge must be less than the gross deposit amount.'
        using errcode = '22023';
    end if;

    v_net :=
      p_amount_minor -
      v_charge;

  else
    if v_charge <> 0 then
      raise exception
        'Withdrawal charges are not enabled in this step.'
        using errcode = '22023';
    end if;

    v_overdraft_limit :=
      private.active_overdraft_limit(
        v_account.id
      );

    v_available :=
      greatest(
        v_account.cached_balance_minor +
        v_overdraft_limit,
        0
      );

    if v_available < p_amount_minor then
      raise exception
        'Insufficient available balance. Available for withdrawal is %.',
        v_available
        using errcode = '22003';
    end if;

    v_net :=
      p_amount_minor;
  end if;

  v_actor_name :=
    private.current_actor_name();

  insert into public.transactions (
    reference,
    customer_id,
    account_id,
    type,
    amount_minor,
    charge_minor,
    net_amount_minor,
    charge_required,
    charge_reason,
    status,
    description,
    initiated_by,
    initiated_by_name
  )
  values (
    private.next_transaction_reference(),
    v_customer.id,
    v_account.id,
    p_type,
    p_amount_minor,
    v_charge,
    v_net,
    v_charge_required,
    v_charge_reason,
    'pending'::public.transaction_status,
    nullif(
      btrim(coalesce(p_description, '')),
      ''
    ),
    v_actor_id,
    v_actor_name
  )
  returning *
  into v_transaction;

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
  values (
    v_actor_id,
    v_actor_name,
    private.current_actor_email(),
    'transaction.initiated',
    'transaction',
    v_transaction.id,
    'Initiated ' ||
      v_transaction.type::text ||
      ' ' ||
      v_transaction.reference ||
      '.',
    jsonb_build_object(
      'reference',
        v_transaction.reference,
      'customer_number',
        v_customer.customer_number,
      'account_number',
        v_account.account_number,
      'type',
        v_transaction.type,
      'gross_amount_minor',
        v_transaction.amount_minor,
      'charge_minor',
        v_transaction.charge_minor,
      'net_amount_minor',
        v_transaction.net_amount_minor,
      'charge_required',
        v_transaction.charge_required,
      'charge_reason',
        v_transaction.charge_reason,
      'overdraft_limit_minor',
        v_overdraft_limit,
      'available_before_minor',
        case
          when p_type =
            'withdrawal'::public.transaction_type
          then v_available
          else null
        end
    )
  );

  return to_jsonb(v_transaction);
end;
$$;

-- ---------------------------------------------------------
-- 13. REPLACE TRANSACTION APPROVAL
-- Withdrawal approval re-checks active overdraft under account lock.
-- ---------------------------------------------------------

create or replace function public.approve_transaction(
  p_transaction_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_role public.app_role;
  v_transaction public.transactions;
  v_original public.transactions;
  v_account public.accounts;
  v_customer public.customers;
  v_balance_before bigint;
  v_balance_after bigint;
  v_direction public.ledger_direction;
  v_delta bigint;
  v_posting_amount bigint;
  v_updated public.transactions;
  v_charge_requirement jsonb;
  v_charge_required_now boolean := false;
  v_charge_reason_now text := null;
  v_next_zero_since timestamptz;
  v_next_full_withdrawal boolean := false;
  v_overdraft_limit bigint := 0;
  v_available bigint := 0;
begin
  if v_actor_id is null
    or not private.can_approve_transactions() then
    raise exception
      'You do not have permission to approve transactions.'
      using errcode = '42501';
  end if;

  v_actor_role :=
    private.current_app_role();

  v_actor_name :=
    private.current_actor_name();

  select *
  into v_transaction
  from public.transactions t
  where t.id = p_transaction_id
  for update;

  if not found then
    raise exception
      'Transaction not found.'
      using errcode = 'P0002';
  end if;

  if v_transaction.status <>
    'pending'::public.transaction_status then
    raise exception
      'Only pending transactions can be approved.'
      using errcode = '22023';
  end if;

  if v_transaction.initiated_by =
    v_actor_id then
    raise exception
      'Maker-checker protection: you cannot approve your own transaction.'
      using errcode = '42501';
  end if;

  if v_transaction.type =
    'reversal'::public.transaction_type
    and v_actor_role not in (
      'super_admin'::public.app_role,
      'admin'::public.app_role
    ) then
    raise exception
      'Only an administrator can approve a reversal.'
      using errcode = '42501';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id =
    v_transaction.account_id
  for update;

  if not found then
    raise exception
      'Account not found.'
      using errcode = 'P0002';
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id =
    v_transaction.customer_id;

  v_balance_before :=
    v_account.cached_balance_minor;

  if v_transaction.type =
    'deposit'::public.transaction_type then

    if v_account.status <>
      'active'::public.account_status
      or v_customer.status <>
        'active'::public.customer_status then
      raise exception
        'The customer and account must both be active before approval.'
        using errcode = '22023';
    end if;

    v_charge_requirement :=
      private.account_charge_requirement(
        v_account.id
      );

    v_charge_required_now :=
      coalesce(
        (
          v_charge_requirement
          ->> 'required'
        )::boolean,
        false
      );

    v_charge_reason_now :=
      v_charge_requirement
      ->> 'reason';

    if v_charge_required_now
      and v_transaction.charge_minor <= 0 then
      raise exception
        'This deposit now requires a charge before it can be approved. Reject it and create a new deposit with a charge. %',
        coalesce(
          v_charge_reason_now,
          ''
        )
        using errcode = '22023';
    end if;

    if v_transaction.charge_minor >=
      v_transaction.amount_minor then
      raise exception
        'Deposit charge must be less than the gross deposit amount.'
        using errcode = '22023';
    end if;

    v_posting_amount :=
      v_transaction.amount_minor -
      v_transaction.charge_minor;

    if v_posting_amount <= 0 then
      raise exception
        'Net deposit amount must be greater than zero.'
        using errcode = '22023';
    end if;

    v_delta :=
      v_posting_amount;

    v_direction :=
      'credit'::public.ledger_direction;

  elsif v_transaction.type =
    'withdrawal'::public.transaction_type then

    if v_account.status <>
      'active'::public.account_status
      or v_customer.status <>
        'active'::public.customer_status then
      raise exception
        'The customer and account must both be active before approval.'
        using errcode = '22023';
    end if;

    v_overdraft_limit :=
      private.active_overdraft_limit(
        v_account.id
      );

    v_available :=
      greatest(
        v_balance_before +
        v_overdraft_limit,
        0
      );

    if v_available <
      v_transaction.amount_minor then
      raise exception
        'Insufficient available balance at approval time.'
        using errcode = '22003';
    end if;

    v_posting_amount :=
      v_transaction.amount_minor;

    v_delta :=
      -v_posting_amount;

    v_direction :=
      'debit'::public.ledger_direction;

  else
    select *
    into v_original
    from public.transactions t
    where t.id =
      v_transaction.reversal_of
    for update;

    if not found then
      raise exception
        'Original transaction for this reversal was not found.'
        using errcode = 'P0002';
    end if;

    if v_original.status <>
      'approved'::public.transaction_status
      or v_original.reversed_by_transaction_id
        is not null then
      raise exception
        'The original transaction is no longer eligible for reversal.'
        using errcode = '22023';
    end if;

    if v_original.type =
      'deposit'::public.transaction_type then

      v_posting_amount :=
        v_original.net_amount_minor;

      if v_balance_before <
        v_posting_amount then
        raise exception
          'The deposit cannot be reversed because the account no longer has sufficient funds.'
          using errcode = '22003';
      end if;

      v_delta :=
        -v_posting_amount;

      v_direction :=
        'debit'::public.ledger_direction;

    elsif v_original.type =
      'withdrawal'::public.transaction_type then

      v_posting_amount :=
        v_original.net_amount_minor;

      v_delta :=
        v_posting_amount;

      v_direction :=
        'credit'::public.ledger_direction;

    else
      raise exception
        'Unsupported original transaction type for reversal.'
        using errcode = '22023';
    end if;
  end if;

  v_balance_after :=
    v_balance_before +
    v_delta;

  if v_balance_after = 0 then
    if v_transaction.type =
      'withdrawal'::public.transaction_type then

      v_next_zero_since :=
        now();

      v_next_full_withdrawal :=
        true;

    elsif v_transaction.type =
      'reversal'::public.transaction_type
      and v_original.type =
        'deposit'::public.transaction_type then

      v_next_zero_since :=
        now();

      v_next_full_withdrawal :=
        false;

    else
      v_next_zero_since :=
        coalesce(
          v_account.zero_since,
          now()
        );

      v_next_full_withdrawal :=
        false;
    end if;
  else
    v_next_zero_since :=
      null;

    v_next_full_withdrawal :=
      false;
  end if;

  update public.accounts
  set
    cached_balance_minor =
      v_balance_after,
    zero_since =
      v_next_zero_since,
    zeroed_by_full_withdrawal =
      v_next_full_withdrawal,
    updated_at =
      now()
  where id =
    v_account.id;

  insert into public.ledger_entries (
    transaction_id,
    account_id,
    direction,
    amount_minor,
    balance_before_minor,
    balance_after_minor,
    posted_by
  )
  values (
    v_transaction.id,
    v_account.id,
    v_direction,
    v_posting_amount,
    v_balance_before,
    v_balance_after,
    v_actor_id
  );

  update public.transactions
  set
    status =
      'approved'::public.transaction_status,

    net_amount_minor =
      v_posting_amount,

    charge_required =
      case
        when type =
          'deposit'::public.transaction_type
        then v_charge_required_now
        else charge_required
      end,

    charge_reason =
      case
        when type =
          'deposit'::public.transaction_type
        then coalesce(
          v_charge_reason_now,
          charge_reason
        )
        else charge_reason
      end,

    reviewed_by =
      v_actor_id,

    reviewed_by_name =
      v_actor_name,

    reviewed_at =
      now()

  where id =
    v_transaction.id

  returning *
  into v_updated;

  if v_transaction.type =
    'reversal'::public.transaction_type then

    update public.transactions
    set
      status =
        'reversed'::public.transaction_status,

      reversed_by_transaction_id =
        v_transaction.id

    where id =
      v_original.id;
  end if;

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
  values (
    v_actor_id,
    v_actor_name,
    private.current_actor_email(),

    case
      when v_transaction.type =
        'reversal'::public.transaction_type
      then
        'transaction.reversal_approved'
      else
        'transaction.approved'
    end,

    'transaction',
    v_updated.id,

    'Approved ' ||
      v_updated.type::text ||
      ' ' ||
      v_updated.reference ||
      '.',

    jsonb_build_object(
      'reference',
        v_updated.reference,
      'type',
        v_updated.type,
      'gross_amount_minor',
        v_updated.amount_minor,
      'charge_minor',
        v_updated.charge_minor,
      'net_posting_minor',
        v_posting_amount,
      'balance_before_minor',
        v_balance_before,
      'balance_after_minor',
        v_balance_after,
      'charge_required',
        v_updated.charge_required,
      'charge_reason',
        v_updated.charge_reason,
      'original_transaction_id',
        v_updated.reversal_of,
      'overdraft_limit_minor',
        v_overdraft_limit,
      'available_before_minor',
        case
          when v_transaction.type =
            'withdrawal'::public.transaction_type
          then v_available
          else null
        end
    )
  );

  return jsonb_build_object(
    'transaction',
      to_jsonb(v_updated),
    'gross_amount_minor',
      v_updated.amount_minor,
    'charge_minor',
      v_updated.charge_minor,
    'net_posting_minor',
      v_posting_amount,
    'balance_before_minor',
      v_balance_before,
    'balance_after_minor',
      v_balance_after,
    'overdraft_limit_minor',
      v_overdraft_limit
  );
end;
$$;

-- ---------------------------------------------------------
-- 14. SUMMARY
-- ---------------------------------------------------------

create or replace function public.get_overdraft_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_active_user() then
      jsonb_build_object(
        'pending_count',
          (
            select count(*)
            from public.overdrafts o
            where o.status =
              'pending'::public.overdraft_status
          ),

        'active_count',
          (
            select count(*)
            from public.overdrafts o
            where o.status =
              'active'::public.overdraft_status
              and (
                o.expiry_date is null
                or o.expiry_date >= current_date
              )
          ),

        'active_limits_minor',
          (
            select coalesce(
              sum(o.limit_minor),
              0
            )
            from public.overdrafts o
            where o.status =
              'active'::public.overdraft_status
              and (
                o.expiry_date is null
                or o.expiry_date >= current_date
              )
          ),

        'used_minor',
          (
            select coalesce(
              sum(
                greatest(
                  -a.cached_balance_minor,
                  0
                )
              ),
              0
            )
            from public.overdrafts o
            join public.accounts a
              on a.id = o.account_id
            where o.status =
              'active'::public.overdraft_status
              and (
                o.expiry_date is null
                or o.expiry_date >= current_date
              )
          ),

        'expired_count',
          (
            select count(*)
            from public.overdrafts o
            where o.status =
              'active'::public.overdraft_status
              and o.expiry_date is not null
              and o.expiry_date < current_date
          )
      )
    else null
  end;
$$;

-- ---------------------------------------------------------
-- 15. PRIVILEGES
-- ---------------------------------------------------------

revoke execute on function public.request_overdraft(
  uuid,
  bigint,
  date,
  text
) from public, anon;

grant execute on function public.request_overdraft(
  uuid,
  bigint,
  date,
  text
) to authenticated;

revoke execute on function public.approve_overdraft(uuid)
from public, anon;

grant execute on function public.approve_overdraft(uuid)
to authenticated;

revoke execute on function public.reject_overdraft(
  uuid,
  text
) from public, anon;

grant execute on function public.reject_overdraft(
  uuid,
  text
) to authenticated;

revoke execute on function public.close_overdraft(
  uuid,
  text
) from public, anon;

grant execute on function public.close_overdraft(
  uuid,
  text
) to authenticated;

revoke execute on function public.get_overdraft_summary()
from public, anon;

grant execute on function public.get_overdraft_summary()
to authenticated;

commit;
