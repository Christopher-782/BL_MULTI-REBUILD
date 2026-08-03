import {
  bindLogoutButtons,
  bindSessionUI,
  requireActiveProfile,
} from "./assets/js/auth/access.js";

import {
  getDashboardSummary,
  getRecentExpenses,
  getRecentTransactions,
} from "./assets/js/services/dashboard.service.js";

import { formatCurrencyMinor } from "./assets/js/services/transactions.service.js";

// ========================================
// Dashboard Controller
// ========================================

const session = await requireActiveProfile();

if (!session) {
  // Not authenticated — redirect handled by requireActiveProfile
  throw new Error("Authentication required");
}

// Bind auth UI
bindSessionUI(session.profile, session.user);
bindLogoutButtons();

// DOM References
const message = document.querySelector("#pageMessage");
const refreshButton = document.querySelector("#refreshDashboard");

// ========================================
// Utilities
// ========================================

/**
 * Animate a number counter from 0 to target value
 */
function animateCounter(element, target, duration = 800, formatter = (v) => v) {
  const startTime = performance.now();
  const startValue = 0;

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const easeProgress = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(
      startValue + (target - startValue) * easeProgress,
    );

    element.textContent = formatter(current);

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      element.textContent = formatter(target);
    }
  }

  requestAnimationFrame(update);
}

/**
 * Show toast notification
 */
function showMessage(text, type = "error", duration = 5000) {
  message.textContent = text;
  message.dataset.type = type;
  message.hidden = false;

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => {
      message.hidden = true;
    }, duration);
  }
}

/**
 * Format transaction type for display
 */
