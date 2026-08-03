-- =========================================================
-- STEP 5B PATCH
-- One-off overdraft request / payout model
--
-- Run AFTER:
--   010_overdrafts.sql
--
-- Example implemented:
--
-- Current account balance:      ₦5,000
-- Requested overdraft payout:  ₦10,000
-- Manual charge:                ₦1,000
--
-- On approval:
-- Account ledger debit:        ₦10,000
-- New account balance:         -₦5,000
-- Overdraft exposure:           ₦5,000
-- Charge recorded separately:   ₦1,000
--
-- The charge does NOT:
-- - increase the negative account balance,
-- - reduce the payout,
-- - create a customer account ledger debit.
-- =========================================================

-- Add transaction enum value before starting the transaction.
alter type public.transaction_type
  add value if not exists 'overdraft';

begin;

-- ---------------------------------------------------------
-- 1. OVERDRAFT REQUEST FIELDS
-- ---------------------------------------------------------

alter table public.overdrafts
  add column if not exists requested_amount_minor bigint;

alter table public.overdrafts
  add column if not exists charge_minor bigint not null default 0;

alter table public.overdrafts
  add column if not exists balance_at_request_minor bigint;

alter table public.overdrafts
  add column if not exists projected_balance_minor bigint;

alter table public.overdrafts
  add column if not exists overdraft_exposure_at_request_minor bigint;

alter table public.overdrafts
  add column if not exists balance_before_approval_minor bigint;

alter table public.overdrafts
  add column if not exists balance_after_approval_minor bigint;

alter table public.overdrafts
  add column if not exists overdraft_exposure_after_approval_minor bigint;

alter table public.overdrafts
  add column if not exists disbursement_transaction_id uuid
    references public.transactions(id)
    on delete restrict;

-- Map older Step 5B test records so the table remains readable.
update public.overdrafts
set requested_amount_minor = coalesce(
      requested_amount_minor,
      limit_minor
    ),
    balance_at_request_minor = coalesce(
      balance_at_request_minor,
      0
    ),
    projected_balance_minor = coalesce(
      projected_balance_minor,
      -limit_minor
    ),
    overdraft_exposure_at_request_minor = coalesce(
      overdraft_exposure_at_request_minor,
      limit_minor
    )
where requested_amount_minor is null;

alter table public.overdrafts
  alter column requested_amount_minor set not null;

alter table public.overdrafts
  alter column balance_at_request_minor set not null;

alter table public.overdrafts
  alter column projected_balance_minor set not null;

alter table public.overdrafts
  alter column overdraft_exposure_at_request_minor set not null;

alter table public.overdrafts
  drop constraint if exists overdrafts_requested_amount_positive;

alter table public.overdrafts
  add constraint overdrafts_requested_amount_positive
  check (requested_amount_minor > 0);

alter table public.overdrafts
  drop constraint if exists overdrafts_charge_nonnegative;

alter table public.overdrafts
  add constraint overdrafts_charge_nonnegative
  check (charge_minor >= 0);

alter table public.overdrafts
  drop constraint if exists overdrafts_request_must_go_negative;

alter table public.overdrafts
  add constraint overdrafts_request_must_go_negative
  check (projected_balance_minor < 0);

alter table public.overdrafts
  drop constraint if exists overdrafts_exposure_positive;

alter table public.overdrafts
  add constraint overdrafts_exposure_positive
  check (overdraft_exposure_at_request_minor > 0);

-- Old "limit" is now only a legacy compatibility column.
comment on column public.overdrafts.limit_minor is
  'Legacy Step 5B column. New one-off overdrafts use requested_amount_minor.';

-- ---------------------------------------------------------
-- 2. ONLY ONE PENDING REQUEST PER ACCOUNT
-- Multiple approved historical overdrafts may exist.
-- ---------------------------------------------------------

drop index if exists public.overdrafts_one_open_facility_per_account_idx;

create unique index if not exists overdrafts_one_pending_per_account_idx
  on public.overdrafts(account_id)
  where status = 'pending'::public.overdraft_status;

-- ---------------------------------------------------------
-- 3. REMOVE FACILITY-LIMIT HELPERS
-- Ordinary withdrawals must not automatically borrow money.
-- ---------------------------------------------------------

drop function if exists private.active_overdraft_limit(uuid);
drop function if exists private.account_available_to_withdraw(uuid);

