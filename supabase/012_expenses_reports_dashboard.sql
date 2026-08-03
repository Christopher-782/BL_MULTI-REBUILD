-- =========================================================
-- FINTECH REBUILD - STEP 6
-- Expenses + realized revenue reports + management dashboard
--
-- Run AFTER:
--   011_one_off_overdraft_flow.sql
--
-- IMPORTANT:
-- "Operational net" in this module means:
--
--   realized fee/interest revenue - approved operating expenses
--
-- It is NOT a statutory profit-and-loss statement.
-- Customer deposits, withdrawals, loan principal and overdraft
-- principal are not treated as revenue/expense.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1. EXPENSE STATUS + NUMBER SEQUENCE
-- ---------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'expense_status'
      and n.nspname = 'public'
  ) then
    create type public.expense_status as enum (
      'pending',
      'approved',
      'rejected'
    );
  end if;
end
$$;

create sequence if not exists public.expense_number_seq
  start with 1
  increment by 1;

revoke all on sequence public.expense_number_seq
from anon, authenticated;

-- ---------------------------------------------------------
-- 2. EXPENSES
-- ---------------------------------------------------------

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),

  expense_number text not null unique,

  expense_date date not null default current_date,

  category text not null,
  description text not null,

  amount_minor bigint not null,

  payment_method text not null default 'cash',
  external_reference text,

  status public.expense_status
    not null
    default 'pending',

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

  created_at timestamptz not null default now(),

  constraint expenses_amount_positive
    check (amount_minor > 0),

  constraint expenses_category_not_blank
    check (length(btrim(category)) between 2 and 80),

  constraint expenses_description_not_blank
    check (length(btrim(description)) between 2 and 500),

  constraint expenses_payment_method_check
    check (
      payment_method in (
        'cash',
        'bank_transfer',
        'card',
        'other'
      )
    )
);

create index if not exists expenses_date_idx
  on public.expenses(expense_date desc);

create index if not exists expenses_status_requested_at_idx
  on public.expenses(status, requested_at desc);

create index if not exists expenses_category_idx
  on public.expenses(category);

-- ---------------------------------------------------------
-- 3. EXPENSE AUTHORIZATION
-- ---------------------------------------------------------

create or replace function private.can_request_expenses()
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

create or replace function private.can_approve_expenses()
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

revoke all on function private.can_request_expenses()
from public;

revoke all on function private.can_approve_expenses()
from public;

grant execute on function private.can_request_expenses()
to authenticated;

grant execute on function private.can_approve_expenses()
to authenticated;

create or replace function private.next_expense_number()
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select 'EXP' ||
    lpad(
      nextval('public.expense_number_seq')::text,
      7,
      '0'
    );
$$;

revoke all on function private.next_expense_number()
from public;

-- ---------------------------------------------------------
-- 4. RLS + DIRECTORY
-- ---------------------------------------------------------

alter table public.expenses
enable row level security;

revoke all on table public.expenses
from anon, authenticated;

grant select on table public.expenses
to authenticated;

drop policy if exists
  "active staff can view expenses"
on public.expenses;

create policy
  "active staff can view expenses"
on public.expenses
for select
to authenticated
using ((select private.is_active_user()));

create or replace view public.expense_directory
with (security_invoker = true)
as
select
  e.id,
  e.expense_number,
  e.expense_date,
  e.category,
  e.description,
  e.amount_minor,
  e.payment_method,
  e.external_reference,
  e.status,

  e.requested_by,
  e.requested_by_name,
  e.requested_at,

  e.approved_by,
  e.approved_by_name,
  e.approved_at,

  e.rejected_by,
  e.rejected_by_name,
  e.rejected_at,
  e.rejection_reason,

  e.created_at

from public.expenses e;

revoke all on table public.expense_directory
from anon, authenticated;

grant select on table public.expense_directory
to authenticated;

-- ---------------------------------------------------------
-- 5. REQUEST EXPENSE
-- ---------------------------------------------------------

