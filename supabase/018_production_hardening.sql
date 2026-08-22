-- =========================================================
-- BL MULTI CONCEPT - PRODUCTION HARDENING
-- Run AFTER 017_staff_transaction_only.sql
-- =========================================================

begin;

-- ---------------------------------------------------------
-- 1. IDEMPOTENT TRANSACTION SUBMISSION
-- The existing five-argument function remains as the single
-- source of business rules, but browser clients can call only
-- this idempotent wrapper.
-- ---------------------------------------------------------

alter table public.transactions
  add column if not exists idempotency_key uuid;

create unique index if not exists transactions_initiator_idempotency_idx
  on public.transactions(initiated_by, idempotency_key)
  where idempotency_key is not null;

create or replace function public.initiate_transaction(
  p_account_id uuid,
  p_type public.transaction_type,
  p_amount_minor bigint,
  p_charge_minor bigint,
  p_description text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_existing public.transactions;
  v_created public.transactions;
  v_result jsonb;
begin
  if v_actor_id is null or not private.can_initiate_transactions() then
    raise exception 'You do not have permission to initiate transactions.'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'A transaction request identifier is required.'
      using errcode = '22023';
  end if;

  if p_amount_minor is null
    or p_amount_minor <= 0
    or p_amount_minor > 9007199254740991 then
    raise exception 'Transaction amount is outside the supported range.'
      using errcode = '22003';
  end if;

  if coalesce(p_charge_minor, 0) > 9007199254740991 then
    raise exception 'Transaction charge is outside the supported range.'
      using errcode = '22003';
  end if;

  -- Serialize retries for the same user/request without locking unrelated work.
  perform pg_advisory_xact_lock(
    hashtextextended(
      v_actor_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select *
  into v_existing
  from public.transactions t
  where t.initiated_by = v_actor_id
    and t.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.account_id is distinct from p_account_id
      or v_existing.type is distinct from p_type
      or v_existing.amount_minor is distinct from p_amount_minor
      or v_existing.charge_minor is distinct from coalesce(p_charge_minor, 0)
      or v_existing.description is distinct from v_description then
      raise exception 'This request identifier was already used for different transaction details.'
        using errcode = '23505';
    end if;

    return to_jsonb(v_existing);
  end if;

  v_result := public.initiate_transaction(
    p_account_id,
    p_type,
    p_amount_minor,
    p_charge_minor,
    v_description
  );

  update public.transactions t
  set idempotency_key = p_idempotency_key
  where t.id = (v_result ->> 'id')::uuid
    and t.initiated_by = v_actor_id
  returning *
  into v_created;

  if not found then
    raise exception 'The transaction request could not be finalized.'
      using errcode = 'P0002';
  end if;

  return to_jsonb(v_created);
end;
$$;

revoke all on function public.initiate_transaction(
  uuid, public.transaction_type, bigint, bigint, text
) from public, anon, authenticated;

revoke all on function public.initiate_transaction(
  uuid, public.transaction_type, bigint, bigint, text, uuid
) from public, anon;

grant execute on function public.initiate_transaction(
  uuid, public.transaction_type, bigint, bigint, text, uuid
) to authenticated;

-- ---------------------------------------------------------
-- 2. ROLE-SCOPED FILTERED TOTALS
-- Staff always receive only their own totals. Management can
-- optionally filter by a selected staff maker.
-- ---------------------------------------------------------

create or replace function public.get_filtered_transaction_totals(
  p_search text default null,
  p_status text default null,
  p_type text default null,
  p_maker_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.app_role := private.current_app_role();
  v_actor_id uuid := auth.uid();
  v_search text := nullif(
    left(
      btrim(
        regexp_replace(
          coalesce(p_search, ''),
          '[,%()_]+',
          ' ',
          'g'
        )
      ),
      80
    ),
    ''
  );
  v_result jsonb;
begin
  if v_actor_id is null or not private.is_active_user() then
    raise exception 'Your staff account is not active.'
      using errcode = '42501';
  end if;

  if p_status is not null
    and p_status not in ('pending', 'approved', 'rejected', 'reversed') then
    raise exception 'Invalid transaction status filter.'
      using errcode = '22023';
  end if;

  if p_type is not null
    and p_type not in (
      'deposit',
      'withdrawal',
      'reversal',
      'loan_disbursement',
      'loan_repayment',
      'overdraft'
    ) then
    raise exception 'Invalid transaction type filter.'
      using errcode = '22023';
  end if;

  select jsonb_build_object(
    'transaction_count', count(*)::bigint,
    'gross_amount_minor', coalesce(sum(t.amount_minor), 0)::text,
    'charge_amount_minor', coalesce(sum(t.charge_minor), 0)::text,
    'net_amount_minor', coalesce(sum(t.net_amount_minor), 0)::text
  )
  into v_result
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.customers c on c.id = t.customer_id
  where (
      v_role <> 'staff'::public.app_role
      or t.initiated_by = v_actor_id
    )
    and (
      v_role = 'staff'::public.app_role
      or p_maker_id is null
      or t.initiated_by = p_maker_id
    )
    and (p_status is null or t.status::text = p_status)
    and (p_type is null or t.type::text = p_type)
    and (
      v_search is null
      or t.reference ilike '%' || v_search || '%'
      or c.customer_number ilike '%' || v_search || '%'
      or concat_ws(' ', c.first_name, nullif(c.middle_name, ''), c.last_name)
        ilike '%' || v_search || '%'
      or a.account_number ilike '%' || v_search || '%'
      or coalesce(t.description, '') ilike '%' || v_search || '%'
    );

  return v_result;
end;
$$;

revoke all on function public.get_filtered_transaction_totals(
  text, text, text, uuid
) from public, anon;

grant execute on function public.get_filtered_transaction_totals(
  text, text, text, uuid
) to authenticated;

-- ---------------------------------------------------------
-- 3. CONTROLLED CUSTOMER AND ACCOUNT LOOKUP
-- Staff can search for the minimum data needed to initiate a
-- transaction without receiving unrestricted table access.
-- ---------------------------------------------------------

create or replace function public.search_transaction_customers(
  p_term text,
  p_limit integer default 8
)
returns table (
  id uuid,
  customer_number text,
  name text,
  phone text,
  status public.customer_status,
  matched_account_id uuid,
  matched_account_number text,
  matched_account_type public.account_type
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_term text := left(
    btrim(
      regexp_replace(
        coalesce(p_term, ''),
        '[,%()_]+',
        ' ',
        'g'
      )
    ),
    80
  );
  v_customer_number text;
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 15);
begin
  if auth.uid() is null or not private.can_initiate_transactions() then
    raise exception 'You do not have permission to search transaction customers.'
      using errcode = '42501';
  end if;

  if v_term = '' then
    return;
  end if;

  if v_term ~ '^[0-9]{1,3}$' then
    v_customer_number := lpad(v_term, 3, '0');
  elsif length(v_term) < 2 then
    raise exception 'Enter at least two characters to search.'
      using errcode = '22023';
  else
    v_customer_number := v_term;
  end if;

  return query
  select
    c.id,
    c.customer_number,
    concat_ws(' ', c.first_name, nullif(c.middle_name, ''), c.last_name)::text,
    coalesce(c.phone, '')::text,
    c.status,
    matched.id,
    matched.account_number,
    matched.account_type
  from public.customers c
  left join lateral (
    select a.id, a.account_number, a.account_type
    from public.accounts a
    where a.customer_id = c.id
      and a.account_number ilike '%' || v_term || '%'
    order by
      (a.account_number = v_term) desc,
      a.created_at,
      a.id
    limit 1
  ) matched on true
  where c.customer_number ilike '%' || v_customer_number || '%'
    or c.first_name ilike '%' || v_term || '%'
    or coalesce(c.middle_name, '') ilike '%' || v_term || '%'
    or c.last_name ilike '%' || v_term || '%'
    or coalesce(c.phone, '') ilike '%' || v_term || '%'
    or coalesce(c.email, '') ilike '%' || v_term || '%'
    or matched.id is not null
  order by
    (c.customer_number = v_customer_number) desc,
    (matched.account_number = v_term) desc nulls last,
    c.first_name,
    c.last_name,
    c.id
  limit v_limit;
end;
$$;

revoke all on function public.search_transaction_customers(text, integer)
from public, anon;
grant execute on function public.search_transaction_customers(text, integer)
to authenticated;

create or replace function public.get_transaction_account(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not private.can_initiate_transactions() then
    raise exception 'You do not have permission to view this transaction account.'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', a.id,
    'account_number', a.account_number,
    'account_type', a.account_type,
    'currency', a.currency,
    'status', a.status,
    'cached_balance_minor', a.cached_balance_minor,
    'customer_id', a.customer_id,
    'customers', jsonb_build_object(
      'id', c.id,
      'customer_number', c.customer_number,
      'first_name', c.first_name,
      'middle_name', c.middle_name,
      'last_name', c.last_name,
      'status', c.status
    )
  )
  into v_result
  from public.accounts a
  join public.customers c on c.id = a.customer_id
  where a.id = p_account_id;

  if v_result is null then
    raise exception 'Account was not found.'
      using errcode = 'P0002';
  end if;

  return v_result;
end;
$$;

revoke all on function public.get_transaction_account(uuid)
from public, anon;
grant execute on function public.get_transaction_account(uuid)
to authenticated;

drop policy if exists "active staff can view customers"
on public.customers;

create policy "active staff can view customers"
on public.customers
for select
to authenticated
using (
  (select private.is_active_user())
  and (
    (select private.current_app_role()) <> 'staff'::public.app_role
    or exists (
      select 1
      from public.transactions t
      where t.customer_id = customers.id
        and t.initiated_by = (select auth.uid())
    )
  )
);

drop policy if exists "active staff can view accounts"
on public.accounts;

create policy "active staff can view accounts"
on public.accounts
for select
to authenticated
using (
  (select private.is_active_user())
  and (
    (select private.current_app_role()) <> 'staff'::public.app_role
    or exists (
      select 1
      from public.transactions t
      where t.account_id = accounts.id
        and t.initiated_by = (select auth.uid())
    )
  )
);

-- ---------------------------------------------------------
-- 4. DETERMINISTIC BULK APPROVAL LOCKING
-- Selected transaction rows and their account rows are locked
-- in stable order before any ledger posting starts.
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
    raise exception 'Select at least one pending transaction.'
      using errcode = '22023';
  end if;

  select count(*)
  into v_requested
  from (select distinct unnest(p_transaction_ids) as id) x;

  if v_requested > 100 then
    raise exception 'A bulk approval is limited to 100 transactions at a time.'
      using errcode = '22023';
  end if;

  perform t.id
  from public.transactions t
  where t.id = any(p_transaction_ids)
    and t.initiated_by = p_staff_id
    and t.status = 'pending'::public.transaction_status
  order by t.id
  for update of t;

  perform a.id
  from public.accounts a
  where exists (
    select 1
    from public.transactions t
    where t.id = any(p_transaction_ids)
      and t.initiated_by = p_staff_id
      and t.status = 'pending'::public.transaction_status
      and t.account_id = a.id
  )
  order by a.id
  for update of a;

  v_actor_name := private.current_actor_name();
  v_actor_email := private.current_actor_email();

  for v_id in
    select distinct requested.id
    from unnest(p_transaction_ids) as requested(id)
    order by requested.id
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

-- ---------------------------------------------------------
-- 5. RECOVER ABANDONED SMS CLAIMS
-- A worker crash can no longer leave an item in processing forever.
-- ---------------------------------------------------------

drop index if exists public.sms_outbox_dispatch_idx;

create index sms_outbox_dispatch_idx
  on public.sms_outbox(status, next_attempt_at, created_at)
  where status in ('pending', 'failed', 'processing');

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
    where o.attempts < o.max_attempts
      and (
        (
          o.status in ('pending', 'failed')
          and o.next_attempt_at <= now()
        )
        or (
          o.status = 'processing'
          and coalesce(o.last_attempt_at, o.created_at)
            <= now() - interval '10 minutes'
        )
      )
    order by o.created_at, o.id
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

notify pgrst, 'reload schema';

commit;
