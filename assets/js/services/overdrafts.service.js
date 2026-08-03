import { supabase } from '../config/supabase.js';

import {
  formatCurrencyMinor,
  nairaToMinor,
} from './transactions.service.js';

function normalizeError(error, fallback = 'Overdraft request failed.') {
  if (!error) return new Error(fallback);

  const message = error.message || fallback;

  if (error.code === '42501') {
    return new Error(
      message ||
      'You do not have permission to perform this action.',
    );
  }

  if (error.code === 'P0002') {
    return new Error(
      message ||
      'The requested overdraft record was not found.',
    );
  }

  if (error.code === '23505') {
    return new Error(
      message ||
      'This account already has a pending overdraft request.',
    );
  }

  return new Error(message);
}

function safeSearch(value = '') {
  return String(value)
    .trim()
    .replace(/[,%()]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

export async function listOverdrafts({
  page = 1,
  pageSize = 25,
  search = '',
  status = 'all',
} = {}) {
  const safePage =
    Math.max(Number(page) || 1, 1);

  const safePageSize =
    Math.min(
      Math.max(Number(pageSize) || 25, 5),
      100,
    );

  const from =
    (safePage - 1) *
    safePageSize;

  const to =
    from +
    safePageSize -
    1;

  let query = supabase
    .from('overdraft_directory')
    .select('*', {
      count: 'exact',
    })
    .order('requested_at', {
      ascending: false,
    })
    .range(from, to);

  if (
    status &&
    status !== 'all'
  ) {
    query =
      query.eq('status', status);
  }

  const term =
    safeSearch(search);

  if (term) {
    query = query.or(
      [
        `overdraft_number.ilike.%${term}%`,
        `customer_number.ilike.%${term}%`,
        `customer_name.ilike.%${term}%`,
        `customer_phone.ilike.%${term}%`,
        `account_number.ilike.%${term}%`,
      ].join(','),
    );
  }

  const {
    data,
    error,
    count,
  } = await query;

  if (error) {
    throw normalizeError(
      error,
      'Unable to load overdrafts.',
    );
  }

  return {
    overdrafts: data ?? [],
    count: count ?? 0,
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function getOverdraftSummary() {
  const {
    data,
    error,
  } = await supabase.rpc(
    'get_overdraft_summary',
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to load overdraft summary.',
    );
  }

  return data ?? {
    pending_count: 0,
    active_count: 0,
    approved_payouts_minor: 0,
    outstanding_exposure_minor: 0,
    approved_charges_minor: 0,
  };
}

export async function getCustomerOverdraftContext(
  customerNumber,
) {
  const raw =
    String(customerNumber ?? '')
      .trim();

  const normalized =
    /^\d{1,3}$/.test(raw)
      ? raw.padStart(3, '0')
      : raw;

  if (!normalized) {
    throw new Error(
      'Enter a customer number.',
    );
  }

  const {
    data,
    error,
  } = await supabase.rpc(
    'get_customer_transaction_context',
    {
      p_customer_number:
        normalized,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to find customer.',
    );
  }

  return data;
}

export async function requestOverdraft({
  accountId,
  requestedAmount,
  charge = '0',
  purpose = '',
}) {
  const requestedAmountMinor =
    nairaToMinor(
      requestedAmount,
    );

  const chargeMinor =
    nairaToMinor(
      charge,
      {
        allowZero: true,
      },
    );

  const {
    data,
    error,
  } = await supabase.rpc(
    'request_overdraft',
    {
      p_account_id:
        accountId,

      p_requested_amount_minor:
        requestedAmountMinor,

      p_charge_minor:
        chargeMinor,

      p_purpose:
        purpose || null,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to create overdraft request.',
    );
  }

  return data;
}

export async function approveOverdraft(
  overdraftId,
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'approve_overdraft',
    {
      p_overdraft_id:
        overdraftId,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to approve overdraft.',
    );
  }

  return data;
}

export async function rejectOverdraft(
  overdraftId,
  reason,
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'reject_overdraft',
    {
      p_overdraft_id:
        overdraftId,

      p_reason:
        reason,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to reject overdraft.',
    );
  }

  return data;
}

export async function closeOverdraft(
  overdraftId,
  reason = '',
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'close_overdraft',
    {
      p_overdraft_id:
        overdraftId,

      p_reason:
        reason || null,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to close overdraft.',
    );
  }

  return data;
}

export {
  formatCurrencyMinor,
  nairaToMinor,
};
