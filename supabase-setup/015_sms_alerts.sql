-- =========================================================
-- BL MULTI CONCEPT - STEP 15
-- SMS ALERT OUTBOX + EVENT TRIGGERS
--
-- Provider sending happens only in the Supabase Edge Function.
-- No API token is stored in SQL or browser code.
--
-- Run AFTER:
--   009_loans_repayments.sql
--   011_one_off_overdraft_flow.sql
--   014_customer_dashboard_bulk_approval.sql
-- =========================================================

begin;

create table if not exists public.sms_outbox (
  id uuid primary key default gen_random_uuid(),

  event_key text not null unique,
  event_type text not null,

  entity_id uuid,
  customer_id uuid references public.customers(id) on delete restrict,

  phone text,
  payload jsonb not null default '{}'::jsonb,

  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5,

  provider_message_id text,
  error_text text,

  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,

  constraint sms_outbox_status_check
    check (status in ('pending', 'processing', 'sent', 'failed', 'skipped')),

  constraint sms_outbox_attempts_valid
    check (attempts >= 0 and max_attempts between 1 and 20)
);

create index if not exists sms_outbox_dispatch_idx
  on public.sms_outbox(status, next_attempt_at, created_at)
  where status in ('pending', 'failed');

create index if not exists sms_outbox_customer_idx
  on public.sms_outbox(customer_id, created_at desc);

alter table public.sms_outbox enable row level security;

revoke all on table public.sms_outbox from public, anon, authenticated;
grant select, insert, update on table public.sms_outbox to service_role;

-- ---------------------------------------------------------
-- Enqueue helper
-- ---------------------------------------------------------