create or replace function public.request_expense(
  p_expense_date date,
  p_category text,
  p_description text,
  p_amount_minor bigint,
  p_payment_method text,
  p_external_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;

  v_category text :=
    nullif(btrim(coalesce(p_category, '')), '');

  v_description text :=
    nullif(btrim(coalesce(p_description, '')), '');

  v_payment_method text :=
    lower(
      btrim(
        coalesce(
          p_payment_method,
          ''
        )
      )
    );

  v_expense public.expenses;
begin
  if v_actor_id is null
    or not private.can_request_expenses() then
    raise exception
      'You do not have permission to record expenses.'
      using errcode = '42501';
  end if;

  if p_expense_date is null then
    raise exception
      'Expense date is required.'
      using errcode = '22023';
  end if;

  if p_expense_date >
    current_date + 1 then
    raise exception
      'Expense date cannot be in the future.'
      using errcode = '22023';
  end if;

  if v_category is null
    or length(v_category) > 80 then
    raise exception
      'Enter a valid expense category.'
      using errcode = '22023';
  end if;

  if v_description is null
    or length(v_description) > 500 then
    raise exception
      'Enter a valid expense description.'
      using errcode = '22023';
  end if;

  if p_amount_minor is null
    or p_amount_minor <= 0 then
    raise exception
      'Expense amount must be greater than zero.'
      using errcode = '22023';
  end if;

  if v_payment_method not in (
    'cash',
    'bank_transfer',
    'card',
    'other'
  ) then
    raise exception
      'Invalid expense payment method.'
      using errcode = '22023';
  end if;

  v_actor_name :=
    private.current_actor_name();

  insert into public.expenses (
    expense_number,
    expense_date,
    category,
    description,
    amount_minor,
    payment_method,
    external_reference,
    status,
    requested_by,
    requested_by_name
  )
  values (
    private.next_expense_number(),
    p_expense_date,
    v_category,
    v_description,
    p_amount_minor,
    v_payment_method,
    nullif(
      btrim(
        coalesce(
          p_external_reference,
          ''
        )
      ),
      ''
    ),
    'pending'::public.expense_status,
    v_actor_id,
    v_actor_name
  )
  returning *
  into v_expense;

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

    'expense.requested',
    'expense',
    v_expense.id,

    'Created expense request ' ||
      v_expense.expense_number ||
      '.',

    jsonb_build_object(
      'expense_number',
        v_expense.expense_number,

      'expense_date',
        v_expense.expense_date,

      'category',
        v_expense.category,

      'amount_minor',
        v_expense.amount_minor,

      'payment_method',
        v_expense.payment_method
    )
  );

  return to_jsonb(v_expense);
end;
$$;

-- ---------------------------------------------------------
-- 6. APPROVE EXPENSE
-- ---------------------------------------------------------

create or replace function public.approve_expense(
  p_expense_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;

  v_expense public.expenses;
  v_updated public.expenses;
begin
  if v_actor_id is null
    or not private.can_approve_expenses() then
    raise exception
      'You do not have permission to approve expenses.'
      using errcode = '42501';
  end if;

  v_actor_name :=
    private.current_actor_name();

  select *
  into v_expense
  from public.expenses e
  where e.id = p_expense_id
  for update;

  if not found then
    raise exception
      'Expense was not found.'
      using errcode = 'P0002';
  end if;

  if v_expense.status <>
    'pending'::public.expense_status then
    raise exception
      'Only pending expenses can be approved.'
      using errcode = '22023';
  end if;

  if v_expense.requested_by =
    v_actor_id then
    raise exception
      'Maker-checker protection: you cannot approve your own expense.'
      using errcode = '42501';
  end if;

  update public.expenses
  set
    status =
      'approved'::public.expense_status,

    approved_by =
      v_actor_id,

    approved_by_name =
      v_actor_name,

    approved_at =
      now()

  where id =
    v_expense.id

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

    'expense.approved',
    'expense',
    v_updated.id,

    'Approved expense ' ||
      v_updated.expense_number ||
      '.',

    jsonb_build_object(
      'expense_number',
        v_updated.expense_number,

      'expense_date',
        v_updated.expense_date,

      'category',
        v_updated.category,

      'amount_minor',
        v_updated.amount_minor
    )
  );

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 7. REJECT EXPENSE
-- ---------------------------------------------------------