function formatTransactionType(value) {
  return String(value ?? "—")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Format date/time
 */
function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

// ========================================
// Clock
// ========================================

function updateDashboardClock() {
  const now = new Date();

  const dateElement = document.querySelector("#dashboardDate");
  const timeElement = document.querySelector("#dashboardTime");

  if (dateElement) {
    dateElement.textContent = new Intl.DateTimeFormat("en-NG", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now);
  }

  if (timeElement) {
    timeElement.textContent = new Intl.DateTimeFormat("en-NG", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(now);
  }
}

updateDashboardClock();
window.setInterval(updateDashboardClock, 30_000);

// ========================================
// Skeleton Loading
// ========================================

function showSkeletons() {
  const kpiValues = document.querySelectorAll(".kpi-value");
  kpiValues.forEach((el) => {
    el.innerHTML =
      '<span class="skeleton skeleton-title" style="width: 80%; height: 1.75rem; display: inline-block;"></span>';
  });

  const flowAmounts = document.querySelectorAll(".flow-amount");
  flowAmounts.forEach((el) => {
    el.innerHTML =
      '<span class="skeleton" style="width: 80px; height: 1rem; display: inline-block;"></span>';
  });

  const approvalCounts = document.querySelectorAll(".approval-count");
  approvalCounts.forEach((el) => {
    el.innerHTML =
      '<span class="skeleton" style="width: 24px; height: 1rem; display: inline-block;"></span>';
  });

  const netValue = document.querySelector("#todayOperationalNet");
  if (netValue) {
    netValue.innerHTML =
      '<span class="skeleton" style="width: 100px; height: 1.5rem; display: inline-block;"></span>';
  }
}

// ========================================
// Render Summary
// ========================================

function renderSummary(summary) {
  // KPI Cards with animated counters
  const activeCustomersEl = document.querySelector("#activeCustomers");
  if (activeCustomersEl) {
    animateCounter(activeCustomersEl, summary.active_customers ?? 0, 800, (v) =>
      v.toLocaleString("en-NG"),
    );
  }

  const customerFundsEl = document.querySelector("#customerFunds");
  if (customerFundsEl) {
    const target = summary.positive_customer_balances_minor ?? 0;
    animateCounter(customerFundsEl, target, 1000, (v) =>
      formatCurrencyMinor(v),
    );
  }

  const overdraftEl = document.querySelector("#overdraftExposure");
  if (overdraftEl) {
    const target = summary.overdraft_exposure_minor ?? 0;
    animateCounter(overdraftEl, target, 1000, (v) => formatCurrencyMinor(v));
  }

  const loanEl = document.querySelector("#loanOutstanding");
  if (loanEl) {
    const target = summary.loan_outstanding_minor ?? 0;
    animateCounter(loanEl, target, 1000, (v) => formatCurrencyMinor(v));
  }

  // Money movement
  const depositsEl = document.querySelector("#todayDeposits");
  if (depositsEl) {
    const target = summary.today_net_deposits_minor ?? 0;
    animateCounter(depositsEl, target, 800, (v) => formatCurrencyMinor(v));
  }

  const withdrawalsEl = document.querySelector("#todayWithdrawals");
  if (withdrawalsEl) {
    const target = summary.today_withdrawals_minor ?? 0;
    animateCounter(withdrawalsEl, target, 800, (v) => formatCurrencyMinor(v));
  }

  const revenueEl = document.querySelector("#todayRevenue");
  if (revenueEl) {
    const target = summary.today_revenue_minor ?? 0;
    animateCounter(revenueEl, target, 800, (v) => formatCurrencyMinor(v));
  }

  const expensesEl = document.querySelector("#todayExpenses");
  if (expensesEl) {
    const target = summary.today_expenses_minor ?? 0;
    animateCounter(expensesEl, target, 800, (v) => formatCurrencyMinor(v));
  }

  // Operational net with color coding
  const netElement = document.querySelector("#todayOperationalNet");
  const netContainer = document.querySelector("#operationalNet");
  if (netElement) {
    const netValue = summary.today_operational_net_minor ?? 0;
    animateCounter(netElement, netValue, 1000, (v) => formatCurrencyMinor(v));

    if (netContainer) {
      netContainer.classList.remove("positive", "negative");
      netContainer.classList.add(netValue < 0 ? "negative" : "positive");
      netContainer.dataset.sign = netValue < 0 ? "negative" : "positive";
    }
  }

  // Flow status
  const flowStatus = document.querySelector("#todayFlowStatus");
  if (flowStatus) {
    const hasActivity =
      Number(summary.today_net_deposits_minor ?? 0) !== 0 ||
      Number(summary.today_withdrawals_minor ?? 0) !== 0 ||
      Number(summary.today_revenue_minor ?? 0) !== 0 ||
      Number(summary.today_expenses_minor ?? 0) !== 0;

    flowStatus.textContent = hasActivity
      ? "Activity recorded today"
      : "No approved movement yet";
  }

  // Pending approvals
  const approvals = [
    ["pendingTransactions", summary.pending_transactions ?? 0],
    ["pendingLoans", summary.pending_loans ?? 0],
    ["pendingRepayments", summary.pending_loan_repayments ?? 0],
    ["pendingOverdrafts", summary.pending_overdrafts ?? 0],
    ["pendingExpenses", summary.pending_expenses ?? 0],
  ];

  let totalPending = 0;

  for (const [id, value] of approvals) {
    const el = document.querySelector(`#${id}`);
    if (el) {
      const numValue = Number(value || 0);
      totalPending += numValue;
      animateCounter(el, numValue, 600, (v) => v.toLocaleString("en-NG"));
      el.classList.toggle("has-items", numValue > 0);
    }
  }

  const totalEl = document.querySelector("#pendingTotal");
  if (totalEl) {
    animateCounter(totalEl, totalPending, 700, (v) =>
      v.toLocaleString("en-NG"),
    );
  }
}

// ========================================
// Render Transactions
// ========================================

function renderTransactions(rows) {
  const body = document.querySelector("#recentTransactionsBody");
  const empty = document.querySelector("#recentTransactionsEmpty");

  if (!body) return;

  body.replaceChildren();

  for (const row of rows) {
    const tr = document.createElement("tr");

    const reference = document.createElement("td");
    reference.innerHTML = `
      <span class="cell-primary">${row.reference}</span>
      <span class="cell-secondary">${formatDate(row.created_at)}</span>
    `;

    const customer = document.createElement("td");
    customer.innerHTML = `
      <span class="cell-primary">${row.customer_name || "—"}</span>
      <span class="cell-secondary">Customer ${row.customer_number || "—"} · ${row.account_number || "—"}</span>
    `;

    const type = document.createElement("td");
    type.innerHTML = `<span class="cell-primary">${formatTransactionType(row.type)}</span>`;

    const amount = document.createElement("td");
    amount.className = "money-cell";
    amount.textContent = formatCurrencyMinor(
      row.net_amount_minor ?? row.amount_minor,
      row.currency,
    );

    const status = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "state-badge";
    badge.dataset.status = row.status;
    badge.textContent = row.status;
    status.append(badge);

    tr.append(reference, customer, type, amount, status);
    body.append(tr);
  }

  if (empty) {
    empty.hidden = rows.length > 0;
  }
}

// ========================================
// Render Expenses
// ========================================

function renderExpenses(rows) {
  const body = document.querySelector("#recentExpensesBody");
  const empty = document.querySelector("#recentExpensesEmpty");

  if (!body) return;

  body.replaceChildren();

  for (const row of rows) {
    const tr = document.createElement("tr");

    const number = document.createElement("td");
    number.innerHTML = `
      <span class="cell-primary">${row.expense_number}</span>
      <span class="cell-secondary">${row.expense_date}</span>
    `;

    const description = document.createElement("td");
    description.innerHTML = `
      <span class="cell-primary">${row.category}</span>
      <span class="cell-secondary">${row.description}</span>
    `;

    const amount = document.createElement("td");
    amount.className = "money-cell";
    amount.textContent = formatCurrencyMinor(row.amount_minor);

    const status = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "state-badge";
    badge.dataset.status = row.status;
    badge.textContent = row.status;
    status.append(badge);

    tr.append(number, description, amount, status);
    body.append(tr);
  }

  if (empty) {
    empty.hidden = rows.length > 0;
  }
}

// ========================================
// Load Dashboard
// ========================================

async function loadDashboard() {
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.classList.add("is-loading");
  }

  // Show skeletons while loading
  showSkeletons();

  try {
    const [summary, transactions, expenses] = await Promise.all([
      getDashboardSummary(),
      getRecentTransactions(),
      getRecentExpenses(),
    ]);

    renderSummary(summary);
    renderTransactions(transactions);
    renderExpenses(expenses);

    // Show success toast briefly
    showMessage("Dashboard updated successfully", "success", 2000);
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.classList.remove("is-loading");
    }
  }
}

