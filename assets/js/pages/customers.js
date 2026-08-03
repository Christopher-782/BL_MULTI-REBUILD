import { bindLogoutButtons, bindSessionUI, requireActiveProfile } from '../auth/access.js';
import { createCustomer, getCustomerPortfolioSummary, listCustomers } from '../services/customers.service.js';

const session = await requireActiveProfile();

if (session) {
  bindSessionUI(session.profile, session.user);
  bindLogoutButtons();

  const CAN_MANAGE = ['super_admin', 'admin', 'manager', 'staff'].includes(session.profile.role);
  const state = {
    page: 1,
    pageSize: 20,
    count: 0,
    search: '',
    status: 'all',
    customers: [],
    portfolio: null,
  };

  const tableBody = document.querySelector('#customersTableBody');
  const loading = document.querySelector('#customersLoading');
  const empty = document.querySelector('#customersEmpty');
  const message = document.querySelector('#pageMessage');
  const paginationText = document.querySelector('#paginationText');
  const prevButton = document.querySelector('#prevPage');
  const nextButton = document.querySelector('#nextPage');
  const createDialog = document.querySelector('#createCustomerDialog');
  const createForm = document.querySelector('#createCustomerForm');

  if (!CAN_MANAGE) {
    document.querySelectorAll('[data-customer-manage]').forEach((element) => {
      element.hidden = true;
    });
  }

  function showMessage(text, type = 'success') {
    message.textContent = text;
    message.dataset.type = type;
    message.hidden = false;
    window.clearTimeout(showMessage.timer);
    showMessage.timer = window.setTimeout(() => {
      message.hidden = true;
    }, 6000);
  }

  function fullName(customer) {
    return [customer.first_name, customer.middle_name, customer.last_name]
      .filter(Boolean)
      .join(' ');
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium' }).format(date);
  }

  function formatCurrencyMinor(value = 0, currency = 'NGN') {
    const major = Number(value || 0) / 100;
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(major);
  }

  function makeTextCell(primary, secondary = '') {
    const cell = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = primary || '—';
    cell.append(strong);
    if (secondary) {
      const small = document.createElement('small');
      small.textContent = secondary;
      cell.append(small);
    }
    return cell;
  }

  function makeStatusBadge(status) {
    const badge = document.createElement('span');
    badge.className = 'state-badge';
    badge.dataset.status = status;
    badge.textContent = status;
    return badge;
  }

  function renderSummary() {
    document.querySelector('#customerCount').textContent = state.count;
    document.querySelector('#visibleActive').textContent = state.customers.filter((item) => item.status === 'active').length;
    document.querySelector('#visibleAccounts').textContent = state.customers.reduce((sum, item) => sum + (item.accounts?.length || 0), 0);

    const pageBalanceMinor = state.customers.reduce(
      (sum, item) => sum + (item.accounts || []).reduce(
        (accountSum, account) => accountSum + Number(account.cached_balance_minor || 0),
        0,
      ),
      0,
    );

    document.querySelector('#visibleBalance').textContent = formatCurrencyMinor(pageBalanceMinor);

    const portfolioBalance = state.portfolio?.positive_customer_balances_minor;
    const portfolioElement = document.querySelector('#totalCustomerBalance');
    const portfolioNote = document.querySelector('#portfolioBalanceNote');

    if (portfolioElement) {
      portfolioElement.textContent = portfolioBalance == null
        ? '—'
        : formatCurrencyMinor(portfolioBalance);
    }

    if (portfolioNote) {
      const accountCount = state.portfolio?.account_count;
      portfolioNote.textContent = accountCount == null
        ? 'Across all open accounts'
        : `${Number(accountCount).toLocaleString('en-NG')} open account${Number(accountCount) === 1 ? '' : 's'}`;
    }
  }

  function renderCustomers() {
    tableBody.replaceChildren();
    empty.hidden = state.customers.length > 0;

    state.customers.forEach((customer) => {
      const row = document.createElement('tr');
      const accounts = [...(customer.accounts || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const primaryAccount = accounts[0];

      row.append(
        makeTextCell(customer.customer_number, formatDate(customer.created_at)),
        makeTextCell(fullName(customer), customer.phone),
        makeTextCell(primaryAccount?.account_number || 'No account', primaryAccount ? `${primaryAccount.account_type} · ${primaryAccount.status}` : ''),
        makeTextCell(primaryAccount ? formatCurrencyMinor(primaryAccount.cached_balance_minor, primaryAccount.currency) : '—', accounts.length > 1 ? `${accounts.length} accounts` : ''),
      );

      const statusCell = document.createElement('td');
      statusCell.append(makeStatusBadge(customer.status));
      row.append(statusCell);

      const actionCell = document.createElement('td');
      const link = document.createElement('a');
      link.className = 'secondary-button compact';
      link.href = `./customer.html?id=${encodeURIComponent(customer.id)}`;
      link.textContent = CAN_MANAGE ? 'View / Edit' : 'View';
      actionCell.append(link);
      row.append(actionCell);

      tableBody.append(row);
    });

    renderSummary();
    renderPagination();
  }

  function renderPagination() {
    const start = state.count === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
    const end = Math.min(state.page * state.pageSize, state.count);
    paginationText.textContent = `${start}–${end} of ${state.count}`;
    prevButton.disabled = state.page <= 1;
    nextButton.disabled = state.page * state.pageSize >= state.count;
  }

  async function loadPortfolioSummary() {
    try {
      state.portfolio = await getCustomerPortfolioSummary();
      renderSummary();
    } catch (error) {
      state.portfolio = null;
      renderSummary();
      showMessage(error.message, 'error');
    }
  }

  async function refreshAll() {
    await Promise.all([
      loadCustomers(),
      loadPortfolioSummary(),
    ]);
  }

  async function loadCustomers() {
    loading.hidden = false;
    empty.hidden = true;
    tableBody.replaceChildren();

    try {
      const result = await listCustomers(state);
      state.customers = result.customers;
      state.count = result.count;
      state.page = result.page;
      state.pageSize = result.pageSize;
      renderCustomers();
    } catch (error) {
      showMessage(error.message, 'error');
      state.customers = [];
      state.count = 0;
      renderCustomers();
    } finally {
      loading.hidden = true;
    }
  }

  document.querySelector('#customerSearchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    state.search = event.currentTarget.elements.search.value.trim();
    state.status = event.currentTarget.elements.status.value;
    state.page = 1;
    await loadCustomers();
  });

  document.querySelector('#clearCustomerFilters').addEventListener('click', async () => {
    const form = document.querySelector('#customerSearchForm');
    form.reset();
    state.search = '';
    state.status = 'all';
    state.page = 1;
    await loadCustomers();
  });

  prevButton.addEventListener('click', async () => {
    if (state.page <= 1) return;
    state.page -= 1;
    await loadCustomers();
  });

  nextButton.addEventListener('click', async () => {
    if (state.page * state.pageSize >= state.count) return;
    state.page += 1;
    await loadCustomers();
  });

  document.querySelector('#refreshCustomers').addEventListener('click', refreshAll);

  if (CAN_MANAGE) {
    document.querySelector('#openCreateCustomer').addEventListener('click', () => createDialog.showModal());
    document.querySelector('#closeCreateCustomer').addEventListener('click', () => createDialog.close());
    document.querySelector('#cancelCreateCustomer').addEventListener('click', () => createDialog.close());

    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = createForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = 'Creating customer...';

      try {
        const result = await createCustomer({
          firstName: createForm.elements.firstName.value,
          middleName: createForm.elements.middleName.value,
          lastName: createForm.elements.lastName.value,
          phone: createForm.elements.phone.value,
          email: createForm.elements.email.value,
          gender: createForm.elements.gender.value,
          dateOfBirth: createForm.elements.dateOfBirth.value,
          occupation: createForm.elements.occupation.value,
          address: createForm.elements.address.value,
          city: createForm.elements.city.value,
          state: createForm.elements.state.value,
          nextOfKinName: createForm.elements.nextOfKinName.value,
          nextOfKinPhone: createForm.elements.nextOfKinPhone.value,
          accountType: createForm.elements.accountType.value,
        });

        createForm.reset();
        createDialog.close();
        showMessage(`Customer ${result.customer.customer_number} created with account ${result.account.account_number}.`);
        state.page = 1;
        await refreshAll();
      } catch (error) {
        showMessage(error.message, 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Create customer';
      }
    });
  }

  await refreshAll();
}