create or replace function private.enqueue_sms_event(
  p_event_key text,
  p_event_type text,
  p_entity_id uuid,
  p_customer_id uuid,
  p_phone text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  insert into public.sms_outbox (
    event_key,
    event_type,
    entity_id,
    customer_id,
    phone,
    payload,
    status,
    error_text
  )
  values (
    p_event_key,
    p_event_type,
    p_entity_id,
    p_customer_id,
    v_phone,
    coalesce(p_payload, '{}'::jsonb),
    case when v_phone is null then 'skipped' else 'pending' end,
    case when v_phone is null then 'Customer has no phone number.' else null end
  )
  on conflict (event_key) do nothing;
end;
$$;

revoke all on function private.enqueue_sms_event(
  text, text, uuid, uuid, text, jsonb
) from public, anon, authenticated;

-- ---------------------------------------------------------
-- Transaction approval / rejection alerts
-- ---------------------------------------------------------

create or replace function private.queue_transaction_sms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
  v_ledger public.ledger_entries;
  v_event_type text;
begin
  if new.status = old.status then
    return new;
  end if;

  -- Loan/overdraft transactions have their own richer alerts.
  if new.type::text not in ('deposit', 'withdrawal', 'reversal') then
    return new;
  end if;

  if new.status::text not in ('approved', 'rejected') then
    return new;
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id = new.customer_id;

  if new.status::text = 'approved' then
    select *
    into v_ledger
    from public.ledger_entries le
    where le.transaction_id = new.id;

    v_event_type := 'transaction.approved';
  else
    v_event_type := 'transaction.rejected';
  end if;

  perform private.enqueue_sms_event(
    'transaction:' || new.id::text || ':' || new.status::text,
    v_event_type,
    new.id,
    new.customer_id,
    v_customer.phone,
    jsonb_build_object(
      'reference', new.reference,
      'transaction_type', new.type::text,
      'amount_minor', new.amount_minor,
      'charge_minor', coalesce(new.charge_minor, 0),
      'net_amount_minor', coalesce(new.net_amount_minor, new.amount_minor),
      'status', new.status::text,
      'rejection_reason', new.rejection_reason,
      'balance_after_minor', case when found then v_ledger.balance_after_minor else null end,
      'customer_name', concat_ws(
        ' ',
        nullif(btrim(v_customer.first_name), ''),
        nullif(btrim(coalesce(v_customer.middle_name, '')), ''),
        nullif(btrim(coalesce(v_customer.last_name, '')), '')
      ),
      'event_at', coalesce(new.reviewed_at, now())
    )
  );

  return new;
end;
$$;

drop trigger if exists transactions_sms_outbox_trigger on public.transactions;

create trigger transactions_sms_outbox_trigger
after update of status on public.transactions
for each row
execute function private.queue_transaction_sms();

-- ---------------------------------------------------------
-- Loan approval / rejection alerts
-- ---------------------------------------------------------

create or replace function private.queue_loan_sms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
  v_account public.accounts;
  v_event_type text;
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status::text not in ('active', 'rejected') then
    return new;
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id = new.customer_id;

  select *
  into v_account
  from public.accounts a
  where a.id = new.account_id;

  v_event_type :=
    case when new.status::text = 'active'
      then 'loan.approved'
      else 'loan.rejected'
    end;

  perform private.enqueue_sms_event(
    'loan:' || new.id::text || ':' || new.status::text,
    v_event_type,
    new.id,
    new.customer_id,
    v_customer.phone,
    jsonb_build_object(
      'loan_number', new.loan_number,
      'principal_minor', new.principal_minor,
      'interest_rate_bps', new.interest_rate_bps,
      'interest_minor', new.interest_minor,
      'total_payable_minor', new.total_payable_minor,
      'principal_outstanding_minor', new.principal_outstanding_minor,
      'interest_outstanding_minor', new.interest_outstanding_minor,
      'term_months', new.term_months,
      'due_date', new.due_date,
      'status', new.status::text,
      'rejection_reason', new.rejection_reason,
      'balance_after_minor', v_account.cached_balance_minor,
      'customer_name', concat_ws(
        ' ',
        nullif(btrim(v_customer.first_name), ''),
        nullif(btrim(coalesce(v_customer.middle_name, '')), ''),
        nullif(btrim(coalesce(v_customer.last_name, '')), '')
      ),
      'event_at', coalesce(new.approved_at, new.rejected_at, now())
    )
  );

  return new;
end;
$$;

drop trigger if exists loans_sms_outbox_trigger on public.loans;

create trigger loans_sms_outbox_trigger
after update of status on public.loans
for each row
execute function private.queue_loan_sms();

-- ---------------------------------------------------------
-- Loan repayment alerts
--
-- Approval is queued only after transaction_id is attached because
-- approve_loan_repayment updates the loan outstanding balance before
-- that final repayment update. This lets the SMS capture the actual
-- remaining balance.
-- ---------------------------------------------------------

create or replace function private.queue_loan_repayment_sms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_loan public.loans;
  v_customer public.customers;
  v_event_type text;
begin
  if new.status::text = 'approved'
     and old.transaction_id is null
     and new.transaction_id is not null then

    select *
    into v_loan
    from public.loans l
    where l.id = new.loan_id;

    select *
    into v_customer
    from public.customers c
    where c.id = v_loan.customer_id;

    perform private.enqueue_sms_event(
      'loan-repayment:' || new.id::text || ':approved',
      'loan_repayment.approved',
      new.id,
      v_loan.customer_id,
      v_customer.phone,
      jsonb_build_object(
        'repayment_number', new.repayment_number,
        'loan_number', v_loan.loan_number,
        'amount_minor', new.amount_minor,
        'interest_component_minor', new.interest_component_minor,
        'principal_component_minor', new.principal_component_minor,
        'principal_outstanding_minor', v_loan.principal_outstanding_minor,
        'interest_outstanding_minor', v_loan.interest_outstanding_minor,
        'loan_status', v_loan.status::text,
        'payment_method', new.payment_method,
        'customer_name', concat_ws(
          ' ',
          nullif(btrim(v_customer.first_name), ''),
          nullif(btrim(coalesce(v_customer.middle_name, '')), ''),
          nullif(btrim(coalesce(v_customer.last_name, '')), '')
        ),
        'event_at', coalesce(new.approved_at, now())
      )
    );

    return new;
  end if;

  if new.status <> old.status
     and new.status::text = 'rejected' then

    select *
    into v_loan
    from public.loans l
    where l.id = new.loan_id;

    select *
    into v_customer
    from public.customers c
    where c.id = v_loan.customer_id;

    perform private.enqueue_sms_event(
      'loan-repayment:' || new.id::text || ':rejected',
      'loan_repayment.rejected',
      new.id,
      v_loan.customer_id,
      v_customer.phone,
      jsonb_build_object(
        'repayment_number', new.repayment_number,
        'loan_number', v_loan.loan_number,
        'amount_minor', new.amount_minor,
        'status', new.status::text,
        'rejection_reason', new.rejection_reason,
        'customer_name', concat_ws(
          ' ',
          nullif(btrim(v_customer.first_name), ''),
          nullif(btrim(coalesce(v_customer.middle_name, '')), ''),
          nullif(btrim(coalesce(v_customer.last_name, '')), '')
        ),
        'event_at', coalesce(new.rejected_at, now())
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists loan_repayments_sms_outbox_trigger
on public.loan_repayments;

create trigger loan_repayments_sms_outbox_trigger
after update on public.loan_repayments
for each row
execute function private.queue_loan_repayment_sms();

-- ---------------------------------------------------------
-- Overdraft approval / rejection alerts
-- ---------------------------------------------------------

create or replace function private.queue_overdraft_sms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customers;
  v_event_type text;
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status::text not in ('active', 'rejected') then
    return new;
  end if;

  select *
  into v_customer
  from public.customers c
  where c.id = new.customer_id;

  v_event_type :=
    case when new.status::text = 'active'
      then 'overdraft.approved'
      else 'overdraft.rejected'
    end;

  perform private.enqueue_sms_event(
    'overdraft:' || new.id::text || ':' || new.status::text,
    v_event_type,
    new.id,
    new.customer_id,
    v_customer.phone,
    jsonb_build_object(
      'overdraft_number', new.overdraft_number,
      'requested_amount_minor', new.requested_amount_minor,
      'charge_minor', new.charge_minor,
      'balance_after_minor', new.balance_after_approval_minor,
      'exposure_after_minor', new.overdraft_exposure_after_approval_minor,
      'status', new.status::text,
      'rejection_reason', new.rejection_reason,
      'customer_name', concat_ws(
        ' ',
        nullif(btrim(v_customer.first_name), ''),
        nullif(btrim(coalesce(v_customer.middle_name, '')), ''),
        nullif(btrim(coalesce(v_customer.last_name, '')), '')
      ),
      'event_at', coalesce(new.approved_at, new.rejected_at, now())
    )
  );

  return new;
end;
$$;

drop trigger if exists overdrafts_sms_outbox_trigger on public.overdrafts;

create trigger overdrafts_sms_outbox_trigger
after update of status on public.overdrafts
for each row
execute function private.queue_overdraft_sms();

-- ---------------------------------------------------------
-- Edge Function queue claim / completion RPCs
-- SERVICE ROLE ONLY
-- ---------------------------------------------------------

create or replace function public.claim_sms_outbox(
  p_limit integer default 25
)
returns setof public.sms_outbox
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  return query
  with claimable as (
    select o.id
    from public.sms_outbox o
    where o.status in ('pending', 'failed')
      and o.attempts < o.max_attempts
      and o.next_attempt_at <= now()
    order by o.created_at
    for update skip locked
    limit v_limit
  ),
  claimed as (
    update public.sms_outbox o
    set
      status = 'processing',
      attempts = o.attempts + 1,
      last_attempt_at = now(),
      error_text = null
    from claimable c
    where o.id = c.id
    returning o.*
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_sms_outbox(integer)
from public, anon, authenticated;
grant execute on function public.claim_sms_outbox(integer)
to service_role;

create or replace function public.complete_sms_outbox_item(
  p_id uuid,
  p_status text,
  p_provider_message_id text default null,
  p_error_text text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('sent', 'failed', 'skipped') then
    raise exception 'Invalid SMS completion status.';
  end if;

  update public.sms_outbox
  set
    status = p_status,
    provider_message_id = nullif(btrim(coalesce(p_provider_message_id, '')), ''),
    error_text = left(nullif(btrim(coalesce(p_error_text, '')), ''), 1000),
    sent_at = case when p_status = 'sent' then now() else sent_at end,
    next_attempt_at =
      case
        when p_status = 'failed'
          then now() + make_interval(
            mins => least(greatest(attempts * 2, 2), 60)
          )
        else next_attempt_at
      end
  where id = p_id;
end;
$$;

revoke all on function public.complete_sms_outbox_item(
  uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.complete_sms_outbox_item(
  uuid, text, text, text
) to service_role;

commit;
