-- =========================================================
-- FINTECH REBUILD - STEP 5
-- Loans + approval/disbursement + repayments
--
-- Run AFTER:
--   007_financial_ledger_transactions.sql
--   008_customer_search_deposit_charges.sql
--
-- Loan model in this step:
-- - Flat interest rate entered at application time.
-- - Staff creates a pending loan application.
-- - Another manager/admin/super-admin approves.
-- - Approval atomically credits principal to the selected customer
--   account and posts an immutable customer-account ledger entry.
-- - Repayments are cash/bank-transfer/other external repayments.
--   They reduce the loan receivable but DO NOT debit the customer's
--   savings/current/business account.
-- - Repayments are also maker-checker.
-- =========================================================

-- ---------------------------------------------------------
-- 0. EXTEND TRANSACTION TYPES
-- These enum values are committed before they are used below.
-- ---------------------------------------------------------

alter type public.transaction_type
  add value if not exists 'loan_disbursement';

alter type public.transaction_type
  add value if not exists 'loan_repayment';

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
    where t.typname = 'loan_status'
      and n.nspname = 'public'
  ) then
    create type public.loan_status as enum (
      'pending',
      'active',
      'rejected',
      'paid',
      'defaulted'
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
    where t.typname = 'loan_repayment_status'
      and n.nspname = 'public'
  ) then
    create type public.loan_repayment_status as enum (
      'pending',
      'approved',
      'rejected'
    );
  end if;
end
$$;

-- ---------------------------------------------------------
-- 2. NUMBER SEQUENCES
-- ---------------------------------------------------------

create sequence if not exists public.loan_number_seq
  start with 1
  increment by 1;

create sequence if not exists public.loan_repayment_number_seq
  start with 1
  increment by 1;

revoke all on sequence public.loan_number_seq
from anon, authenticated;

revoke all on sequence public.loan_repayment_number_seq
from anon, authenticated;

-- ---------------------------------------------------------
-- 3. TABLES
-- ---------------------------------------------------------

create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  loan_number text not null unique,

  customer_id uuid not null
    references public.customers(id)
    on delete restrict,

  account_id uuid not null
    references public.accounts(id)
    on delete restrict,

  principal_minor bigint not null,
  interest_rate_bps integer not null,
  interest_minor bigint not null,
  total_payable_minor bigint not null,

  principal_outstanding_minor bigint not null,
  interest_outstanding_minor bigint not null,

  term_months integer not null,
  due_date date,
  purpose text,

  status public.loan_status not null default 'pending',

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

  paid_at timestamptz,

  disbursement_transaction_id uuid
    references public.transactions(id)
    on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint loans_principal_positive
    check (principal_minor > 0),

  constraint loans_interest_rate_nonnegative
    check (interest_rate_bps >= 0),

  constraint loans_interest_nonnegative
    check (interest_minor >= 0),

  constraint loans_total_consistent
    check (total_payable_minor = principal_minor + interest_minor),

  constraint loans_principal_outstanding_valid
    check (
      principal_outstanding_minor >= 0
      and principal_outstanding_minor <= principal_minor
    ),

  constraint loans_interest_outstanding_valid
    check (
      interest_outstanding_minor >= 0
      and interest_outstanding_minor <= interest_minor
    ),

  constraint loans_term_positive
    check (term_months between 1 and 120)
);

create table if not exists public.loan_repayments (
  id uuid primary key default gen_random_uuid(),
  repayment_number text not null unique,

  loan_id uuid not null
    references public.loans(id)
    on delete restrict,

  amount_minor bigint not null,

  interest_component_minor bigint not null default 0,
  principal_component_minor bigint not null default 0,

  payment_method text not null default 'cash',
  external_reference text,
  notes text,

  status public.loan_repayment_status not null default 'pending',

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

  transaction_id uuid
    references public.transactions(id)
    on delete restrict,

  created_at timestamptz not null default now(),

  constraint loan_repayments_amount_positive
    check (amount_minor > 0),

  constraint loan_repayments_components_nonnegative
    check (
      interest_component_minor >= 0
      and principal_component_minor >= 0
    ),

  constraint loan_repayments_payment_method_check
    check (payment_method in ('cash', 'bank_transfer', 'other'))
);

create index if not exists loans_customer_id_idx
  on public.loans(customer_id);

create index if not exists loans_account_id_idx
  on public.loans(account_id);