-- ---------------------------------------------------------
-- 4. DIRECTORY VIEW
-- ---------------------------------------------------------

drop view if exists public.overdraft_directory;

create view public.overdraft_directory
with (security_invoker = true)
as
select
  o.id,
  o.overdraft_number,

  o.requested_amount_minor,
  o.charge_minor,

  o.balance_at_request_minor,
  o.projected_balance_minor,
  o.overdraft_exposure_at_request_minor,

  o.balance_before_approval_minor,
  o.balance_after_approval_minor,
  o.overdraft_exposure_after_approval_minor,

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

  o.disbursement_transaction_id,

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
  ) as current_overdraft_exposure_minor,

  case
    when o.status = 'active'::public.overdraft_status
      and a.cached_balance_minor < 0
    then true
    else false
  end as still_outstanding,

  case
    when o.status = 'active'::public.overdraft_status
      and a.cached_balance_minor >= 0
    then true
    else false
  end as eligible_to_close

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
-- 5. CUSTOMER LOOKUP
-- No reusable overdraft withdrawal limit is exposed anymore.
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

        'overdraft_outstanding_minor',
          greatest(
            -a.cached_balance_minor,
            0
          ),

        'withdrawable_minor',
          greatest(
            a.cached_balance_minor,
            0
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
-- 6. RESTORE NORMAL WITHDRAWAL BEHAVIOR
-- A normal withdrawal cannot make the account negative.
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

    if v_account.cached_balance_minor < p_amount_minor then
      raise exception
        'Insufficient account balance for this withdrawal. Use an overdraft request if the customer needs to withdraw beyond the available balance.'
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
        v_transaction.net_amount_minor
    )
  );

  return to_jsonb(v_transaction);
end;
$$;

-- ---------------------------------------------------------
-- 7. REQUEST ONE-OFF OVERDRAFT PAYOUT
-- ---------------------------------------------------------

drop function if exists public.request_overdraft(
  uuid,
  bigint,
  date,
  text
);