create or replace function public.reject_expense(
  p_expense_id uuid,
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

  v_expense public.expenses;

  v_reason text :=
    nullif(
      btrim(
        coalesce(
          p_reason,
          ''
        )
      ),
      ''
    );

  v_updated public.expenses;
begin
  if v_actor_id is null
    or not private.can_approve_expenses() then
    raise exception
      'You do not have permission to reject expenses.'
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
  into v_expense
  from public.expenses e
  where e.id = p_expense_id
  for update;

  if not found then
    raise exception
      'Expense was not found.'
      using errcode = 'P0002';
  end if;

  if v_expense.status <>
    'pending'::public.expense_status then
    raise exception
      'Only pending expenses can be rejected.'
      using errcode = '22023';
  end if;

  if v_expense.requested_by =
    v_actor_id then
    raise exception
      'Maker-checker protection: you cannot reject your own expense.'
      using errcode = '42501';
  end if;

  update public.expenses
  set
    status =
      'rejected'::public.expense_status,

    rejected_by =
      v_actor_id,

    rejected_by_name =
      v_actor_name,

    rejected_at =
      now(),

    rejection_reason =
      v_reason

  where id =
    v_expense.id

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

    'expense.rejected',
    'expense',
    v_updated.id,

    'Rejected expense ' ||
      v_updated.expense_number ||
      '.',

    jsonb_build_object(
      'expense_number',
        v_updated.expense_number,

      'reason',
        v_reason
    )
  );

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 8. EXPENSE SUMMARY
-- ---------------------------------------------------------

create or replace function public.get_expense_summary()
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
            from public.expenses e
            where e.status =
              'pending'::public.expense_status
          ),

        'today_minor',
          (
            select coalesce(
              sum(e.amount_minor),
              0
            )
            from public.expenses e
            where e.status =
              'approved'::public.expense_status
              and e.expense_date =
                current_date
          ),

        'month_minor',
          (
            select coalesce(
              sum(e.amount_minor),
              0
            )
            from public.expenses e
            where e.status =
              'approved'::public.expense_status
              and e.expense_date >=
                date_trunc(
                  'month',
                  current_date
                )::date
              and e.expense_date <=
                current_date
          ),

        'approved_count',
          (
            select count(*)
            from public.expenses e
            where e.status =
              'approved'::public.expense_status
          )
      )
    else null
  end;
$$;

-- ---------------------------------------------------------
-- 9. REALIZED REVENUE HELPERS
-- ---------------------------------------------------------

