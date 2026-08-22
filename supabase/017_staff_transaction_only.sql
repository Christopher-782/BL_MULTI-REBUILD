-- =========================================================
-- BL MULTI CONCEPT - STAFF TRANSACTION-ONLY ACCESS
-- Run AFTER 016_bulk_approval_schema_cache_hotfix.sql
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1. Staff can still initiate deposits/withdrawals, but staff
--    can no longer create/manage customers or start the other
--    operational workflows from direct RPC calls.
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
      array['super_admin', 'admin', 'manager']::public.app_role[]
    ),
    false
  );
$$;

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
      array['super_admin', 'admin', 'manager']::public.app_role[]
    ),
    false
  );
$$;

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
      array['super_admin', 'admin', 'manager']::public.app_role[]
    ),
    false
  );
$$;

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
      array['super_admin', 'admin', 'manager']::public.app_role[]
    ),
    false
  );
$$;

-- ---------------------------------------------------------
-- 2. Transaction table visibility.
--    Management roles retain the full transaction register.
--    A staff account can see only transactions it initiated.
-- ---------------------------------------------------------

drop policy if exists "active staff can view transactions"
on public.transactions;

create policy "active staff can view transactions"
on public.transactions
for select
to authenticated
using (
  (select private.is_active_user())
  and (
    (select private.current_app_role()) <> 'staff'::public.app_role
    or initiated_by = (select auth.uid())
  )
);

-- Staff do not need direct ledger browsing in the transaction-only workspace.
drop policy if exists "active staff can view ledger entries"
on public.ledger_entries;

create policy "active staff can view ledger entries"
on public.ledger_entries
for select
to authenticated
using (
  (select private.is_active_user())
  and (select private.current_app_role()) <> 'staff'::public.app_role
);

-- ---------------------------------------------------------
-- 3. Transaction summary is role-scoped as a defense-in-depth
--    measure. Staff see only their own submission counts/value.
-- ---------------------------------------------------------

create or replace function public.get_transaction_summary()
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
          count(*) filter (
            where t.status = 'pending'::public.transaction_status
          ),

        'approved_today_count',
          count(*) filter (
            where t.status = 'approved'::public.transaction_status
              and t.reviewed_at >= date_trunc('day', now())
          ),

        'deposits_today_minor',
          coalesce(sum(t.net_amount_minor) filter (
            where t.type = 'deposit'::public.transaction_type
              and t.status = 'approved'::public.transaction_status
              and t.reviewed_at >= date_trunc('day', now())
          ), 0),

        'charges_today_minor',
          coalesce(sum(t.charge_minor) filter (
            where t.type = 'deposit'::public.transaction_type
              and t.status = 'approved'::public.transaction_status
              and t.reviewed_at >= date_trunc('day', now())
          ), 0),

        'withdrawals_today_minor',
          coalesce(sum(t.net_amount_minor) filter (
            where t.type = 'withdrawal'::public.transaction_type
              and t.status = 'approved'::public.transaction_status
              and t.reviewed_at >= date_trunc('day', now())
          ), 0)
      )
    else null
  end
  from public.transactions t
  where private.current_app_role() <> 'staff'::public.app_role
     or t.initiated_by = (select auth.uid());
$$;

revoke all on function public.get_transaction_summary()
from public, anon;
grant execute on function public.get_transaction_summary()
to authenticated;

-- ---------------------------------------------------------
-- 4. Dashboard financial summary is blocked for transaction staff.
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
  v_today_revenue bigint := 0;
  v_today_expenses bigint := 0;
begin
  if not private.is_active_user() then
    raise exception 'Your staff account is not active.' using errcode = '42501';
  end if;

  if private.current_app_role() = 'staff'::public.app_role then
    raise exception 'Dashboard access is not available to transaction staff.'
      using errcode = '42501';
  end if;

  select
    coalesce((
      select sum(t.charge_minor)
      from public.transactions t
      where t.type = 'deposit'::public.transaction_type
        and t.status = 'approved'::public.transaction_status
        and t.reviewed_at::date = v_today
    ), 0)
    + coalesce((
      select sum(o.charge_minor)
      from public.overdrafts o
      where o.approved_at is not null
        and o.approved_at::date = v_today
    ), 0)
    + coalesce((
      select sum(r.interest_component_minor)
      from public.loan_repayments r
      where r.status = 'approved'::public.loan_repayment_status
        and r.approved_at::date = v_today
    ), 0)
  into v_today_revenue;

  select coalesce(sum(e.amount_minor), 0)
  into v_today_expenses
  from public.expenses e
  where e.status = 'approved'::public.expense_status
    and e.expense_date = v_today;

  return jsonb_build_object(
    'active_customers',
      (select count(*) from public.customers c
       where c.status = 'active'::public.customer_status),

    'positive_customer_balances_minor',
      (select coalesce(sum(greatest(a.cached_balance_minor, 0)), 0)
       from public.accounts a
       where a.status <> 'closed'::public.account_status),

    'overdraft_exposure_minor',
      (select coalesce(sum(greatest(-a.cached_balance_minor, 0)), 0)
       from public.accounts a
       where a.status <> 'closed'::public.account_status),

    'loan_outstanding_minor',
      (select coalesce(sum(l.principal_outstanding_minor + l.interest_outstanding_minor), 0)
       from public.loans l
       where l.status = 'active'::public.loan_status),

    'today_net_deposits_minor',
      (select coalesce(sum(t.net_amount_minor), 0)
       from public.transactions t
       where t.type = 'deposit'::public.transaction_type
         and t.status = 'approved'::public.transaction_status
         and t.reviewed_at::date = v_today),

    'today_withdrawals_minor',
      (select coalesce(sum(t.net_amount_minor), 0)
       from public.transactions t
       where t.type = 'withdrawal'::public.transaction_type
         and t.status = 'approved'::public.transaction_status
         and t.reviewed_at::date = v_today),

    'today_revenue_minor', v_today_revenue,
    'today_expenses_minor', v_today_expenses,
    'today_operational_net_minor', v_today_revenue - v_today_expenses,

    'pending_transactions',
      (select count(*) from public.transactions t
       where t.status = 'pending'::public.transaction_status),
    'pending_loans',
      (select count(*) from public.loans l
       where l.status = 'pending'::public.loan_status),
    'pending_loan_repayments',
      (select count(*) from public.loan_repayments r
       where r.status = 'pending'::public.loan_repayment_status),
    'pending_overdrafts',
      (select count(*) from public.overdrafts o
       where o.status = 'pending'::public.overdraft_status),
    'pending_expenses',
      (select count(*) from public.expenses e
       where e.status = 'pending'::public.expense_status)
  );
end;
$$;

revoke all on function public.get_dashboard_summary()
from public, anon;
grant execute on function public.get_dashboard_summary()
to authenticated;

notify pgrst, 'reload schema';

commit;