create or replace function public.request_overdraft(
  p_account_id uuid,
  p_requested_amount_minor bigint,
  p_charge_minor bigint,
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
  v_projected_balance bigint;
  v_exposure bigint;
  v_overdraft public.overdrafts;
begin
  if v_actor_id is null
    or not private.can_request_overdrafts() then
    raise exception
      'You do not have permission to create overdraft requests.'
      using errcode = '42501';
  end if;

  if p_requested_amount_minor is null
    or p_requested_amount_minor <= 0 then
    raise exception
      'Requested payout must be greater than zero.'
      using errcode = '22023';
  end if;

  if p_charge_minor is null
    or p_charge_minor < 0 then
    raise exception
      'Overdraft charge cannot be negative.'
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

  v_projected_balance :=
    v_account.cached_balance_minor -
    p_requested_amount_minor;

  if v_projected_balance >= 0 then
    raise exception
      'This request would not create an overdraft. Use a normal withdrawal instead.'
      using errcode = '22023';
  end if;

  v_exposure :=
    greatest(
      -v_projected_balance,
      0
    );

  if exists (
    select 1
    from public.overdrafts o
    where o.account_id = v_account.id
      and o.status = 'pending'::public.overdraft_status
  ) then
    raise exception
      'This account already has a pending overdraft request.'
      using errcode = '23505';
  end if;

  v_actor_name :=
    private.current_actor_name();

  insert into public.overdrafts (
    overdraft_number,

    customer_id,
    account_id,

    -- Keep legacy field populated for compatibility,
    -- but new logic uses requested_amount_minor.
    limit_minor,

    requested_amount_minor,
    charge_minor,

    balance_at_request_minor,
    projected_balance_minor,
    overdraft_exposure_at_request_minor,

    status,
    purpose,

    requested_by,
    requested_by_name
  )
  values (
    private.next_overdraft_number(),

    v_customer.id,
    v_account.id,

    p_requested_amount_minor,

    p_requested_amount_minor,
    p_charge_minor,

    v_account.cached_balance_minor,
    v_projected_balance,
    v_exposure,

    'pending'::public.overdraft_status,
    nullif(
      btrim(coalesce(p_purpose, '')),
      ''
    ),

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
      v_overdraft.overdraft_number ||
      '.',

    jsonb_build_object(
      'overdraft_number',
        v_overdraft.overdraft_number,

      'customer_number',
        v_customer.customer_number,

      'account_number',
        v_account.account_number,

      'requested_amount_minor',
        v_overdraft.requested_amount_minor,

      'charge_minor',
        v_overdraft.charge_minor,

      'balance_at_request_minor',
        v_overdraft.balance_at_request_minor,

      'projected_balance_minor',
        v_overdraft.projected_balance_minor,

      'overdraft_exposure_at_request_minor',
        v_overdraft.overdraft_exposure_at_request_minor
    )
  );

  return to_jsonb(v_overdraft);
end;
$$;

-- ---------------------------------------------------------
-- 8. APPROVE ONE-OFF OVERDRAFT
-- Requested payout is debited from the account.
-- Charge is recorded separately and does not affect the account.
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

  v_balance_before bigint;
  v_balance_after bigint;
  v_exposure_after bigint;

  v_transaction public.transactions;
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

  if v_overdraft.status <>
    'pending'::public.overdraft_status then
    raise exception
      'Only pending overdraft requests can be approved.'
      using errcode = '22023';
  end if;

  if v_overdraft.requested_by =
    v_actor_id then
    raise exception
      'Maker-checker protection: you cannot approve your own overdraft request.'
      using errcode = '42501';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id =
    v_overdraft.account_id
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
    v_overdraft.customer_id;

  if v_account.status <>
    'active'::public.account_status
    or v_customer.status <>
      'active'::public.customer_status then
    raise exception
      'The customer and account must both be active before approval.'
      using errcode = '22023';
  end if;

  v_balance_before :=
    v_account.cached_balance_minor;

  v_balance_after :=
    v_balance_before -
    v_overdraft.requested_amount_minor;

  -- It must still truly be an overdraft at approval time.
  if v_balance_after >= 0 then
    raise exception
      'The customer now has enough balance for this payout. Reject this overdraft request and use a normal withdrawal instead.'
      using errcode = '22023';
  end if;

  v_exposure_after :=
    greatest(
      -v_balance_after,
      0
    );

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

    v_overdraft.customer_id,
    v_overdraft.account_id,

    'overdraft'::public.transaction_type,

    v_overdraft.requested_amount_minor,

    -- Account transaction charge remains zero because
    -- overdraft charge is stored separately on overdrafts.
    0,

    v_overdraft.requested_amount_minor,

    false,
    null,

    'approved'::public.transaction_status,

    'Overdraft payout ' ||
      v_overdraft.overdraft_number,

    v_overdraft.requested_by,
    v_overdraft.requested_by_name,

    v_actor_id,
    v_actor_name,
    now()
  )
  returning *
  into v_transaction;

  update public.accounts
  set
    cached_balance_minor =
      v_balance_after,

    zero_since =
      null,

    zeroed_by_full_withdrawal =
      false,

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

    'debit'::public.ledger_direction,

    v_overdraft.requested_amount_minor,

    v_balance_before,
    v_balance_after,

    v_actor_id
  );

  update public.overdrafts
  set
    status =
      'active'::public.overdraft_status,

    balance_before_approval_minor =
      v_balance_before,

    balance_after_approval_minor =
      v_balance_after,

    overdraft_exposure_after_approval_minor =
      v_exposure_after,

    approved_by =
      v_actor_id,

    approved_by_name =
      v_actor_name,

    approved_at =
      now(),

    disbursement_transaction_id =
      v_transaction.id,

    updated_at =
      now()

  where id =
    v_overdraft.id

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
      v_updated.overdraft_number ||
      '.',

    jsonb_build_object(
      'overdraft_number',
        v_updated.overdraft_number,

      'requested_amount_minor',
        v_updated.requested_amount_minor,

      'charge_minor',
        v_updated.charge_minor,

      'balance_before_minor',
        v_balance_before,

      'balance_after_minor',
        v_balance_after,

      'overdraft_exposure_after_minor',
        v_exposure_after,

      'transaction_reference',
        v_transaction.reference
    )
  );

  return jsonb_build_object(
    'overdraft',
      to_jsonb(v_updated),

    'transaction',
      to_jsonb(v_transaction),

    'balance_before_minor',
      v_balance_before,

    'balance_after_minor',
      v_balance_after,

    'overdraft_exposure_minor',
      v_exposure_after,

    'charge_minor',
      v_updated.charge_minor
  );