create or replace function private.realized_revenue_between(
  p_from date,
  p_to date
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with values_cte as (
    select
      coalesce(
        (
          select sum(t.charge_minor)
          from public.transactions t
          where t.type =
            'deposit'::public.transaction_type
            and t.status =
              'approved'::public.transaction_status
            and t.reviewed_at::date
              between p_from and p_to
        ),
        0
      )::bigint as deposit_charges_minor,

      coalesce(
        (
          select sum(o.charge_minor)
          from public.overdrafts o
          where o.approved_at is not null
            and o.approved_at::date
              between p_from and p_to
        ),
        0
      )::bigint as overdraft_charges_minor,

      coalesce(
        (
          select sum(r.interest_component_minor)
          from public.loan_repayments r
          where r.status =
            'approved'::public.loan_repayment_status
            and r.approved_at::date
              between p_from and p_to
        ),
        0
      )::bigint as loan_interest_collected_minor
  )
  select jsonb_build_object(
    'deposit_charges_minor',
      deposit_charges_minor,

    'overdraft_charges_minor',
      overdraft_charges_minor,

    'loan_interest_collected_minor',
      loan_interest_collected_minor,

    'total_revenue_minor',
      deposit_charges_minor +
      overdraft_charges_minor +
      loan_interest_collected_minor
  )
  from values_cte;
$$;

revoke all on function private.realized_revenue_between(
  date,
  date
)
from public;

-- ---------------------------------------------------------
-- 10. MANAGEMENT DASHBOARD SUMMARY
-- ---------------------------------------------------------

create or replace function public.get_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := current_date;
  v_revenue jsonb;

  v_today_revenue bigint := 0;
  v_today_expenses bigint := 0;
begin
  if not private.is_active_user() then
    raise exception
      'Your staff account is not active.'
      using errcode = '42501';
  end if;

  v_revenue :=
    private.realized_revenue_between(
      v_today,
      v_today
    );

  v_today_revenue :=
    coalesce(
      (
        v_revenue
        ->> 'total_revenue_minor'
      )::bigint,
      0
    );

  select coalesce(
    sum(e.amount_minor),
    0
  )
  into v_today_expenses
  from public.expenses e
  where e.status =
    'approved'::public.expense_status
    and e.expense_date =
      v_today;

  return jsonb_build_object(
    'active_customers',
      (
        select count(*)
        from public.customers c
        where c.status =
          'active'::public.customer_status
      ),

    'positive_customer_balances_minor',
      (
        select coalesce(
          sum(
            greatest(
              a.cached_balance_minor,
              0
            )
          ),
          0
        )
        from public.accounts a
        where a.status <>
          'closed'::public.account_status
      ),

    'overdraft_exposure_minor',
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
        from public.accounts a
        where a.status <>
          'closed'::public.account_status
      ),

    'loan_outstanding_minor',
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

    'today_net_deposits_minor',
      (
        select coalesce(
          sum(t.net_amount_minor),
          0
        )
        from public.transactions t
        where t.type =
          'deposit'::public.transaction_type
          and t.status =
            'approved'::public.transaction_status
          and t.reviewed_at::date =
            v_today
      ),

    'today_withdrawals_minor',
      (
        select coalesce(
          sum(t.net_amount_minor),
          0
        )
        from public.transactions t
        where t.type =
          'withdrawal'::public.transaction_type
          and t.status =
            'approved'::public.transaction_status
          and t.reviewed_at::date =
            v_today
      ),

    'today_revenue_minor',
      v_today_revenue,

    'today_expenses_minor',
      v_today_expenses,

    'today_operational_net_minor',
      v_today_revenue -
      v_today_expenses,

    'pending_transactions',
      (
        select count(*)
        from public.transactions t
        where t.status =
          'pending'::public.transaction_status
      ),

    'pending_loans',
      (
        select count(*)
        from public.loans l
        where l.status =
          'pending'::public.loan_status
      ),

    'pending_loan_repayments',
      (
        select count(*)
        from public.loan_repayments r
        where r.status =
          'pending'::public.loan_repayment_status
      ),

    'pending_overdrafts',
      (
        select count(*)
        from public.overdrafts o
        where o.status =
          'pending'::public.overdraft_status
      ),

    'pending_expenses',
      (
        select count(*)
        from public.expenses e
        where e.status =
          'pending'::public.expense_status
      )
  );
end;
$$;

-- ---------------------------------------------------------
-- 11. MANAGEMENT REPORT
-- ---------------------------------------------------------