create index if not exists loans_status_requested_at_idx
  on public.loans(status, requested_at desc);

create index if not exists loans_requested_by_idx
  on public.loans(requested_by);

create index if not exists loans_due_date_idx
  on public.loans(due_date)
  where status = 'active'::public.loan_status;

create index if not exists loan_repayments_loan_id_requested_at_idx
  on public.loan_repayments(loan_id, requested_at desc);

create index if not exists loan_repayments_status_requested_at_idx
  on public.loan_repayments(status, requested_at desc);

-- ---------------------------------------------------------
-- 4. AUTHORIZATION HELPERS
-- ---------------------------------------------------------

create or replace function private.can_request_loans()
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

create or replace function private.can_approve_loans()
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

revoke all on function private.can_request_loans()
from public;

revoke all on function private.can_approve_loans()
from public;

grant execute on function private.can_request_loans()
to authenticated;

grant execute on function private.can_approve_loans()
to authenticated;

-- ---------------------------------------------------------
-- 5. INTERNAL NUMBER HELPERS
-- ---------------------------------------------------------

create or replace function private.next_loan_number()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'LN' ||
    lpad(
      nextval('public.loan_number_seq')::text,
      6,
      '0'
    );
$$;

create or replace function private.next_loan_repayment_number()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'RP' ||
    lpad(
      nextval('public.loan_repayment_number_seq')::text,
      7,
      '0'
    );
$$;

revoke all on function private.next_loan_number()
from public;

revoke all on function private.next_loan_repayment_number()
from public;

-- ---------------------------------------------------------
-- 6. RLS + TABLE PRIVILEGES
-- ---------------------------------------------------------

alter table public.loans enable row level security;
alter table public.loan_repayments enable row level security;

revoke all on table public.loans
from anon, authenticated;

revoke all on table public.loan_repayments
from anon, authenticated;

grant select on table public.loans
to authenticated;

grant select on table public.loan_repayments
to authenticated;

drop policy if exists
  "active staff can view loans"
on public.loans;

create policy
  "active staff can view loans"
on public.loans
for select
to authenticated
using ((select private.is_active_user()));

drop policy if exists
  "active staff can view loan repayments"
on public.loan_repayments;

create policy
  "active staff can view loan repayments"
on public.loan_repayments
for select
to authenticated
using ((select private.is_active_user()));

-- ---------------------------------------------------------
-- 7. DIRECTORY VIEWS
-- ---------------------------------------------------------

create or replace view public.loan_directory
with (security_invoker = true)
as
select
  l.id,
  l.loan_number,
  l.principal_minor,
  l.interest_rate_bps,
  l.interest_minor,
  l.total_payable_minor,
  l.principal_outstanding_minor,
  l.interest_outstanding_minor,
  (
    l.principal_outstanding_minor +
    l.interest_outstanding_minor
  ) as outstanding_minor,
  l.term_months,
  l.due_date,
  l.purpose,
  l.status,

  l.requested_by,
  l.requested_by_name,
  l.requested_at,

  l.approved_by,
  l.approved_by_name,
  l.approved_at,

  l.rejected_by,
  l.rejected_by_name,
  l.rejected_at,
  l.rejection_reason,

  l.paid_at,
  l.disbursement_transaction_id,
  l.created_at,
  l.updated_at,

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

  case
    when l.status = 'active'::public.loan_status
      and l.due_date is not null
      and l.due_date < current_date
      then true
    else false
  end as overdue

from public.loans l
join public.customers c
  on c.id = l.customer_id
join public.accounts a
  on a.id = l.account_id;

revoke all on table public.loan_directory
from anon, authenticated;

grant select on table public.loan_directory
to authenticated;

create or replace view public.loan_repayment_directory
with (security_invoker = true)
as
select
  r.id,
  r.repayment_number,
  r.loan_id,
  l.loan_number,

  r.amount_minor,
  r.interest_component_minor,
  r.principal_component_minor,

  r.payment_method,
  r.external_reference,
  r.notes,
  r.status,

  r.requested_by,
  r.requested_by_name,
  r.requested_at,

  r.approved_by,
  r.approved_by_name,
  r.approved_at,

  r.rejected_by,
  r.rejected_by_name,
  r.rejected_at,
  r.rejection_reason,

  r.transaction_id,
  r.created_at,

  c.customer_number,
  concat_ws(
    ' ',
    c.first_name,
    nullif(c.middle_name, ''),
    c.last_name
  ) as customer_name

