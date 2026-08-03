import { supabase } from '../config/supabase.js';

function normalizeRpcError(error, fallback = 'Customer request failed.') {
  if (!error) return new Error(fallback);

  const message = error.message || fallback;

  if (error.code === '23505' || /duplicate key|already exists|phone number/i.test(message)) {
    return new Error('A customer already exists with this phone number.');
  }

  if (error.code === '42501') {
    return new Error('You do not have permission to perform this customer action.');
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

export async function getCustomerPortfolioSummary() {
  const { data, error } = await supabase.rpc('get_customer_portfolio_summary');

  if (!error && data) {
    return data;
  }

  // Compatibility fallback for a frontend deployed just before migration 014.
  // This is read-only and paginates so it is not limited by Supabase's default
  // row cap as the customer base grows.
  let from = 0;
  const pageSize = 1000;
  let accountCount = 0;
  let positiveBalanceMinor = 0;
  let netBalanceMinor = 0;
  let overdraftExposureMinor = 0;

  while (true) {
    const { data: accounts, error: accountError } = await supabase
      .from('accounts')
      .select('cached_balance_minor,status')
      .neq('status', 'closed')
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);

    if (accountError) {
      throw normalizeRpcError(
        error || accountError,
        'Unable to load total customer balances.',
      );
    }

    const rows = accounts ?? [];

    for (const account of rows) {
      const balance = Number(account.cached_balance_minor || 0);
      accountCount += 1;
      netBalanceMinor += balance;
      positiveBalanceMinor += Math.max(balance, 0);
      overdraftExposureMinor += Math.max(-balance, 0);
    }

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return {
    account_count: accountCount,
    positive_customer_balances_minor: positiveBalanceMinor,
    net_customer_balances_minor: netBalanceMinor,
    overdraft_exposure_minor: overdraftExposureMinor,
    source: 'frontend_fallback',
  };
}

export async function listCustomers({
  page = 1,
  pageSize = 20,
  search = '',
  status = 'all',
} = {}) {
  const safePage = Math.max(Number(page) || 1, 1);
  const safePageSize = Math.min(Math.max(Number(pageSize) || 20, 5), 100);
  const from = (safePage - 1) * safePageSize;
  const to = from + safePageSize - 1;

  let query = supabase
    .from('customers')
    .select(
      `
        id,
        customer_number,
        first_name,
        middle_name,
        last_name,
        phone,
        email,
        city,
        state,
        occupation,
        status,
        created_at,
        accounts (
          id,
          account_number,
          account_type,
          currency,
          status,
          cached_balance_minor,
          created_at
        )
      `,
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status && status !== 'all') {
    query = query.eq('status', status);
  }

  const term = safeSearch(search);
  if (term) {
    query = query.or(
      [
        `customer_number.ilike.%${term}%`,
        `first_name.ilike.%${term}%`,
        `middle_name.ilike.%${term}%`,
        `last_name.ilike.%${term}%`,
        `phone.ilike.%${term}%`,
        `email.ilike.%${term}%`,
      ].join(','),
    );
  }

  const { data, error, count } = await query;

  if (error) throw normalizeRpcError(error, 'Unable to load customers.');

  return {
    customers: data ?? [],
    count: count ?? 0,
    page: safePage,
    pageSize: safePageSize,
  };
}

export async function getCustomer(customerId) {
  const { data, error } = await supabase
    .from('customers')
    .select(
      `
        id,
        customer_number,
        first_name,
        middle_name,
        last_name,
        phone,
        email,
        gender,
        date_of_birth,
        address,
        city,
        state,
        occupation,
        next_of_kin_name,
        next_of_kin_phone,
        status,
        created_by,
        updated_by,
        created_at,
        updated_at,
        accounts (
          id,
          account_number,
          account_type,
          currency,
          status,
          cached_balance_minor,
          created_at,
          updated_at
        )
      `,
    )
    .eq('id', customerId)
    .single();

  if (error) throw normalizeRpcError(error, 'Unable to load customer.');
  return data;
}

export async function createCustomer(payload) {
  const { data, error } = await supabase.rpc('create_customer_with_account', {
    p_first_name: payload.firstName,
    p_last_name: payload.lastName,
    p_phone: payload.phone,
    p_middle_name: payload.middleName || null,
    p_email: payload.email || null,
    p_gender: payload.gender || null,
    p_date_of_birth: payload.dateOfBirth || null,
    p_address: payload.address || null,
    p_city: payload.city || null,
    p_state: payload.state || null,
    p_occupation: payload.occupation || null,
    p_next_of_kin_name: payload.nextOfKinName || null,
    p_next_of_kin_phone: payload.nextOfKinPhone || null,
    p_account_type: payload.accountType || 'savings',
  });

  if (error) throw normalizeRpcError(error, 'Unable to create customer.');
  return data;
}

export async function updateCustomer(payload) {
  const { data, error } = await supabase.rpc('update_customer', {
    p_customer_id: payload.customerId,
    p_first_name: payload.firstName,
    p_last_name: payload.lastName,
    p_phone: payload.phone,
    p_middle_name: payload.middleName || null,
    p_email: payload.email || null,
    p_gender: payload.gender || null,
    p_date_of_birth: payload.dateOfBirth || null,
    p_address: payload.address || null,
    p_city: payload.city || null,
    p_state: payload.state || null,
    p_occupation: payload.occupation || null,
    p_next_of_kin_name: payload.nextOfKinName || null,
    p_next_of_kin_phone: payload.nextOfKinPhone || null,
    p_status: payload.status || 'active',
  });

  if (error) throw normalizeRpcError(error, 'Unable to update customer.');
  return data;
}

export async function createCustomerAccount(customerId, accountType = 'savings') {
  const { data, error } = await supabase.rpc('create_customer_account', {
    p_customer_id: customerId,
    p_account_type: accountType,
  });

  if (error) throw normalizeRpcError(error, 'Unable to create account.');
  return data;
}

export async function updateAccountStatus(accountId, status) {
  const { data, error } = await supabase.rpc('update_account_status', {
    p_account_id: accountId,
    p_status: status,
  });

  if (error) throw normalizeRpcError(error, 'Unable to update account status.');
  return data;
}
