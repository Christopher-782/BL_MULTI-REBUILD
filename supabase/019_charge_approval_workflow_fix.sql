-- BL_MULTI charge approval workflow fix
-- Pending transactions should not carry charges.

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
begin
  if v_actor_id is null or not private.can_initiate_transactions() then
    raise exception 'You do not have permission to initiate transactions.';
  end if;

  select * into v_account from public.accounts where id = p_account_id;
  if not found then raise exception 'Account not found.'; end if;

  select * into v_customer from public.customers where id = v_account.customer_id;

  v_actor_name := private.current_actor_name();

  insert into public.transactions(
    reference, customer_id, account_id, type, amount_minor,
    charge_minor, net_amount_minor, charge_required, charge_reason,
    status, description, initiated_by, initiated_by_name
  )
  values(
    private.next_transaction_reference(),
    v_customer.id,
    v_account.id,
    p_type,
    p_amount_minor,
    0,
    p_amount_minor,
    false,
    null,
    'pending'::public.transaction_status,
    nullif(btrim(coalesce(p_description,'')), ''),
    v_actor_id,
    v_actor_name
  )
  returning * into v_transaction;

  return to_jsonb(v_transaction);
end;
$$;