from public.loan_repayments r
join public.loans l
  on l.id = r.loan_id
join public.customers c
  on c.id = l.customer_id;

revoke all on table public.loan_repayment_directory
from anon, authenticated;

grant select on table public.loan_repayment_directory
to authenticated;

-- ---------------------------------------------------------
-- 8. REQUEST LOAN
-- Flat interest:
-- interest = principal × interest_rate_bps / 10,000
-- ---------------------------------------------------------

create or replace function public.request_loan(
  p_account_id uuid,
  p_principal_minor bigint,
  p_interest_rate_bps integer,
  p_term_months integer,
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
  v_interest bigint;
  v_total bigint;
  v_loan public.loans;
begin
  if v_actor_id is null
    or not private.can_request_loans() then
    raise exception
      'You do not have permission to create loan applications.'
      using errcode = '42501';
  end if;

  if p_principal_minor is null
    or p_principal_minor <= 0 then
    raise exception
      'Loan principal must be greater than zero.'
      using errcode = '22023';
  end if;

  if p_interest_rate_bps is null
    or p_interest_rate_bps < 0 then
    raise exception
      'Interest rate cannot be negative.'
      using errcode = '22023';
  end if;

  if p_term_months is null
    or p_term_months < 1
    or p_term_months > 120 then
    raise exception
      'Loan term must be between 1 and 120 months.'
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

  -- Nearest-kobo rounding for a positive flat-rate calculation.
  v_interest :=
    (
      (p_principal_minor * p_interest_rate_bps) + 5000
    ) / 10000;

  v_total :=
    p_principal_minor +
    v_interest;

  v_actor_name := private.current_actor_name();

  insert into public.loans (
    loan_number,
    customer_id,
    account_id,
    principal_minor,
    interest_rate_bps,
    interest_minor,
    total_payable_minor,
    principal_outstanding_minor,
    interest_outstanding_minor,
    term_months,
    purpose,
    status,
    requested_by,
    requested_by_name
  )
  values (
    private.next_loan_number(),
    v_customer.id,
    v_account.id,
    p_principal_minor,
    p_interest_rate_bps,
    v_interest,
    v_total,
    p_principal_minor,
    v_interest,
    p_term_months,
    nullif(btrim(coalesce(p_purpose, '')), ''),
    'pending'::public.loan_status,
    v_actor_id,
    v_actor_name
  )
  returning *
  into v_loan;

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
    'loan.requested',
    'loan',
    v_loan.id,
    'Created loan application ' ||
      v_loan.loan_number || '.',
    jsonb_build_object(
      'loan_number',
        v_loan.loan_number,
      'customer_number',
        v_customer.customer_number,
      'account_number',
        v_account.account_number,
      'principal_minor',
        v_loan.principal_minor,
      'interest_rate_bps',
        v_loan.interest_rate_bps,
      'interest_minor',
        v_loan.interest_minor,
      'total_payable_minor',
        v_loan.total_payable_minor,
      'term_months',
        v_loan.term_months
    )
  );

  return to_jsonb(v_loan);
end;
$$;

-- ---------------------------------------------------------
-- 9. APPROVE + DISBURSE LOAN ATOMICALLY
-- ---------------------------------------------------------

