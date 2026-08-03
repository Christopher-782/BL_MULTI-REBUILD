-- =========================================================
-- STEP 3 PATCH: 3-DIGIT CUSTOMER NUMBERS
-- Examples: 001, 002, 003 ... 999
-- =========================================================

begin;

create or replace function private.next_customer_number()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next bigint;
begin
  v_next := nextval('public.customer_number_seq');

  if v_next > 999 then
    raise exception 'Customer number limit reached. The 3-digit format supports only 999 unique customers.'
      using errcode = '22003';
  end if;

  return lpad(v_next::text, 3, '0');
end;
$$;

revoke all on function private.next_customer_number() from public;

commit;
