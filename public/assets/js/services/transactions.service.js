import { supabase } from '../config/supabase.js';

import { kickSmsDispatcher } from './sms.service.js';

function signalApprovalQueueChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('bl:approvals-changed'));
  }
}

function isMissingRpcError(error, functionName) {
  if (!error) return false;

  const code = String(error.code || '');
  const message = String(error.message || '');

  return (
    code === 'PGRST202' ||
    (message.includes('schema cache') && message.includes(functionName))
  );
}

async function fallbackPendingTransactionMakers() {
  const { data: authData } = await supabase.auth.getUser();
  const currentUserId = authData?.user?.id || '';

  let query = supabase
    .from('transaction_directory')
    .select('initiated_by, initiated_by_name, amount_minor, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(5000);

  if (currentUserId) {
    query = query.neq('initiated_by', currentUserId);
  }

  const { data, error } = await query;
  if (error) throw normalizeError(error, 'Unable to load staff pending queues.');

  const grouped = new Map();

  for (const row of data || []) {
    if (!row.initiated_by) continue;

    const existing = grouped.get(row.initiated_by) || {
      staff_id: row.initiated_by,
      staff_name: row.initiated_by_name || 'Staff member',
      pending_count: 0,
      pending_amount_minor: 0,
    };

    existing.pending_count += 1;
    existing.pending_amount_minor += Number(row.amount_minor || 0);
    grouped.set(row.initiated_by, existing);
  }

  return [...grouped.values()].sort((a, b) =>
    String(a.staff_name).localeCompare(String(b.staff_name)),
  );
}

function normalizeError(error, fallback = 'Transaction request failed.') {
  if (!error) return new Error(fallback);

  const message = error.message || fallback;

  if (error.code === '42501') {
    return new Error(message || 'You do not have permission to perform this action.');
  }

  if (error.code === 'P0002') {
    return new Error(message || 'The requested record was not found.');
  }

  if (error.code === '22003' || /insufficient|sufficient funds/i.test(message)) {
    return new Error(message || 'Insufficient account balance.');
  }

  if (error.code === '23505') {
    return new Error(message || 'This transaction conflicts with an existing request.');
  }

  return new Error(message);
}

export function nairaToMinor(value, { allowZero = false } = {}) {
  const normalized = String(value ?? '')
    .trim()
    .replaceAll(',', '');

  if (allowZero && (normalized === '' || normalized === '0' || normalized === '0.00')) {
    return '0';
  }

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('Enter a valid amount with no more than 2 decimal places.');
  }

  const [whole, decimal = ''] = normalized.split('.');
  const cents = decimal.padEnd(2, '0');
  const minor = `${whole}${cents}`.replace(/^0+(?=\d)/, '') || '0';

  if (!allowZero && BigInt(minor) <= 0n) {
    throw new Error('Amount must be greater than zero.');
  }

  if (allowZero && BigInt(minor) < 0n) {
    throw new Error('Amount cannot be negative.');
  }

  return minor;
}

