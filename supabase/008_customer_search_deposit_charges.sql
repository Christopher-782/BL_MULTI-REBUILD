-- =========================================================
-- STEP 4 PATCH
-- Search transactions by CUSTOMER NUMBER + deposit charges
--
-- Run AFTER:
--   007_financial_ledger_transactions.sql
--
-- Business rule implemented:
-- A positive deposit charge is mandatory when the selected
-- account is currently at zero AND either:
--   1) it has continuously been at zero for MORE THAN 7 days; OR
--   2) an approved full withdrawal most recently reduced it to zero.
--
-- Gross deposit - charge = net amount credited after approval.
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1. TRACK HOW LONG AN ACCOUNT HAS BEEN AT ZERO
-- ---------------------------------------------------------

alter table public.accounts
  add column if not exists zero_since timestamptz;

alter table public.accounts
  add column if not exists zeroed_by_full_withdrawal boolean not null default false;

-- New accounts start at zero, so future inserts should begin their zero clock.
alter table public.accounts
  alter column zero_since set default now();

-- Backfill positive accounts.
update public.accounts
set
  zero_since = null,
  zeroed_by_full_withdrawal = false
where cached_balance_minor > 0;

-- Backfill zero-balance accounts from their most recent ledger entry when possible.
with latest_zero as (
  select distinct on (le.account_id)
    le.account_id,
    le.created_at,
    t.type
  from public.ledger_entries le
  join public.transactions t
    on t.id = le.transaction_id
  where le.balance_after_minor = 0
  order by le.account_id, le.created_at desc
)
update public.accounts a
set
  zero_since = coalesce(a.zero_since, lz.created_at, a.created_at),
  zeroed_by_full_withdrawal = (
    lz.type = 'withdrawal'::public.transaction_type
  )
from latest_zero lz
where a.id = lz.account_id
  and a.cached_balance_minor = 0;

-- Zero accounts with no ledger history have been zero since creation.
update public.accounts
set zero_since = coalesce(zero_since, created_at)
where cached_balance_minor = 0;

-- ---------------------------------------------------------
-- 2. STORE GROSS, CHARGE AND NET ON TRANSACTIONS
-- ---------------------------------------------------------

alter table public.transactions
  add column if not exists charge_minor bigint not null default 0;

alter table public.transactions
  add column if not exists net_amount_minor bigint;

alter table public.transactions
  add column if not exists charge_required boolean not null default false;

alter table public.transactions
  add column if not exists charge_reason text;

-- Existing transactions had no charge.
update public.transactions
set net_amount_minor = amount_minor
where net_amount_minor is null;

alter table public.transactions
  alter column net_amount_minor set not null;

alter table public.transactions
  drop constraint if exists transactions_charge_nonnegative;

alter table public.transactions
  add constraint transactions_charge_nonnegative
  check (charge_minor >= 0);

alter table public.transactions
  drop constraint if exists transactions_net_positive;

alter table public.transactions
  add constraint transactions_net_positive
  check (net_amount_minor > 0);

alter table public.transactions
  drop constraint if exists transactions_deposit_charge_less_than_amount;

alter table public.transactions
  add constraint transactions_deposit_charge_less_than_amount
  check (
    type <> 'deposit'::public.transaction_type
    or charge_minor < amount_minor
  );

-- ---------------------------------------------------------
-- 3. AUTHORITATIVE CHARGE REQUIREMENT
-- ---------------------------------------------------------