create or replace function public.approve_loan(
  p_loan_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_loan public.loans;
  v_account public.accounts;
  v_customer public.customers;
  v_transaction public.transactions;
  v_balance_before bigint;
  v_balance_after bigint;
  v_due_date date;
  v_updated public.loans;
begin
  if v_actor_id is null
    or not private.can_approve_loans() then
    raise exception
      'You do not have permission to approve loans.'
      using errcode = '42501';
  end if;

  v_actor_name := private.current_actor_name();

  select *
  into v_loan
  from public.loans l
  where l.id = p_loan_id
  for update;

  if not found then
    raise exception
      'Loan application not found.'
      using errcode = 'P0002';
  end if;

  if v_loan.status <> 'pending'::public.loan_status then
    raise exception
      'Only pending loan applications can be approved.'
      using errcode = '22023';
  end if;

  if v_loan.requested_by = v_actor_id then
    raise exception
      'Maker-checker protection: you cannot approve your own loan application.'
      using errcode = '42501';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id = v_loan.account_id
  for update;

  if not found then
    raise exception
      'Loan account not found.'
      using errcode = 'P0002';
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id = v_loan.customer_id;

  if v_account.status <> 'active'::public.account_status
    or v_customer.status <> 'active'::public.customer_status then
    raise exception
      'The customer and account must both be active before loan approval.'
      using errcode = '22023';
  end if;

  v_balance_before :=
    v_account.cached_balance_minor;

  v_balance_after :=
    v_balance_before +
    v_loan.principal_minor;

  v_due_date :=
    (
      current_date +
      make_interval(months => v_loan.term_months)
    )::date;

  -- The disbursement is an approved customer-account transaction.
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
    initiated_by_name,
    reviewed_by,
    reviewed_by_name,
    reviewed_at
  )
  values (
    private.next_transaction_reference(),
    v_loan.customer_id,
    v_loan.account_id,
    'loan_disbursement'::public.transaction_type,
    v_loan.principal_minor,
    0,
    v_loan.principal_minor,
    false,
    null,
    'approved'::public.transaction_status,
    'Loan disbursement ' || v_loan.loan_number,
    v_loan.requested_by,
    v_loan.requested_by_name,
    v_actor_id,
    v_actor_name,
    now()
  )
  returning *
  into v_transaction;

  update public.accounts
  set
    cached_balance_minor = v_balance_after,
    zero_since = null,
    zeroed_by_full_withdrawal = false,
    updated_at = now()
  where id = v_account.id;

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
    'credit'::public.ledger_direction,
    v_loan.principal_minor,
    v_balance_before,
    v_balance_after,
    v_actor_id
  );

  update public.loans
  set
    status = 'active'::public.loan_status,
    approved_by = v_actor_id,
    approved_by_name = v_actor_name,
    approved_at = now(),
    due_date = v_due_date,
    disbursement_transaction_id = v_transaction.id,
    updated_at = now()
  where id = v_loan.id
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
    'loan.approved',
    'loan',
    v_updated.id,
    'Approved and disbursed loan ' ||
      v_updated.loan_number || '.',
    jsonb_build_object(
      'loan_number',
        v_updated.loan_number,
      'principal_minor',
        v_updated.principal_minor,
      'interest_minor',
        v_updated.interest_minor,
      'total_payable_minor',
        v_updated.total_payable_minor,
      'due_date',
        v_updated.due_date,
      'transaction_reference',
        v_transaction.reference,
      'balance_before_minor',
        v_balance_before,
      'balance_after_minor',
        v_balance_after
    )
  );

  return jsonb_build_object(
    'loan',
      to_jsonb(v_updated),
    'disbursement_transaction',
      to_jsonb(v_transaction),
    'balance_before_minor',
      v_balance_before,
    'balance_after_minor',
      v_balance_after
  );
end;
$$;

-- ---------------------------------------------------------
-- 10. REJECT LOAN APPLICATION
-- ---------------------------------------------------------

create or replace function public.reject_loan(
  p_loan_id uuid,
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
  v_loan public.loans;
  v_reason text :=
    nullif(btrim(coalesce(p_reason, '')), '');
  v_updated public.loans;
begin
  if v_actor_id is null
    or not private.can_approve_loans() then
    raise exception
      'You do not have permission to reject loans.'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception
      'A rejection reason is required.'
      using errcode = '22023';
  end if;

  v_actor_name := private.current_actor_name();

  select *
  into v_loan
  from public.loans l
  where l.id = p_loan_id
  for update;

  if not found then
    raise exception
      'Loan application not found.'
      using errcode = 'P0002';
  end if;

  if v_loan.status <> 'pending'::public.loan_status then
    raise exception
      'Only pending loan applications can be rejected.'
      using errcode = '22023';
  end if;

  if v_loan.requested_by = v_actor_id then
    raise exception
      'Maker-checker protection: you cannot reject your own loan application.'
      using errcode = '42501';
  end if;

  update public.loans
  set
    status = 'rejected'::public.loan_status,
    rejected_by = v_actor_id,
    rejected_by_name = v_actor_name,
    rejected_at = now(),
    rejection_reason = v_reason,
    updated_at = now()
  where id = v_loan.id
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
    'loan.rejected',
    'loan',
    v_updated.id,
    'Rejected loan application ' ||
      v_updated.loan_number || '.',
    jsonb_build_object(
      'loan_number',
        v_updated.loan_number,
      'reason',
        v_reason
    )
  );

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 11. REQUEST LOAN REPAYMENT
-- External repayment: does not alter customer deposit balance.
-- ---------------------------------------------------------