// ========================================
// Event Listeners
// ========================================

if (refreshButton) {
  refreshButton.addEventListener("click", loadDashboard);
}

// Auto-refresh every 5 minutes
window.setInterval(loadDashboard, 300_000);

// Keyboard shortcut: Ctrl+R or Cmd+R to refresh (prevent default if focused on dashboard)
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "r") {
    e.preventDefault();
    loadDashboard();
  }
});



// ========================================
// Responsive navigation
// ========================================

const dashboardSidebar = document.querySelector('.sidebar');
const dashboardMenuToggle = document.querySelector('#dashboardMenuToggle');
const dashboardSidebarOverlay = document.querySelector('#dashboardSidebarOverlay');

function closeDashboardMenu() {
  dashboardSidebar?.classList.remove('is-open');
  dashboardSidebarOverlay?.classList.remove('is-open');
  document.body.classList.remove('dashboard-menu-open');

  if (dashboardMenuToggle) {
    dashboardMenuToggle.setAttribute('aria-expanded', 'false');
    dashboardMenuToggle.setAttribute('aria-label', 'Open navigation');
    dashboardMenuToggle.textContent = 'Menu';
  }
}

function openDashboardMenu() {
  dashboardSidebar?.classList.add('is-open');
  dashboardSidebarOverlay?.classList.add('is-open');
  document.body.classList.add('dashboard-menu-open');

  if (dashboardMenuToggle) {
    dashboardMenuToggle.setAttribute('aria-expanded', 'true');
    dashboardMenuToggle.setAttribute('aria-label', 'Close navigation');
    dashboardMenuToggle.textContent = 'Close';
  }
}

if (dashboardMenuToggle) {
  dashboardMenuToggle.addEventListener('click', () => {
    dashboardSidebar?.classList.contains('is-open')
      ? closeDashboardMenu()
      : openDashboardMenu();
  });
}

dashboardSidebarOverlay?.addEventListener('click', closeDashboardMenu);

dashboardSidebar?.querySelectorAll('a.nav-link').forEach((link) => {
  link.addEventListener('click', () => {
    if (window.innerWidth <= 768) closeDashboardMenu();
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && dashboardSidebar?.classList.contains('is-open')) {
    closeDashboardMenu();
    dashboardMenuToggle?.focus();
  }
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 768) closeDashboardMenu();
});

// Dynamic user initials on the redesigned dashboard.
const dashboardUserName = document.querySelector('#userName');
const dashboardUserAvatar = document.querySelector('#userAvatar');

function syncDashboardAvatar() {
  if (!dashboardUserName || !dashboardUserAvatar) return;

  const initials = dashboardUserName.textContent
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');

  dashboardUserAvatar.textContent = initials || 'BL';
}

syncDashboardAvatar();

if (dashboardUserName) {
  new MutationObserver(syncDashboardAvatar).observe(dashboardUserName, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

// ========================================
// Initialize
// ========================================

await loadDashboard();