create or replace function private.account_charge_requirement(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account public.accounts;
  v_required boolean := false;
  v_reason text := null;
begin
  select *
  into v_account
  from public.accounts a
  where a.id = p_account_id;

  if not found then
    return jsonb_build_object(
      'required', false,
      'reason', null,
      'zero_since', null
    );
  end if;

  if v_account.cached_balance_minor = 0 then
    if v_account.zeroed_by_full_withdrawal then
      v_required := true;
      v_reason := 'A recent full withdrawal reduced this account balance to zero.';
    elsif v_account.zero_since is not null
      and v_account.zero_since < now() - interval '7 days' then
      v_required := true;
      v_reason := 'This account has remained at zero for more than 7 days.';
    end if;
  end if;

  return jsonb_build_object(
    'required', v_required,
    'reason', v_reason,
    'zero_since', v_account.zero_since
  );
end;
$$;

revoke all on function private.account_charge_requirement(uuid) from public;
grant execute on function private.account_charge_requirement(uuid) to authenticated;

-- ---------------------------------------------------------
-- 4. CUSTOMER-NUMBER TRANSACTION LOOKUP
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
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Your staff account is not active.'
      using errcode = '42501';
  end if;

  select *
  into v_customer
  from public.customers c
  where c.customer_number = btrim(coalesce(p_customer_number, ''));

  if not found then
    raise exception 'Customer number was not found.'
      using errcode = 'P0002';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'account_number', a.account_number,
        'account_type', a.account_type,
        'currency', a.currency,
        'status', a.status,
        'cached_balance_minor', a.cached_balance_minor,
        'zero_since', a.zero_since,
        'zeroed_by_full_withdrawal', a.zeroed_by_full_withdrawal,
        'charge_required',
          coalesce(
            (private.account_charge_requirement(a.id) ->> 'required')::boolean,
            false
          ),
        'charge_reason',
          private.account_charge_requirement(a.id) ->> 'reason'
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
        'id', v_customer.id,
        'customer_number', v_customer.customer_number,
        'first_name', v_customer.first_name,
        'middle_name', v_customer.middle_name,
        'last_name', v_customer.last_name,
        'phone', v_customer.phone,
        'status', v_customer.status
      ),
    'accounts', v_accounts
  );
end;
$$;

revoke execute on function public.get_customer_transaction_context(text)
from public, anon;

grant execute on function public.get_customer_transaction_context(text)
to authenticated;

-- ---------------------------------------------------------
-- 5. REBUILD DIRECTORY VIEW WITH CHARGE DATA
-- ---------------------------------------------------------

drop view if exists public.transaction_directory;

create view public.transaction_directory
with (security_invoker = true)
as
select
  t.id,
  t.reference,
  t.type,
  t.amount_minor,
  t.charge_minor,
  t.net_amount_minor,
  t.charge_required,
  t.charge_reason,
  t.status,
  t.description,
  t.rejection_reason,
  t.initiated_by,
  t.initiated_by_name,
  t.initiated_at,
  t.reviewed_by,
  t.reviewed_by_name,
  t.reviewed_at,
  t.reversal_of,
  t.reversed_by_transaction_id,
  t.created_at,

  a.id as account_id,
  a.account_number,
  a.account_type,
  a.currency,
  a.status as account_status,
  a.cached_balance_minor as account_balance_minor,
  a.zero_since as account_zero_since,
  a.zeroed_by_full_withdrawal,

  c.id as customer_id,
  c.customer_number,
  concat_ws(
    ' ',
    c.first_name,
    nullif(c.middle_name, ''),
    c.last_name
  ) as customer_name,
  c.status as customer_status,

  original.reference as original_reference

from public.transactions t
join public.accounts a on a.id = t.account_id
join public.customers c on c.id = t.customer_id
left join public.transactions original on original.id = t.reversal_of;

revoke all on table public.transaction_directory from anon, authenticated;
grant select on table public.transaction_directory to authenticated;

-- ---------------------------------------------------------
-- 6. REMOVE THE OLD NO-CHARGE INITIATION FUNCTION
-- This prevents old browser code from bypassing the charge rule.
-- ---------------------------------------------------------

drop function if exists public.initiate_transaction(
  uuid,
  public.transaction_type,
  bigint,
  text
);