end;
$$;

-- ---------------------------------------------------------
-- 9. CLOSE / SETTLE
-- Active overdraft debt is represented by negative account balance.
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
    nullif(
      btrim(coalesce(p_reason, '')),
      ''
    );
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
      'Overdraft record not found.'
      using errcode = 'P0002';
  end if;

  if v_overdraft.status <>
    'active'::public.overdraft_status then
    raise exception
      'Only active overdrafts can be closed.'
      using errcode = '22023';
  end if;

  select *
  into v_account
  from public.accounts a
  where a.id =
    v_overdraft.account_id
  for update;

  if v_account.cached_balance_minor < 0 then
    raise exception
      'This overdraft cannot be closed while the account is negative. Deposit enough funds to return the account to zero or a positive balance first.'
      using errcode = '22003';
  end if;

  update public.overdrafts
  set
    status =
      'closed'::public.overdraft_status,

    closed_by =
      v_actor_id,

    closed_by_name =
      v_actor_name,

    closed_at =
      now(),

    close_reason =
      coalesce(
        v_reason,
        'Overdraft cleared'
      ),

    updated_at =
      now()

  where id =
    v_overdraft.id

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
      v_updated.overdraft_number ||
      '.',

    jsonb_build_object(
      'overdraft_number',
        v_updated.overdraft_number,

      'final_account_balance_minor',
        v_account.cached_balance_minor,

      'reason',
        v_updated.close_reason
    )
  );

  return to_jsonb(v_updated);
end;
$$;

-- ---------------------------------------------------------
-- 10. APPROVE NORMAL TRANSACTIONS
-- Restore ordinary withdrawal balance check.
-- Deposits can repay negative overdraft balances naturally.
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
  where t.id =
    p_transaction_id
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

    if v_balance_before <
      v_transaction.amount_minor then
      raise exception
        'Insufficient account balance at approval time. Use an overdraft request to pay more than the customer has available.'
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

  elsif v_balance_after > 0 then
    v_next_zero_since :=
      null;

    v_next_full_withdrawal :=
      false;

  else
    -- Negative account balance means overdraft remains outstanding.
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
        then
          v_charge_required_now
        else
          charge_required
      end,

    charge_reason =
      case
        when type =
          'deposit'::public.transaction_type
        then
          coalesce(
            v_charge_reason_now,
            charge_reason
          )
        else
          charge_reason
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

  -- If a deposit brings an overdrafted account back to zero or positive,
  -- eligible overdrafts are automatically closed.
  if v_transaction.type =
      'deposit'::public.transaction_type
    and v_balance_before < 0
    and v_balance_after >= 0 then

    update public.overdrafts
    set
      status =
        'closed'::public.overdraft_status,

      closed_by =
        v_actor_id,

      closed_by_name =
        v_actor_name,

      closed_at =
        now(),

      close_reason =
        'Cleared by approved deposit',

      updated_at =
        now()

    where account_id =
        v_account.id

      and status =
        'active'::public.overdraft_status;
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
        v_balance_after
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
      v_balance_after
  );
end;
$$;

-- ---------------------------------------------------------
-- 11. SUMMARY
-- Charges are tracked separately as overdraft revenue.
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
          ),

        'approved_payouts_minor',
          (
            select coalesce(
              sum(o.requested_amount_minor),
              0
            )
            from public.overdrafts o
            where o.status in (
              'active'::public.overdraft_status,
              'closed'::public.overdraft_status
            )
          ),

        'outstanding_exposure_minor',
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
            where exists (
              select 1
              from public.overdrafts o
              where o.account_id = a.id
                and o.status =
                  'active'::public.overdraft_status
            )
          ),

        'approved_charges_minor',
          (
            select coalesce(
              sum(o.charge_minor),
              0
            )
            from public.overdrafts o
            where o.status in (
              'active'::public.overdraft_status,
              'closed'::public.overdraft_status
            )
          )
      )
    else null
  end;
$$;

-- ---------------------------------------------------------
-- 12. PRIVILEGES
-- ---------------------------------------------------------

revoke execute on function public.request_overdraft(
  uuid,
  bigint,
  bigint,
  text
) from public, anon;

grant execute on function public.request_overdraft(
  uuid,
  bigint,
  bigint,
  text
) to authenticated;

commit;