export function minorToInput(value = 0) {
  const minor = BigInt(String(value ?? 0));
  const whole = minor / 100n;
  const fraction = (minor % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

export function formatCurrencyMinor(value = 0, currency = 'NGN') {
  const amount = Number(value || 0) / 100;

  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function safeSearch(value = '') {
  return String(value)
    .trim()
    .replace(/[,%()]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function normalizeCustomerNumber(value) {
  const raw = String(value ?? '').trim();

  if (/^\d{1,3}$/.test(raw)) {
    return raw.padStart(3, '0');
  }

  return raw;
}

export async function listTransactions({
  page = 1,
  pageSize = 25,
  search = '',
  status = 'all',
  type = 'all',
  makerId = '',
} = {}) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 25, 5), 100);
  const from = (safePage - 1) * safePageSize;
  const to = from + safePageSize - 1;

  let query = supabase
    .from('transaction_directory')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status && status !== 'all') {
    query = query.eq('status', status);
  }

  if (type && type !== 'all') {
    query = query.eq('type', type);
  }

  if (makerId) {
    query = query.eq('initiated_by', makerId);
  }

  const term = safeSearch(search);
  if (term) {
    query = query.or(
      [
        `reference.ilike.%${term}%`,
        `customer_number.ilike.%${term}%`,
        `customer_name.ilike.%${term}%`,
        `account_number.ilike.%${term}%`,
        `description.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error, count } = await query;

  if (error) throw normalizeError(error, 'Unable to load transactions.');

  return {
    transactions: data ?? [],
    count: count ?? 0,
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function getTransactionSummary() {
  const { data, error } = await supabase.rpc('get_transaction_summary');

  if (error) throw normalizeError(error, 'Unable to load transaction summary.');

  return data ?? {
    pending_count: 0,
    approved_today_count: 0,
    deposits_today_minor: 0,
    charges_today_minor: 0,
    withdrawals_today_minor: 0,
  };
}

export async function getCustomerTransactionContext(customerNumber) {
  const normalized = normalizeCustomerNumber(customerNumber);

  if (!normalized) {
    throw new Error('Enter a customer number.');
  }

  const { data, error } = await supabase.rpc('get_customer_transaction_context', {
    p_customer_number: normalized,
  });

  if (error) throw normalizeError(error, 'Unable to find customer.');

  return data;
}

export async function getAccountById(accountId) {
  const { data, error } = await supabase
    .from('accounts')
    .select(`
      id,
      account_number,
      account_type,
      currency,
      status,
      cached_balance_minor,
      customer_id,
      customers (
        id,
        customer_number,
        first_name,
        middle_name,
        last_name,
        status
      )
    `)
    .eq('id', accountId)
    .single();

  if (error || !data) {
    throw new Error('Account was not found.');
  }

  return data;
}

export async function initiateTransaction({
  accountId,
  type,
  amount,
  charge = '0',
  description = '',
}) {
  const amountMinor = nairaToMinor(amount);
  const chargeMinor = type === 'deposit'
    ? nairaToMinor(charge, { allowZero: true })
    : '0';

  const { data, error } = await supabase.rpc('initiate_transaction', {
    p_account_id: accountId,
    p_type: type,
    p_amount_minor: amountMinor,
    p_charge_minor: chargeMinor,
    p_description: description || null,
  });

  if (error) throw normalizeError(error, 'Unable to initiate transaction.');
  signalApprovalQueueChanged();
  return data;
}

export async function approveTransaction(transactionId) {
  const { data, error } = await supabase.rpc('approve_transaction', {
    p_transaction_id: transactionId,
  });

  if (error) throw normalizeError(error, 'Unable to approve transaction.');
  signalApprovalQueueChanged();
  kickSmsDispatcher(25);
  return data;
}

export async function rejectTransaction(transactionId, reason) {
  const { data, error } = await supabase.rpc('reject_transaction', {
    p_transaction_id: transactionId,
    p_reason: reason,
  });

  if (error) throw normalizeError(error, 'Unable to reject transaction.');
  signalApprovalQueueChanged();
  kickSmsDispatcher(25);
  return data;
}

export async function requestReversal(transactionId, reason) {
  const { data, error } = await supabase.rpc('request_transaction_reversal', {
    p_transaction_id: transactionId,
    p_reason: reason,
  });

  if (error) throw normalizeError(error, 'Unable to request reversal.');
  signalApprovalQueueChanged();
  return data;
}

export async function getPendingTransactionMakers() {
  const { data, error } = await supabase.rpc('get_pending_transaction_makers');

  if (!error) return Array.isArray(data) ? data : [];

  if (isMissingRpcError(error, 'get_pending_transaction_makers')) {
    console.warn(
      'get_pending_transaction_makers() is not available in the Supabase schema cache; using the transaction directory fallback.',
    );
    return fallbackPendingTransactionMakers();
  }

  throw normalizeError(error, 'Unable to load staff pending queues.');
}

async function fallbackBulkApproveStaffTransactions(staffId, ids) {
  const { data: eligibleRows, error: eligibilityError } = await supabase
    .from('transaction_directory')
    .select('id, reference, initiated_by, status')
    .in('id', ids);

  if (eligibilityError) {
    throw normalizeError(eligibilityError, 'Unable to validate selected transactions.');
  }

  const eligibleById = new Map((eligibleRows || []).map((row) => [row.id, row]));
  const results = [];
  let approvedCount = 0;
  let failedCount = 0;

  for (const id of ids) {
    const row = eligibleById.get(id);

    if (!row || row.status !== 'pending' || row.initiated_by !== staffId) {
      failedCount += 1;
      results.push({
        transaction_id: id,
        reference: row?.reference || null,
        status: 'failed',
        error: 'Transaction is not pending or was not created by the selected staff member.',
      });
      continue;
    }

    const { data, error } = await supabase.rpc('approve_transaction', {
      p_transaction_id: id,
    });

    if (error) {
      failedCount += 1;
      results.push({
        transaction_id: id,
        reference: row.reference || null,
        status: 'failed',
        error: error.message || 'Approval failed.',
        sqlstate: error.code || null,
      });
      continue;
    }

    approvedCount += 1;
    results.push({
      transaction_id: id,
      reference: row.reference || null,
      status: 'approved',
      result: data,
    });
  }

  return {
    maker_id: staffId,
    requested_count: ids.length,
    approved_count: approvedCount,
    failed_count: failedCount,
    results,
    fallback_mode: true,
  };
}

export async function bulkApproveStaffTransactions(staffId, transactionIds) {
  const ids = [...new Set((transactionIds || []).filter(Boolean))];

  if (!staffId) throw new Error('Choose a staff member first.');
  if (!ids.length) throw new Error('Select at least one pending transaction.');
  if (ids.length > 100) throw new Error('Approve no more than 100 transactions in one batch.');

  const { data, error } = await supabase.rpc('bulk_approve_staff_transactions', {
    p_staff_id: staffId,
    p_transaction_ids: ids,
  });

  if (error && !isMissingRpcError(error, 'bulk_approve_staff_transactions')) {
    throw normalizeError(error, 'Bulk approval failed.');
  }

  const result = error
    ? await fallbackBulkApproveStaffTransactions(staffId, ids)
    : data;

  if (error) {
    console.warn(
      'bulk_approve_staff_transactions(uuid, uuid[]) is not available in the Supabase schema cache; using per-transaction approval fallback.',
    );
  }

  kickSmsDispatcher(100);
  signalApprovalQueueChanged();
  return result;
}