-- ---------------------------------------------------------
-- 7. NEW TRANSACTION INITIATION WITH CHARGE
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
begin
  if v_actor_id is null or not private.can_initiate_transactions() then
    raise exception 'You do not have permission to initiate transactions.'
      using errcode = '42501';
  end if;

  if p_type not in (
    'deposit'::public.transaction_type,
    'withdrawal'::public.transaction_type
  ) then
    raise exception 'Only deposits and withdrawals can be initiated directly.'
      using errcode = '22023';
  end if;

  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Transaction amount must be greater than zero.'
      using errcode = '22023';
  end if;

  if v_charge < 0 then
    raise exception 'Charge cannot be negative.'
      using errcode = '22023';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id = p_account_id;

  if not found then
    raise exception 'Account not found.'
      using errcode = 'P0002';
  end if;

  if v_account.status <> 'active'::public.account_status then
    raise exception 'Only active accounts can receive new transactions.'
      using errcode = '22023';
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id = v_account.customer_id;

  if v_customer.status <> 'active'::public.customer_status then
    raise exception 'Only active customers can receive new transactions.'
      using errcode = '22023';
  end if;

  if p_type = 'deposit'::public.transaction_type then
    v_charge_requirement := private.account_charge_requirement(v_account.id);
    v_charge_required := coalesce(
      (v_charge_requirement ->> 'required')::boolean,
      false
    );
    v_charge_reason := v_charge_requirement ->> 'reason';

    if v_charge_required and v_charge <= 0 then
      raise exception 'A deposit charge is mandatory. %',
        coalesce(v_charge_reason, 'This account requires a charge.')
        using errcode = '22023';
    end if;

    if v_charge >= p_amount_minor then
      raise exception 'Deposit charge must be less than the gross deposit amount.'
        using errcode = '22023';
    end if;

    v_net := p_amount_minor - v_charge;

  else
    -- Step 4 currently applies charges only to deposits.
    if v_charge <> 0 then
      raise exception 'Withdrawal charges are not enabled in this step.'
        using errcode = '22023';
    end if;

    if v_account.cached_balance_minor < p_amount_minor then
      raise exception 'Insufficient account balance for this withdrawal.'
        using errcode = '22003';
    end if;

    v_net := p_amount_minor;
  end if;

  v_actor_name := private.current_actor_name();

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
    nullif(btrim(coalesce(p_description, '')), ''),
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
    'Initiated ' || v_transaction.type::text || ' ' ||
      v_transaction.reference || '.',
    jsonb_build_object(
      'reference', v_transaction.reference,
      'customer_number', v_customer.customer_number,
      'account_number', v_account.account_number,
      'type', v_transaction.type,
      'gross_amount_minor', v_transaction.amount_minor,
      'charge_minor', v_transaction.charge_minor,
      'net_amount_minor', v_transaction.net_amount_minor,
      'charge_required', v_transaction.charge_required,
      'charge_reason', v_transaction.charge_reason
    )
  );

  return to_jsonb(v_transaction);
end;
$$;

-- ---------------------------------------------------------
-- 8. REVERSAL REQUEST COPIES THE ORIGINAL POSTING AMOUNT
-- ---------------------------------------------------------

create or replace function public.request_transaction_reversal(
  p_transaction_id uuid,
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
  v_original public.transactions;
  v_reversal public.transactions;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_actor_id is null or not private.can_request_reversal() then
    raise exception 'You do not have permission to request transaction reversals.'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'A reversal reason is required.'
      using errcode = '22023';
  end if;

  select *
  into v_original
  from public.transactions t
  where t.id = p_transaction_id
  for update;

  if not found then
    raise exception 'Transaction not found.'
      using errcode = 'P0002';
  end if;

  if v_original.type = 'reversal'::public.transaction_type then
    raise exception 'A reversal transaction cannot itself be reversed in Step 4.'
      using errcode = '22023';
  end if;

  if v_original.status <> 'approved'::public.transaction_status then
    raise exception 'Only approved transactions can be reversed.'
      using errcode = '22023';
  end if;

  if v_original.reversed_by_transaction_id is not null then
    raise exception 'This transaction has already been reversed.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.transactions r
    where r.reversal_of = v_original.id
      and r.status = 'pending'::public.transaction_status
  ) then
    raise exception 'A reversal request is already pending for this transaction.'
      using errcode = '23505';
  end if;

  v_actor_name := private.current_actor_name();

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
    reversal_of
  )
  values (
    private.next_transaction_reference(),
    v_original.customer_id,
    v_original.account_id,
    'reversal'::public.transaction_type,
    v_original.amount_minor,
    0,
    v_original.net_amount_minor,
    false,
    null,
    'pending'::public.transaction_status,
    v_reason,
    v_actor_id,
    v_actor_name,
    v_original.id
  )
  returning *
  into v_reversal;

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
    'transaction.reversal_requested',
    'transaction',
    v_reversal.id,
    'Requested reversal ' || v_reversal.reference ||
      ' for ' || v_original.reference || '.',
    jsonb_build_object(
      'reversal_reference', v_reversal.reference,
      'original_reference', v_original.reference,
      'reason', v_reason,
      'posting_amount_minor', v_reversal.net_amount_minor
    )
  );

  return to_jsonb(v_reversal);
