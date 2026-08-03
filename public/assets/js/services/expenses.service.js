import { supabase } from '../config/supabase.js';

import {
  formatCurrencyMinor,
  nairaToMinor,
} from './transactions.service.js';

function normalizeError(error, fallback = 'Expense request failed.') {
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
      'The expense record was not found.',
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

export async function listExpenses({
  page = 1,
  pageSize = 25,
  search = '',
  status = 'all',
  category = 'all',
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
    .from('expense_directory')
    .select('*', {
      count: 'exact',
    })
    .order('expense_date', {
      ascending: false,
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
      query.eq(
        'status',
        status,
      );
  }

  if (
    category &&
    category !== 'all'
  ) {
    query =
      query.eq(
        'category',
        category,
      );
  }

  const term =
    safeSearch(search);

  if (term) {
    query = query.or(
      [
        `expense_number.ilike.%${term}%`,
        `category.ilike.%${term}%`,
        `description.ilike.%${term}%`,
        `external_reference.ilike.%${term}%`,
        `requested_by_name.ilike.%${term}%`,
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
      'Unable to load expenses.',
    );
  }

  return {
    expenses: data ?? [],
    count: count ?? 0,
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function getExpenseSummary() {
  const {
    data,
    error,
  } = await supabase.rpc(
    'get_expense_summary',
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to load expense summary.',
    );
  }

  return data ?? {
    pending_count: 0,
    today_minor: 0,
    month_minor: 0,
    approved_count: 0,
  };
}

export async function requestExpense({
  expenseDate,
  category,
  description,
  amount,
  paymentMethod,
  externalReference = '',
}) {
  const amountMinor =
    nairaToMinor(amount);

  const {
    data,
    error,
  } = await supabase.rpc(
    'request_expense',
    {
      p_expense_date:
        expenseDate,

      p_category:
        category,

      p_description:
        description,

      p_amount_minor:
        amountMinor,

      p_payment_method:
        paymentMethod,

      p_external_reference:
        externalReference || null,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to create expense request.',
    );
  }

  return data;
}

export async function approveExpense(
  expenseId,
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'approve_expense',
    {
      p_expense_id:
        expenseId,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to approve expense.',
    );
  }

  return data;
}

export async function rejectExpense(
  expenseId,
  reason,
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'reject_expense',
    {
      p_expense_id:
        expenseId,

      p_reason:
        reason,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to reject expense.',
    );
  }

  return data;
}

export {
  formatCurrencyMinor,
};
