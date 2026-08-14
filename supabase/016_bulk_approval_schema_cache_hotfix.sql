-- BL Multi Concept
-- Pending transaction approval + PostgREST schema-cache hotfix
-- 2026-08-14
--
-- Run this ONCE in Supabase Dashboard -> SQL Editor if the browser reports:
--   Could not find the function public.get_pending_transaction_makers
--   without parameters in the schema cache
--
-- This recreates the two bulk-approval RPCs and explicitly tells PostgREST
-- to reload its schema cache. It is safe to re-run.

begin;

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

-- Force Supabase/PostgREST to refresh callable RPC signatures immediately.
notify pgrst, 'reload schema';

-- Verification: these rows should include the signatures
--   get_pending_transaction_makers()
--   bulk_approve_staff_transactions(uuid, uuid[])
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'get_pending_transaction_makers',
    'bulk_approve_staff_transactions'
  )
order by p.proname, arguments;
