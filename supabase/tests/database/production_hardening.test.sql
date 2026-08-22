begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(9);

select has_column(
  'public',
  'transactions',
  'idempotency_key',
  'transactions has an idempotency key'
);

select has_index(
  'public',
  'transactions',
  'transactions_initiator_idempotency_idx',
  'transaction idempotency is indexed'
);

select has_function(
  'public',
  'initiate_transaction',
  array['uuid', 'transaction_type', 'bigint', 'bigint', 'text', 'uuid'],
  'idempotent transaction initiation RPC exists'
);

select has_function(
  'public',
  'get_filtered_transaction_totals',
  array['text', 'text', 'text', 'uuid'],
  'filtered totals RPC exists'
);

select has_function(
  'public',
  'search_transaction_customers',
  array['text', 'integer'],
  'controlled customer search RPC exists'
);

select has_function(
  'public',
  'get_transaction_account',
  array['uuid'],
  'controlled account lookup RPC exists'
);

select has_function(
  'public',
  'bulk_approve_staff_transactions',
  array['uuid', 'uuid[]'],
  'bulk approval RPC exists'
);

select has_function(
  'public',
  'claim_sms_outbox',
  array['integer'],
  'recoverable SMS claim RPC exists'
);

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'sms_outbox_dispatch_idx'
      and indexdef like '%processing%'
  ),
  'SMS dispatch index includes abandoned processing claims'
);

select * from finish();
rollback;
