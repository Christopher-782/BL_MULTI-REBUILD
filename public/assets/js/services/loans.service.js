import { supabase } from '../config/supabase.js';

import { kickSmsDispatcher } from './sms.service.js';

import {
  formatCurrencyMinor,
  nairaToMinor,
} from './transactions.service.js';

function normalizeError(error, fallback = 'Loan request failed.') {
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
      'The requested loan record was not found.',
    );
  }

  if (
    error.code === '22003' ||
    /exceeds|outstanding|remaining/i.test(message)
  ) {
    return new Error(message);
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

export function percentToBasisPoints(value) {
  const normalized = String(value ?? '').trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(
      'Enter a valid interest rate with no more than 2 decimal places.',
    );
  }

  const [whole, fraction = ''] = normalized.split('.');
  const bps =
    (BigInt(whole) * 100n) +
    BigInt(fraction.padEnd(2, '0'));

  if (bps > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Interest rate is too large.');
  }

  return Number(bps);
}

export function basisPointsToPercent(value = 0) {
  return (Number(value || 0) / 100).toFixed(2);
}

export function calculateFlatLoanPreview(
  principalMinor,
  interestRateBps,
) {
  const principal = BigInt(
    String(principalMinor ?? 0),
  );

  const bps = BigInt(
    String(interestRateBps ?? 0),
  );

  const interest =
    ((principal * bps) + 5000n) / 10000n;

  return {
    interestMinor: interest.toString(),
    totalMinor: (principal + interest).toString(),
  };
}

export async function listLoans({
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
    (safePage - 1) * safePageSize;

  const to =
    from + safePageSize - 1;

  let query = supabase
    .from('loan_directory')
    .select('*', { count: 'exact' })
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

  const term = safeSearch(search);

  if (term) {
    query = query.or(
      [
        `loan_number.ilike.%${term}%`,
        `customer_number.ilike.%${term}%`,
        `customer_name.ilike.%${term}%`,
        `account_number.ilike.%${term}%`,
        `customer_phone.ilike.%${term}%`,
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
      'Unable to load loans.',
    );
  }

  return {
    loans: data ?? [],
    count: count ?? 0,
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function getLoanSummary() {
  const {
    data,
    error,
  } = await supabase.rpc(
    'get_loan_summary',
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to load loan summary.',
    );
  }

  return data ?? {
    pending_loans: 0,
    active_loans: 0,
    outstanding_minor: 0,
    repayments_today_minor: 0,
    overdue_loans: 0,
  };
}

export async function getCustomerLoanContext(
  customerNumber,
) {
  const raw =
    String(customerNumber ?? '').trim();

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

export async function requestLoan({
  accountId,
  principal,
  interestRate,
  termMonths,
  purpose = '',
}) {
  const principalMinor =
    nairaToMinor(principal);

  const interestRateBps =
    percentToBasisPoints(
      interestRate,
    );

  const term =
    Number.parseInt(
      String(termMonths),
      10,
    );

  if (
    !Number.isInteger(term) ||
    term < 1 ||
    term > 120
  ) {
    throw new Error(
      'Loan term must be between 1 and 120 months.',
    );
  }

  const {
    data,
    error,
  } = await supabase.rpc(
    'request_loan',
    {
      p_account_id:
        accountId,
      p_principal_minor:
        principalMinor,
      p_interest_rate_bps:
        interestRateBps,
      p_term_months:
        term,
      p_purpose:
        purpose || null,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to create loan application.',
    );
  }

  return data;
}

export async function approveLoan(
  loanId,
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'approve_loan',
    {
      p_loan_id: loanId,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to approve loan.',
    );
  }

  kickSmsDispatcher(25);
  return data;
}

export async function rejectLoan(
  loanId,
  reason,
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'reject_loan',
    {
      p_loan_id:
        loanId,
      p_reason:
        reason,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to reject loan.',
    );
  }

  kickSmsDispatcher(25);
  return data;
}

export async function requestLoanRepayment({
  loanId,
  amount,
  paymentMethod,
  externalReference = '',
  notes = '',
}) {
  const amountMinor =
    nairaToMinor(amount);

  const {
    data,
    error,
  } = await supabase.rpc(
    'request_loan_repayment',
    {
      p_loan_id:
        loanId,
      p_amount_minor:
        amountMinor,
      p_payment_method:
        paymentMethod,
      p_external_reference:
        externalReference || null,
      p_notes:
        notes || null,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to record loan repayment.',
    );
  }

  return data;
}

export async function approveLoanRepayment(
  repaymentId,
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'approve_loan_repayment',
    {
      p_repayment_id:
        repaymentId,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to approve repayment.',
    );
  }

  kickSmsDispatcher(25);
  return data;
}

export async function rejectLoanRepayment(
  repaymentId,
  reason,
) {
  const {
    data,
    error,
  } = await supabase.rpc(
    'reject_loan_repayment',
    {
      p_repayment_id:
        repaymentId,
      p_reason:
        reason,
    },
  );

  if (error) {
    throw normalizeError(
      error,
      'Unable to reject repayment.',
    );
  }

  kickSmsDispatcher(25);
  return data;
}

export async function listPendingLoanRepayments() {
  const {
    data,
    error,
  } = await supabase
    .from('loan_repayment_directory')
    .select('*')
    .eq('status', 'pending')
    .order('requested_at', {
      ascending: true,
    })
    .limit(100);

  if (error) {
    throw normalizeError(
      error,
      'Unable to load pending repayments.',
    );
  }

  return data ?? [];
}

export async function getLoan(
  loanId,
) {
  const {
    data,
    error,
  } = await supabase
    .from('loan_directory')
    .select('*')
    .eq('id', loanId)
    .single();

  if (error || !data) {
    throw normalizeError(
      error,
      'Loan was not found.',
    );
  }

  return data;
}

export async function listLoanRepayments(
  loanId,
) {
  const {
    data,
    error,
  } = await supabase
    .from('loan_repayment_directory')
    .select('*')
    .eq('loan_id', loanId)
    .order('requested_at', {
      ascending: false,
    });

  if (error) {
    throw normalizeError(
      error,
      'Unable to load loan repayments.',
    );
  }

  return data ?? [];
}

export {
  formatCurrencyMinor,
  nairaToMinor,
};