create or replace function public.get_management_report(
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_from date := p_from;
  v_to date := p_to;

  v_revenue jsonb;

  v_expenses bigint := 0;
  v_expense_breakdown jsonb;

  v_deposits bigint := 0;
  v_withdrawals bigint := 0;

  v_loan_disbursements bigint := 0;
  v_loan_repayments bigint := 0;
  v_overdraft_payouts bigint := 0;

  v_operational_net bigint := 0;
begin
  if not private.is_active_user() then
    raise exception
      'Your staff account is not active.'
      using errcode = '42501';
  end if;

  if v_from is null
    or v_to is null then
    raise exception
      'Both report dates are required.'
      using errcode = '22023';
  end if;

  if v_from > v_to then
    raise exception
      'Report start date cannot be after end date.'
      using errcode = '22023';
  end if;

  if v_to >
    current_date + 1 then
    raise exception
      'Report end date cannot be in the future.'
      using errcode = '22023';
  end if;

  v_revenue :=
    private.realized_revenue_between(
      v_from,
      v_to
    );

  select coalesce(
    sum(e.amount_minor),
    0
  )
  into v_expenses
  from public.expenses e
  where e.status =
    'approved'::public.expense_status
    and e.expense_date
      between v_from and v_to;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'category',
          x.category,

        'amount_minor',
          x.amount_minor,

        'count',
          x.expense_count
      )
      order by x.amount_minor desc
    ),
    '[]'::jsonb
  )
  into v_expense_breakdown
  from (
    select
      e.category,
      sum(e.amount_minor)::bigint as amount_minor,
      count(*)::bigint as expense_count
    from public.expenses e
    where e.status =
      'approved'::public.expense_status
      and e.expense_date
        between v_from and v_to
    group by e.category
  ) x;

  select coalesce(
    sum(t.net_amount_minor),
    0
  )
  into v_deposits
  from public.transactions t
  where t.type =
    'deposit'::public.transaction_type
    and t.status =
      'approved'::public.transaction_status
    and t.reviewed_at::date
      between v_from and v_to;

  select coalesce(
    sum(t.net_amount_minor),
    0
  )
  into v_withdrawals
  from public.transactions t
  where t.type =
    'withdrawal'::public.transaction_type
    and t.status =
      'approved'::public.transaction_status
    and t.reviewed_at::date
      between v_from and v_to;

  select coalesce(
    sum(l.principal_minor),
    0
  )
  into v_loan_disbursements
  from public.loans l
  where l.approved_at is not null
    and l.approved_at::date
      between v_from and v_to;

  select coalesce(
    sum(r.amount_minor),
    0
  )
  into v_loan_repayments
  from public.loan_repayments r
  where r.status =
    'approved'::public.loan_repayment_status
    and r.approved_at::date
      between v_from and v_to;

  select coalesce(
    sum(o.requested_amount_minor),
    0
  )
  into v_overdraft_payouts
  from public.overdrafts o
  where o.approved_at is not null
    and o.approved_at::date
      between v_from and v_to;

  v_operational_net :=
    coalesce(
      (
        v_revenue
        ->> 'total_revenue_minor'
      )::bigint,
      0
    ) -
    v_expenses;

  return jsonb_build_object(
    'from_date',
      v_from,

    'to_date',
      v_to,

    'revenue',
      v_revenue,

    'expenses_minor',
      v_expenses,

    'operational_net_minor',
      v_operational_net,

    'expense_breakdown',
      v_expense_breakdown,

    'activity',
      jsonb_build_object(
        'net_deposits_minor',
          v_deposits,

        'withdrawals_minor',
          v_withdrawals,

        'loan_disbursements_minor',
          v_loan_disbursements,

        'loan_repayments_minor',
          v_loan_repayments,

        'overdraft_payouts_minor',
          v_overdraft_payouts
      )
  );
end;
$$;

-- ---------------------------------------------------------
-- 12. PRIVILEGES
-- ---------------------------------------------------------

revoke execute on function public.request_expense(
  date,
  text,
  text,
  bigint,
  text,
  text
)
from public, anon;

grant execute on function public.request_expense(
  date,
  text,
  text,
  bigint,
  text,
  text
)
to authenticated;

revoke execute on function public.approve_expense(uuid)
from public, anon;

grant execute on function public.approve_expense(uuid)
to authenticated;

revoke execute on function public.reject_expense(
  uuid,
  text
)
from public, anon;

grant execute on function public.reject_expense(
  uuid,
  text
)
to authenticated;

revoke execute on function public.get_expense_summary()
from public, anon;

grant execute on function public.get_expense_summary()
to authenticated;

revoke execute on function public.get_dashboard_summary()
from public, anon;

grant execute on function public.get_dashboard_summary()
to authenticated;

revoke execute on function public.get_management_report(
  date,
  date
)
from public, anon;

grant execute on function public.get_management_report(
  date,
  date
)
to authenticated;

commit;