create or replace function public.request_loan_repayment(
  p_loan_id uuid,
  p_amount_minor bigint,
  p_payment_method text,
  p_external_reference text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_loan public.loans;
  v_outstanding bigint;
  v_pending bigint;
  v_available bigint;
  v_method text :=
    lower(btrim(coalesce(p_payment_method, '')));
  v_repayment public.loan_repayments;
begin
  if v_actor_id is null
    or not private.can_request_loans() then
    raise exception
      'You do not have permission to record loan repayments.'
      using errcode = '42501';
  end if;

  if p_amount_minor is null
    or p_amount_minor <= 0 then
    raise exception
      'Repayment amount must be greater than zero.'
      using errcode = '22023';
  end if;

  if v_method not in (
    'cash',
    'bank_transfer',
    'other'
  ) then
    raise exception
      'Invalid repayment method.'
      using errcode = '22023';
  end if;

  select *
  into v_loan
  from public.loans l
  where l.id = p_loan_id
  for update;

  if not found then
    raise exception
      'Loan not found.'
      using errcode = 'P0002';
  end if;

  if v_loan.status <> 'active'::public.loan_status then
    raise exception
      'Repayments can only be recorded for active loans.'
      using errcode = '22023';
  end if;

  v_outstanding :=
    v_loan.principal_outstanding_minor +
    v_loan.interest_outstanding_minor;

  select coalesce(sum(r.amount_minor), 0)
  into v_pending
  from public.loan_repayments r
  where r.loan_id = v_loan.id
    and r.status = 'pending'::public.loan_repayment_status;

  v_available :=
    v_outstanding -
    v_pending;

  if p_amount_minor > v_available then
    raise exception
      'Repayment exceeds the remaining amount available after pending repayments.'
      using errcode = '22003';
  end if;

  v_actor_name :=
    private.current_actor_name();

  insert into public.loan_repayments (
    repayment_number,
    loan_id,
    amount_minor,
    payment_method,
    external_reference,
    notes,
    status,
    requested_by,
    requested_by_name
  )
  values (
    private.next_loan_repayment_number(),
    v_loan.id,
    p_amount_minor,
    v_method,
    nullif(
      btrim(coalesce(p_external_reference, '')),
      ''
    ),
    nullif(
      btrim(coalesce(p_notes, '')),
      ''
    ),
    'pending'::public.loan_repayment_status,
    v_actor_id,
    v_actor_name
  )
  returning *
  into v_repayment;

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
    'loan.repayment_requested',
    'loan_repayment',
    v_repayment.id,
    'Recorded pending repayment ' ||
      v_repayment.repayment_number ||
      ' for loan ' ||
      v_loan.loan_number || '.',
    jsonb_build_object(
      'loan_number',
        v_loan.loan_number,
      'repayment_number',
        v_repayment.repayment_number,
      'amount_minor',
        v_repayment.amount_minor,
      'payment_method',
        v_repayment.payment_method
    )
  );

  return to_jsonb(v_repayment);
end;
$$;

-- ---------------------------------------------------------
-- 12. APPROVE REPAYMENT
-- Allocation rule: interest first, then principal.
-- ---------------------------------------------------------

