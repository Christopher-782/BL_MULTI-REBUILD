import {
  bindLogoutButtons,
  bindSessionUI,
  requireActiveProfile,
} from '../auth/access.js';

import {
  getDashboardSummary,
  getRecentExpenses,
  getRecentTransactions,
} from '../services/dashboard.service.js';

import { formatCurrencyMinor } from '../services/transactions.service.js';


function showDashboardBootFailure(error) {
  console.error('Dashboard startup error:', error);

  const message = document.querySelector('#pageMessage');
  if (message) {
    const detail = error?.message || String(error || 'Unknown dashboard error');
    message.textContent = `Dashboard could not load: ${detail}`;
    message.dataset.type = 'error';
    message.hidden = false;
  }
}

window.addEventListener('unhandledrejection', (event) => {
  showDashboardBootFailure(event.reason);
});

window.addEventListener('error', (event) => {
  if (event.error) showDashboardBootFailure(event.error);
});

const session = await requireActiveProfile();

if (session) {
  bindSessionUI(session.profile, session.user);
  bindLogoutButtons();

  const message = document.querySelector('#pageMessage');
  const refreshButton = document.querySelector('#refreshDashboard');

  function showMessage(text, type = 'error', duration = 6500) {
    if (!message) return;
    message.textContent = text;
    message.dataset.type = type;
    message.hidden = false;
    window.clearTimeout(showMessage.timer);
    if (duration > 0) {
      showMessage.timer = window.setTimeout(() => {
        message.hidden = true;
      }, duration);
    }
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-NG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function formatTransactionType(value) {
    return String(value ?? '—')
      .replaceAll('_', ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function updateDashboardClock() {
    const now = new Date();
    const dateElement = document.querySelector('#dashboardDate');
    const timeElement = document.querySelector('#dashboardTime');

    if (dateElement) {
      dateElement.textContent = new Intl.DateTimeFormat('en-NG', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      }).format(now);
    }

    if (timeElement) {
      timeElement.textContent = new Intl.DateTimeFormat('en-NG', {
        hour: '2-digit', minute: '2-digit', hour12: true,
      }).format(now);
    }
  }

  function setText(id, value) {
    const element = document.querySelector(`#${id}`);
    if (element) element.textContent = value;
  }

  function renderSummary(summary = {}) {
    setText('activeCustomers', Number(summary.active_customers ?? 0).toLocaleString('en-NG'));
    setText('customerFunds', formatCurrencyMinor(summary.positive_customer_balances_minor ?? 0));
    setText('overdraftExposure', formatCurrencyMinor(summary.overdraft_exposure_minor ?? 0));
    setText('loanOutstanding', formatCurrencyMinor(summary.loan_outstanding_minor ?? 0));
    setText('todayDeposits', formatCurrencyMinor(summary.today_net_deposits_minor ?? 0));
    setText('todayWithdrawals', formatCurrencyMinor(summary.today_withdrawals_minor ?? 0));
    setText('todayRevenue', formatCurrencyMinor(summary.today_revenue_minor ?? 0));
    setText('todayExpenses', formatCurrencyMinor(summary.today_expenses_minor ?? 0));
    setText('todayOperationalNet', formatCurrencyMinor(summary.today_operational_net_minor ?? 0));

    const netContainer = document.querySelector('#operationalNet');
    const net = BigInt(String(summary.today_operational_net_minor ?? 0));
    if (netContainer) {
      netContainer.classList.toggle('negative', net < 0n);
      netContainer.classList.toggle('positive', net >= 0n);
      netContainer.dataset.sign = net < 0n ? 'negative' : 'positive';
    }

    const todayFlowStatus = document.querySelector('#todayFlowStatus');
    if (todayFlowStatus) {
      const hasActivity = [
        summary.today_net_deposits_minor,
        summary.today_withdrawals_minor,
        summary.today_revenue_minor,
        summary.today_expenses_minor,
      ].some((value) => BigInt(String(value || 0)) !== 0n);
      todayFlowStatus.textContent = hasActivity ? 'Activity recorded today' : 'No approved movement yet';
    }

    const approvals = [
      ['pendingTransactions', summary.pending_transactions ?? 0],
      ['pendingLoans', summary.pending_loans ?? 0],
      ['pendingRepayments', summary.pending_loan_repayments ?? 0],
      ['pendingOverdrafts', summary.pending_overdrafts ?? 0],
      ['pendingExpenses', summary.pending_expenses ?? 0],
    ];

    let pendingTotal = 0;
    for (const [id, value] of approvals) {
      const count = Number(value || 0);
      pendingTotal += count;
      setText(id, count.toLocaleString('en-NG'));
      document.querySelector(`#${id}`)?.classList.toggle('has-items', count > 0);
    }
    setText('pendingTotal', pendingTotal.toLocaleString('en-NG'));
  }

  function renderTransactions(rows = []) {
    const body = document.querySelector('#recentTransactionsBody');
    const empty = document.querySelector('#recentTransactionsEmpty');
    if (!body) return;
    body.replaceChildren();

    for (const row of rows) {
      const tr = document.createElement('tr');

      const reference = document.createElement('td');
      const refPrimary = document.createElement('span');
      refPrimary.className = 'cell-primary';
      refPrimary.textContent = row.reference || '—';
      const refSecondary = document.createElement('span');
      refSecondary.className = 'cell-secondary';
      refSecondary.textContent = formatDate(row.created_at);
      reference.append(refPrimary, refSecondary);

      const customer = document.createElement('td');
      const customerPrimary = document.createElement('span');
      customerPrimary.className = 'cell-primary';
      customerPrimary.textContent = row.customer_name || '—';
      const customerSecondary = document.createElement('span');
      customerSecondary.className = 'cell-secondary';
      customerSecondary.textContent = `Customer ${row.customer_number || '—'} · ${row.account_number || '—'}`;
      customer.append(customerPrimary, customerSecondary);

      const type = document.createElement('td');
      const typePrimary = document.createElement('span');
      typePrimary.className = 'cell-primary';
      typePrimary.textContent = formatTransactionType(row.type);
      type.append(typePrimary);

      const amount = document.createElement('td');
      amount.className = 'money-cell';
      amount.textContent = formatCurrencyMinor(row.net_amount_minor ?? row.amount_minor, row.currency || 'NGN');

      const status = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'state-badge';
      badge.dataset.status = row.status;
      badge.textContent = row.status || '—';
      status.append(badge);

      tr.append(reference, customer, type, amount, status);
      body.append(tr);
    }

    if (empty) empty.hidden = rows.length > 0;
  }

  function renderExpenses(rows = []) {
    const body = document.querySelector('#recentExpensesBody');
    const empty = document.querySelector('#recentExpensesEmpty');
    if (!body) return;
    body.replaceChildren();

    for (const row of rows) {
      const tr = document.createElement('tr');

      const number = document.createElement('td');
      const primary = document.createElement('span');
      primary.className = 'cell-primary';
      primary.textContent = row.expense_number || '—';
      const secondary = document.createElement('span');
      secondary.className = 'cell-secondary';
      secondary.textContent = row.expense_date || '—';
      number.append(primary, secondary);

      const description = document.createElement('td');
      const descPrimary = document.createElement('span');
      descPrimary.className = 'cell-primary';
      descPrimary.textContent = row.category || '—';
      const descSecondary = document.createElement('span');
      descSecondary.className = 'cell-secondary';
      descSecondary.textContent = row.description || '—';
      description.append(descPrimary, descSecondary);

      const amount = document.createElement('td');
      amount.className = 'money-cell';
      amount.textContent = formatCurrencyMinor(row.amount_minor ?? 0);

      const status = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'state-badge';
      badge.dataset.status = row.status;
      badge.textContent = row.status || '—';
      status.append(badge);

      tr.append(number, description, amount, status);
      body.append(tr);
    }

    if (empty) empty.hidden = rows.length > 0;
  }

  function renderSummaryError() {
    for (const id of [
      'activeCustomers', 'customerFunds', 'overdraftExposure', 'loanOutstanding',
      'todayDeposits', 'todayWithdrawals', 'todayRevenue', 'todayExpenses',
      'todayOperationalNet', 'pendingTransactions', 'pendingLoans',
      'pendingRepayments', 'pendingOverdrafts', 'pendingExpenses', 'pendingTotal',
    ]) setText(id, '—');
  }

  async function loadDashboard() {
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.classList.add('is-loading');
    }

    const results = await Promise.allSettled([
      getDashboardSummary(),
      getRecentTransactions(),
      getRecentExpenses(),
    ]);

    const [summaryResult, transactionResult, expenseResult] = results;
    const failures = [];

    if (summaryResult.status === 'fulfilled') {
      renderSummary(summaryResult.value || {});
    } else {
      renderSummaryError();
      failures.push(`Summary: ${summaryResult.reason?.message || 'failed to load'}`);
    }

    if (transactionResult.status === 'fulfilled') {
      renderTransactions(transactionResult.value || []);
    } else {
      renderTransactions([]);
      failures.push(`Recent transactions: ${transactionResult.reason?.message || 'failed to load'}`);
    }

    if (expenseResult.status === 'fulfilled') {
      renderExpenses(expenseResult.value || []);
    } else {
      renderExpenses([]);
      failures.push(`Recent expenses: ${expenseResult.reason?.message || 'failed to load'}`);
    }

    if (failures.length) {
      showMessage(failures.join(' · '), 'error', 9000);
    } else {
      showMessage('Dashboard data is up to date.', 'success', 1800);
    }

    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.classList.remove('is-loading');
    }
  }

  // Mobile navigation for the redesigned dashboard.
  const sidebar = document.querySelector('.sidebar');
  const menuToggle = document.querySelector('#dashboardMenuToggle');
  const overlay = document.querySelector('#dashboardSidebarOverlay');

  function closeMenu() {
    sidebar?.classList.remove('is-open');
    overlay?.classList.remove('is-open');
    document.body.classList.remove('dashboard-menu-open');
    menuToggle?.setAttribute('aria-expanded', 'false');
    if (menuToggle) menuToggle.textContent = 'Menu';
  }

  function openMenu() {
    sidebar?.classList.add('is-open');
    overlay?.classList.add('is-open');
    document.body.classList.add('dashboard-menu-open');
    menuToggle?.setAttribute('aria-expanded', 'true');
    if (menuToggle) menuToggle.textContent = 'Close';
  }

  menuToggle?.addEventListener('click', () => {
    sidebar?.classList.contains('is-open') ? closeMenu() : openMenu();
  });
  overlay?.addEventListener('click', closeMenu);
  sidebar?.querySelectorAll('a.nav-link').forEach((link) => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) closeMenu();
    });
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  // Dynamic staff initials.
  const userName = document.querySelector('#userName');
  const avatar = document.querySelector('#userAvatar');
  function syncAvatar() {
    if (!userName || !avatar) return;
    avatar.textContent = userName.textContent.trim().split(/\s+/).filter(Boolean)
      .slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || 'BL';
  }
  syncAvatar();
  if (userName) {
    new MutationObserver(syncAvatar).observe(userName, {
      childList: true, subtree: true, characterData: true,
    });
  }

  refreshButton?.addEventListener('click', loadDashboard);
  updateDashboardClock();
  window.setInterval(updateDashboardClock, 30_000);
  window.setInterval(loadDashboard, 300_000);
  await loadDashboard();
}
