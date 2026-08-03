import { supabase } from '../config/supabase.js';

export async function getDashboardSummary() {
  const {
    data,
    error,
  } = await supabase.rpc(
    'get_dashboard_summary',
  );

  if (error) {
    throw new Error(
      error.message ||
      'Unable to load dashboard summary.',
    );
  }

  return data;
}

export async function getRecentTransactions(
  limit = 6,
) {
  const {
    data,
    error,
  } = await supabase
    .from('transaction_directory')
    .select(`
      id,
      reference,
      type,
      amount_minor,
      charge_minor,
      net_amount_minor,
      status,
      created_at,
      reviewed_at,
      customer_number,
      customer_name,
      account_number,
      currency
    `)
    .neq('type', 'opening_balance')
    .order('created_at', {
      ascending: false,
    })
    .limit(limit);

  if (error) {
    throw new Error(
      error.message ||
      'Unable to load recent transactions.',
    );
  }

  return data ?? [];
}

export async function getRecentExpenses(
  limit = 5,
) {
  const {
    data,
    error,
  } = await supabase
    .from('expense_directory')
    .select(`
      id,
      expense_number,
      expense_date,
      category,
      description,
      amount_minor,
      status,
      requested_by_name
    `)
    .order('requested_at', {
      ascending: false,
    })
    .limit(limit);

  if (error) {
    throw new Error(
      error.message ||
      'Unable to load recent expenses.',
    );
  }

  return data ?? [];
}