create or replace function public.approve_loan_repayment(
  p_repayment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_repayment public.loan_repayments;
  v_loan public.loans;
  v_outstanding bigint;
  v_interest_component bigint;
  v_principal_component bigint;
  v_new_interest bigint;
  v_new_principal bigint;
  v_new_status public.loan_status;
  v_transaction public.transactions;
  v_updated_repayment public.loan_repayments;
  v_updated_loan public.loans;
begin
  if v_actor_id is null
    or not private.can_approve_loans() then
    raise exception
      'You do not have permission to approve loan repayments.'
      using errcode = '42501';
  end if;

  v_actor_name :=
    private.current_actor_name();

  select *
  into v_repayment
  from public.loan_repayments r
  where r.id = p_repayment_id
  for update;

  if not found then
    raise exception
      'Loan repayment not found.'
      using errcode = 'P0002';
  end if;

  if v_repayment.status <>
    'pending'::public.loan_repayment_status then
    raise exception
      'Only pending repayments can be approved.'
      using errcode = '22023';
  end if;

  if v_repayment.requested_by = v_actor_id then
    raise exception
      'Maker-checker protection: you cannot approve your own repayment.'
      using errcode = '42501';
  end if;

  select *
  into v_loan
  from public.loans l
  where l.id = v_repayment.loan_id
  for update;

  if not found then
    raise exception
      'Loan not found.'
      using errcode = 'P0002';
  end if;

  if v_loan.status <>
    'active'::public.loan_status then
    raise exception
      'This loan is no longer active.'
      using errcode = '22023';
  end if;

  v_outstanding :=
    v_loan.principal_outstanding_minor +
    v_loan.interest_outstanding_minor;

  if v_repayment.amount_minor > v_outstanding then
    raise exception
      'Repayment is greater than the current outstanding balance.'
      using errcode = '22003';
  end if;

  v_interest_component :=
    least(
      v_repayment.amount_minor,
      v_loan.interest_outstanding_minor
    );

  v_principal_component :=
    v_repayment.amount_minor -
    v_interest_component;

  v_new_interest :=
    v_loan.interest_outstanding_minor -
    v_interest_component;

  v_new_principal :=
    v_loan.principal_outstanding_minor -
    v_principal_component;

  if v_new_interest = 0
    and v_new_principal = 0 then
    v_new_status :=
      'paid'::public.loan_status;
  else
    v_new_status :=
      'active'::public.loan_status;
  end if;

  update public.loan_repayments
  set
    status =
      'approved'::public.loan_repayment_status,
    interest_component_minor =
      v_interest_component,
    principal_component_minor =
      v_principal_component,
    approved_by =
      v_actor_id,
    approved_by_name =
      v_actor_name,
    approved_at =
      now()
  where id = v_repayment.id
  returning *
  into v_updated_repayment;

  update public.loans
  set
    interest_outstanding_minor =
      v_new_interest,
    principal_outstanding_minor =
      v_new_principal,
    status =
      v_new_status,
    paid_at =
      case
        when v_new_status =
          'paid'::public.loan_status
          then now()
        else paid_at
      end,
    updated_at =
      now()
  where id = v_loan.id
  returning *
  into v_updated_loan;

  -- An external loan repayment is recorded in the transaction
  -- register for traceability, but intentionally has NO customer
  -- deposit-account ledger entry.
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
    initiated_by_name,
    reviewed_by,
    reviewed_by_name,
    reviewed_at
  )
  values (
    private.next_transaction_reference(),
    v_loan.customer_id,
    v_loan.account_id,
    'loan_repayment'::public.transaction_type,
    v_repayment.amount_minor,
    0,
    v_repayment.amount_minor,
    false,
    null,
    'approved'::public.transaction_status,
    'Loan repayment ' ||
      v_repayment.repayment_number ||
      ' for ' ||
      v_loan.loan_number,
    v_repayment.requested_by,
    v_repayment.requested_by_name,
    v_actor_id,
    v_actor_name,
    now()
  )
  returning *
  into v_transaction;

  update public.loan_repayments
  set transaction_id =
    v_transaction.id
  where id =
    v_repayment.id
  returning *
  into v_updated_repayment;

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
    'loan.repayment_approved',
    'loan_repayment',
    v_updated_repayment.id,
    'Approved repayment ' ||
      v_updated_repayment.repayment_number ||
      ' for loan ' ||
      v_updated_loan.loan_number || '.',
    jsonb_build_object(
      'loan_number',
        v_updated_loan.loan_number,
      'repayment_number',
        v_updated_repayment.repayment_number,
      'amount_minor',
        v_updated_repayment.amount_minor,
      'interest_component_minor',
        v_interest_component,
      'principal_component_minor',
        v_principal_component,
      'principal_outstanding_minor',
        v_updated_loan.principal_outstanding_minor,
      'interest_outstanding_minor',
        v_updated_loan.interest_outstanding_minor,
      'loan_status',
        v_updated_loan.status,
      'transaction_reference',
        v_transaction.reference
    )
  );

  return jsonb_build_object(
    'repayment',
      to_jsonb(v_updated_repayment),
    'loan',
      to_jsonb(v_updated_loan),
    'transaction',
      to_jsonb(v_transaction)
  );
end;
$$;

