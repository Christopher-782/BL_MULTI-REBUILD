-- =========================================================
-- BL MULTI CONCEPT - STEP 14
-- Customer portfolio summary + dashboard refresh +
-- staff transaction bulk approval
--
-- Run AFTER the existing Step 12 application migrations and
-- the legacy opening-balance migration.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1. CUSTOMER PORTFOLIO SUMMARY
-- ---------------------------------------------------------

create or replace function public.get_customer_portfolio_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_active_user() then
      jsonb_build_object(
        'total_customers',
          (select count(*) from public.customers),
        'active_customers',
          (select count(*) from public.customers c
           where c.status = 'active'::public.customer_status),
        'account_count',
          (select count(*) from public.accounts a
           where a.status <> 'closed'::public.account_status),
        'positive_customer_balances_minor',
          (select coalesce(sum(greatest(a.cached_balance_minor, 0)), 0)
           from public.accounts a
           where a.status <> 'closed'::public.account_status),
        'net_customer_balances_minor',
          (select coalesce(sum(a.cached_balance_minor), 0)
           from public.accounts a
           where a.status <> 'closed'::public.account_status),
        'overdraft_exposure_minor',
          (select coalesce(sum(greatest(-a.cached_balance_minor, 0)), 0)
           from public.accounts a
           where a.status <> 'closed'::public.account_status)
      )
    else null
  end;
$$;

revoke all on function public.get_customer_portfolio_summary()
from public, anon;
grant execute on function public.get_customer_portfolio_summary()
to authenticated;

-- ---------------------------------------------------------
-- 2. REBUILD DASHBOARD SUMMARY AGAINST CURRENT TABLES
-- Opening-balance transactions are deliberately excluded from
-- today's deposit/revenue flow; account balances include them.
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

-- ---------------------------------------------------------
-- 3. PENDING TRANSACTION MAKERS FOR BULK APPROVAL
-- ---------------------------------------------------------

create or replace function public.get_pending_transaction_makers()
returns table (
  staff_id uuid,
  staff_name text,
  pending_count bigint,
  pending_amount_minor bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.initiated_by as staff_id,
    max(t.initiated_by_name) as staff_name,
    count(*)::bigint as pending_count,
    coalesce(sum(t.amount_minor), 0)::bigint as pending_amount_minor
  from public.transactions t
  where private.can_approve_transactions()
    and t.status = 'pending'::public.transaction_status
    and t.initiated_by <> (select auth.uid())
  group by t.initiated_by
  order by max(t.initiated_by_name), t.initiated_by;
$$;

revoke all on function public.get_pending_transaction_makers()
from public, anon;
grant execute on function public.get_pending_transaction_makers()
to authenticated;

-- ---------------------------------------------------------
-- 4. BULK APPROVE SELECTED TRANSACTIONS FROM ONE STAFF MAKER
--
-- Important: this function DOES NOT duplicate ledger logic.
-- Every selected transaction is passed through the existing
-- public.approve_transaction(uuid), preserving:
--   * maker-checker protection
--   * account row locking
--   * insufficient-balance checks
--   * mandatory deposit-charge rechecks
--   * immutable ledger posting
--   * reversal authorization
-- ---------------------------------------------------------

create or replace function public.bulk_approve_staff_transactions(
  p_staff_id uuid,
  p_transaction_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_name text;
  v_actor_email text;
  v_id uuid;
  v_reference text;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_approved integer := 0;
  v_failed integer := 0;
  v_requested integer := 0;
begin
  if v_actor_id is null or not private.can_approve_transactions() then
    raise exception 'You do not have permission to bulk approve transactions.'
      using errcode = '42501';
  end if;

  if p_staff_id is null then
    raise exception 'Choose a staff member.' using errcode = '22023';
  end if;

  if p_staff_id = v_actor_id then
    raise exception 'Maker-checker protection: you cannot bulk approve your own transactions.'
      using errcode = '42501';
  end if;

  if p_transaction_ids is null or cardinality(p_transaction_ids) = 0 then
    raise exception 'Select at least one pending transaction.' using errcode = '22023';
  end if;

  select count(*)
  into v_requested
  from (select distinct unnest(p_transaction_ids) as id) x;

  if v_requested > 100 then
    raise exception 'A bulk approval is limited to 100 transactions at a time.'
      using errcode = '22023';
  end if;

  v_actor_name := private.current_actor_name();
  v_actor_email := private.current_actor_email();

  for v_id in
    select distinct unnest(p_transaction_ids)
  loop
    v_reference := null;

    select t.reference
    into v_reference
    from public.transactions t
    where t.id = v_id
      and t.initiated_by = p_staff_id
      and t.status = 'pending'::public.transaction_status;

    if v_reference is null then
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'transaction_id', v_id,
        'reference', null,
        'status', 'failed',
        'error', 'Transaction is not pending or was not created by the selected staff member.'
      ));
      continue;
    end if;

    begin
      v_result := public.approve_transaction(v_id);
      v_approved := v_approved + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'transaction_id', v_id,
        'reference', v_reference,
        'status', 'approved',
        'result', v_result
      ));
    exception when others then
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'transaction_id', v_id,
        'reference', v_reference,
        'status', 'failed',
        'error', sqlerrm,
        'sqlstate', sqlstate
      ));
    end;
  end loop;

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
    v_actor_email,
    'transaction.bulk_approval',
    'transaction_batch',
    null,
    'Bulk reviewed selected pending transactions for one staff maker.',
    jsonb_build_object(
      'maker_id', p_staff_id,
      'requested_count', v_requested,
      'approved_count', v_approved,
      'failed_count', v_failed,
      'transaction_ids', p_transaction_ids
    )
  );

  return jsonb_build_object(
    'maker_id', p_staff_id,
    'requested_count', v_requested,
    'approved_count', v_approved,
    'failed_count', v_failed,
    'results', v_results
  );
end;
$$;

revoke all on function public.bulk_approve_staff_transactions(uuid, uuid[])
from public, anon;
grant execute on function public.bulk_approve_staff_transactions(uuid, uuid[])
to authenticated;

commit;

-- Refresh PostgREST/Supabase RPC schema cache after creating the functions.
notify pgrst, 'reload schema';

-- Quick verification (read-only):
select public.get_customer_portfolio_summary() as customer_portfolio;
select public.get_dashboard_summary() as dashboard_summary;