end;
$$;

-- ---------------------------------------------------------
-- 9. APPROVAL POSTS NET DEPOSIT, NOT GROSS DEPOSIT
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
begin
  if v_actor_id is null or not private.can_approve_transactions() then
    raise exception 'You do not have permission to approve transactions.'
      using errcode = '42501';
  end if;

  v_actor_role := private.current_app_role();
  v_actor_name := private.current_actor_name();

  select *
  into v_transaction
  from public.transactions t
  where t.id = p_transaction_id
  for update;

  if not found then
    raise exception 'Transaction not found.'
      using errcode = 'P0002';
  end if;

  if v_transaction.status <> 'pending'::public.transaction_status then
    raise exception 'Only pending transactions can be approved.'
      using errcode = '22023';
  end if;

  if v_transaction.initiated_by = v_actor_id then
    raise exception 'Maker-checker protection: you cannot approve your own transaction.'
      using errcode = '42501';
  end if;

  if v_transaction.type = 'reversal'::public.transaction_type
    and v_actor_role not in (
      'super_admin'::public.app_role,
      'admin'::public.app_role
    ) then
    raise exception 'Only an administrator can approve a reversal.'
      using errcode = '42501';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id = v_transaction.account_id
  for update;

  if not found then
    raise exception 'Account not found.'
      using errcode = 'P0002';
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id = v_transaction.customer_id;

  v_balance_before := v_account.cached_balance_minor;

  if v_transaction.type = 'deposit'::public.transaction_type then
    if v_account.status <> 'active'::public.account_status
      or v_customer.status <> 'active'::public.customer_status then
      raise exception 'The customer and account must both be active before approval.'
        using errcode = '22023';
    end if;

    -- Re-check the charge rule at approval time because the account
    -- may have changed while this request was pending.
    v_charge_requirement := private.account_charge_requirement(v_account.id);
    v_charge_required_now := coalesce(
      (v_charge_requirement ->> 'required')::boolean,
      false
    );
    v_charge_reason_now := v_charge_requirement ->> 'reason';

    if v_charge_required_now and v_transaction.charge_minor <= 0 then
      raise exception 'This deposit now requires a charge before it can be approved. Reject it and create a new deposit with a charge. %',
        coalesce(v_charge_reason_now, '')
        using errcode = '22023';
    end if;

    if v_transaction.charge_minor >= v_transaction.amount_minor then
      raise exception 'Deposit charge must be less than the gross deposit amount.'
        using errcode = '22023';
    end if;

    v_posting_amount := v_transaction.amount_minor - v_transaction.charge_minor;

    if v_posting_amount <= 0 then
      raise exception 'Net deposit amount must be greater than zero.'
        using errcode = '22023';
    end if;

    v_delta := v_posting_amount;
    v_direction := 'credit'::public.ledger_direction;

  elsif v_transaction.type = 'withdrawal'::public.transaction_type then
    if v_account.status <> 'active'::public.account_status
      or v_customer.status <> 'active'::public.customer_status then
      raise exception 'The customer and account must both be active before approval.'
        using errcode = '22023';
    end if;

    if v_balance_before < v_transaction.amount_minor then
      raise exception 'Insufficient account balance at approval time.'
        using errcode = '22003';
    end if;

    v_posting_amount := v_transaction.amount_minor;
    v_delta := -v_posting_amount;
    v_direction := 'debit'::public.ledger_direction;

  else
    select *
    into v_original
    from public.transactions t
    where t.id = v_transaction.reversal_of
    for update;

    if not found then
      raise exception 'Original transaction for this reversal was not found.'
        using errcode = 'P0002';
    end if;

    if v_original.status <> 'approved'::public.transaction_status
      or v_original.reversed_by_transaction_id is not null then
      raise exception 'The original transaction is no longer eligible for reversal.'
        using errcode = '22023';
    end if;

    if v_original.type = 'deposit'::public.transaction_type then
      v_posting_amount := v_original.net_amount_minor;

      if v_balance_before < v_posting_amount then
        raise exception 'The deposit cannot be reversed because the account no longer has sufficient funds.'
          using errcode = '22003';
      end if;

      v_delta := -v_posting_amount;
      v_direction := 'debit'::public.ledger_direction;

    elsif v_original.type = 'withdrawal'::public.transaction_type then
      v_posting_amount := v_original.net_amount_minor;
      v_delta := v_posting_amount;
      v_direction := 'credit'::public.ledger_direction;

    else
      raise exception 'Unsupported original transaction type for reversal.'
        using errcode = '22023';
    end if;
  end if;

  v_balance_after := v_balance_before + v_delta;

  -- Maintain zero-balance history.
  if v_balance_after = 0 then
    if v_transaction.type = 'withdrawal'::public.transaction_type then
      v_next_zero_since := now();
      v_next_full_withdrawal := true;
    elsif v_transaction.type = 'reversal'::public.transaction_type
      and v_original.type = 'deposit'::public.transaction_type then
      v_next_zero_since := now();
      v_next_full_withdrawal := false;
    else
      v_next_zero_since := coalesce(v_account.zero_since, now());
      v_next_full_withdrawal := false;
    end if;
  else
    v_next_zero_since := null;
    v_next_full_withdrawal := false;
  end if;

  update public.accounts
  set
    cached_balance_minor = v_balance_after,
    zero_since = v_next_zero_since,
    zeroed_by_full_withdrawal = v_next_full_withdrawal,
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
    v_direction,
    v_posting_amount,
    v_balance_before,
    v_balance_after,
    v_actor_id
  );

  update public.transactions
  set
    status = 'approved'::public.transaction_status,
    net_amount_minor = v_posting_amount,
    charge_required = case
      when type = 'deposit'::public.transaction_type
        then v_charge_required_now
      else charge_required
    end,
    charge_reason = case
      when type = 'deposit'::public.transaction_type
        then coalesce(v_charge_reason_now, charge_reason)
      else charge_reason
    end,
    reviewed_by = v_actor_id,
    reviewed_by_name = v_actor_name,
    reviewed_at = now()
  where id = v_transaction.id
  returning *
  into v_updated;

  if v_transaction.type = 'reversal'::public.transaction_type then
    update public.transactions
    set
      status = 'reversed'::public.transaction_status,
      reversed_by_transaction_id = v_transaction.id
    where id = v_original.id;
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
      when v_transaction.type = 'reversal'::public.transaction_type
        then 'transaction.reversal_approved'
      else 'transaction.approved'
    end,
    'transaction',
    v_updated.id,
    'Approved ' || v_updated.type::text || ' ' ||
      v_updated.reference || '.',
    jsonb_build_object(
      'reference', v_updated.reference,
      'type', v_updated.type,
      'gross_amount_minor', v_updated.amount_minor,
      'charge_minor', v_updated.charge_minor,
      'net_posting_minor', v_posting_amount,
      'balance_before_minor', v_balance_before,
      'balance_after_minor', v_balance_after,
      'charge_required', v_updated.charge_required,
      'charge_reason', v_updated.charge_reason,
      'original_transaction_id', v_updated.reversal_of
    )
  );

  return jsonb_build_object(
    'transaction', to_jsonb(v_updated),
    'gross_amount_minor', v_updated.amount_minor,
    'charge_minor', v_updated.charge_minor,
    'net_posting_minor', v_posting_amount,
    'balance_before_minor', v_balance_before,
    'balance_after_minor', v_balance_after
  );
end;
$$;

-- ---------------------------------------------------------
-- 10. SUMMARY NOW TRACKS NET DEPOSITS + CHARGES
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
  from public.transactions t;
$$;

-- ---------------------------------------------------------
-- 11. PRIVILEGES
-- ---------------------------------------------------------

revoke execute on function public.initiate_transaction(
  uuid,
  public.transaction_type,
  bigint,
  bigint,
  text
) from public, anon;

grant execute on function public.initiate_transaction(
  uuid,
  public.transaction_type,
  bigint,
  bigint,
  text
) to authenticated;

revoke execute on function public.request_transaction_reversal(
  uuid,
  text
) from public, anon;

grant execute on function public.request_transaction_reversal(
  uuid,
  text
) to authenticated;

revoke execute on function public.approve_transaction(uuid)
from public, anon;

grant execute on function public.approve_transaction(uuid)
to authenticated;

revoke execute on function public.get_transaction_summary()
from public, anon;

grant execute on function public.get_transaction_summary()
to authenticated;

commit;