-- ---------------------------------------------------------
-- 13. REJECT REPAYMENT
-- ---------------------------------------------------------

create or replace function public.reject_loan_repayment(
  p_repayment_id uuid,
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
  v_repayment public.loan_repayments;
  v_loan public.loans;
  v_reason text :=
    nullif(btrim(coalesce(p_reason, '')), '');
  v_updated public.loan_repayments;
begin
  if v_actor_id is null
    or not private.can_approve_loans() then
    raise exception
      'You do not have permission to reject loan repayments.'
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
  into v_repayment
  from public.loan_repayments r
  where r.id = p_repayment_id
  for update;

  if not found then
    raise exception
      'Loan repayment not found.'
      using errcode = 'P0002';
  end if;

  if v_repayment.status <>
    'pending'::public.loan_repayment_status then
    raise exception
      'Only pending repayments can be rejected.'
      using errcode = '22023';
  end if;

  if v_repayment.requested_by = v_actor_id then
    raise exception
      'Maker-checker protection: you cannot reject your own repayment.'
      using errcode = '42501';
  end if;

  select *
  into v_loan
  from public.loans l
  where l.id = v_repayment.loan_id;

  update public.loan_repayments
  set
    status =
      'rejected'::public.loan_repayment_status,
    rejected_by =
      v_actor_id,
    rejected_by_name =
      v_actor_name,
    rejected_at =
      now(),
    rejection_reason =
      v_reason
  where id =
    v_repayment.id
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
    'loan.repayment_rejected',
    'loan_repayment',
    v_updated.id,
    'Rejected repayment ' ||
      v_updated.repayment_number ||
      ' for loan ' ||
      coalesce(v_loan.loan_number, '') || '.',
    jsonb_build_object(
      'repayment_number',
        v_updated.repayment_number,
      'loan_number',
        v_loan.loan_number,
      'reason',
        v_reason
    )
  );

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 14. LOAN SUMMARY
-- ---------------------------------------------------------

create or replace function public.get_loan_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_active_user() then
      jsonb_build_object(
        'pending_loans',
          (
            select count(*)
            from public.loans l
            where l.status =
              'pending'::public.loan_status
          ),

        'active_loans',
          (
            select count(*)
            from public.loans l
            where l.status =
              'active'::public.loan_status
          ),

        'outstanding_minor',
          (
            select coalesce(
              sum(
                l.principal_outstanding_minor +
                l.interest_outstanding_minor
              ),
              0
            )
            from public.loans l
            where l.status =
              'active'::public.loan_status
          ),

        'repayments_today_minor',
          (
            select coalesce(
              sum(r.amount_minor),
              0
            )
            from public.loan_repayments r
            where r.status =
              'approved'::public.loan_repayment_status
              and r.approved_at >=
                date_trunc('day', now())
          ),

        'overdue_loans',
          (
            select count(*)
            from public.loans l
            where l.status =
              'active'::public.loan_status
              and l.due_date is not null
              and l.due_date < current_date
          )
      )
    else null
  end;
$$;

-- ---------------------------------------------------------
-- 15. FUNCTION PRIVILEGES
-- ---------------------------------------------------------

revoke execute on function public.request_loan(
  uuid,
  bigint,
  integer,
  integer,
  text
) from public, anon;

grant execute on function public.request_loan(
  uuid,
  bigint,
  integer,
  integer,
  text
) to authenticated;

revoke execute on function public.approve_loan(uuid)
from public, anon;

grant execute on function public.approve_loan(uuid)
to authenticated;

revoke execute on function public.reject_loan(
  uuid,
  text
) from public, anon;

grant execute on function public.reject_loan(
  uuid,
  text
) to authenticated;

revoke execute on function public.request_loan_repayment(
  uuid,
  bigint,
  text,
  text,
  text
) from public, anon;

grant execute on function public.request_loan_repayment(
  uuid,
  bigint,
  text,
  text,
  text
) to authenticated;

revoke execute on function public.approve_loan_repayment(uuid)
from public, anon;

grant execute on function public.approve_loan_repayment(uuid)
to authenticated;

revoke execute on function public.reject_loan_repayment(
  uuid,
  text
) from public, anon;

grant execute on function public.reject_loan_repayment(
  uuid,
  text
) to authenticated;

revoke execute on function public.get_loan_summary()
from public, anon;

grant execute on function public.get_loan_summary()
to authenticated;

commit;
