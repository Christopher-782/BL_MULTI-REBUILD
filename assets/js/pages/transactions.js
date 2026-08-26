import {
  bindLogoutButtons,
  bindSessionUI,
  requireActiveProfile,
} from '../auth/access.js';

import {
  approveTransaction,
  bulkApproveStaffTransactions,
  formatCurrencyMinor,
  getAccountById,
  getCustomerTransactionContext,
  getFilteredTransactionTotals,
  getPendingTransactionMakers,
  getTransactionSummary,
  initiateTransaction,
  listTransactions,
  nairaToMinor,
  rejectTransaction,
  requestReversal,
  searchTransactionCustomers,
} from '../services/transactions.service.js';

const session = await requireActiveProfile();

if (session) {
  bindSessionUI(session.profile, session.user);
  bindLogoutButtons();

  const CAN_INITIATE = ['super_admin', 'admin', 'manager', 'staff'].includes(session.profile.role);
  const CAN_APPROVE = ['super_admin', 'admin', 'manager'].includes(session.profile.role);
  const CAN_REVERSE = ['super_admin', 'admin'].includes(session.profile.role);
  const STAFF_TRANSACTION_ONLY = session.profile.role === 'staff';

  const state = {
    page: 1,
    pageSize: 25,
    count: 0,
    search: '',
    status: 'all',
    type: 'all',
    makerId: STAFF_TRANSACTION_ONLY ? session.user.id : '',
    transactions: [],
    filteredTotals: null,
    customerContext: null,
    selectedAccount: null,
    selectedTransaction: null,
    bulkMakers: [],
    bulkMakerId: '',
    bulkSelectedIds: new Set(),
    customerSearchSelectedNumber: '',
  };

  const message = document.querySelector('#pageMessage');
  const tableBody = document.querySelector('#transactionsTableBody');
  const loading = document.querySelector('#transactionsLoading');
  const empty = document.querySelector('#transactionsEmpty');

  const newDialog = document.querySelector('#newTransactionDialog');
  const newForm = document.querySelector('#newTransactionForm');
  const customerPreview = document.querySelector('#customerPreview');
  const accountSelectWrap = document.querySelector('#accountSelectWrap');
  const accountSelect = document.querySelector('#accountSelect');
  const accountPreview = document.querySelector('#accountPreview');
  const chargeField = document.querySelector('#chargeField');
  const chargeInput = newForm.elements.charge;
  const netPreview = document.querySelector('#netAmountPreview');
  const chargeRuleMessage = document.querySelector('#chargeRuleMessage');
  const customerSearchResults = document.querySelector('#customerSearchResults');
  const customerSearchInput = newForm.elements.customerNumber;

  let customerSearchTimer = null;
  let customerSearchRequest = 0;
  let customerSearchItems = [];
  let customerSearchActiveIndex = -1;
  let transactionRequestKey = createRequestId();

  const rejectDialog = document.querySelector('#rejectDialog');
  const rejectForm = document.querySelector('#rejectForm');
  const reversalDialog = document.querySelector('#reversalDialog');
  const reversalForm = document.querySelector('#reversalForm');

  if (!CAN_INITIATE) {
    document.querySelectorAll('[data-transaction-initiate]').forEach((element) => {
      element.hidden = true;
    });
  }

  document.querySelectorAll('[data-transaction-approve]').forEach((element) => {
    element.hidden = !CAN_APPROVE;
  });

  if (STAFF_TRANSACTION_ONLY) {
    document.body.classList.add('staff-transaction-workspace');

    const summary = document.querySelector('.transaction-metric-grid');
    if (summary) summary.hidden = true;

    const topEyebrow = document.querySelector('.topbar .eyebrow');
    if (topEyebrow) topEyebrow.textContent = 'STAFF TRANSACTION DESK';

    const pageTitle = document.querySelector('.topbar h1');
    if (pageTitle) pageTitle.textContent = 'Transactions';

    const registerHeading = document.querySelector('.transaction-register-heading');
    if (registerHeading) registerHeading.textContent = 'My transaction submissions';

    const registerCopy = document.querySelector('#transactionRegisterCopy');
    if (registerCopy) {
      registerCopy.textContent = 'You can submit deposits and withdrawals here and follow the approval status of transactions you created. Management dashboards and other operational modules are not available to staff accounts.';
    }
  }

  function showMessage(text, type = 'success') {
    message.textContent = text;
    message.dataset.type = type;
    message.hidden = false;

    window.clearTimeout(showMessage.timer);

    showMessage.timer = window.setTimeout(() => {
      message.hidden = true;
    }, 7000);
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

  function customerName(customer) {
    return [
      customer?.first_name,
      customer?.middle_name,
      customer?.last_name,
    ].filter(Boolean).join(' ');
  }

  function renderPreview(container, fields) {
    const items = fields.map(([labelText, value]) => {
      const item = document.createElement('div');
      const label = document.createElement('span');
      const content = document.createElement('strong');
      label.textContent = labelText;
      content.textContent = String(value ?? '—');
      item.append(label, content);
      return item;
    });

    container.replaceChildren(...items);
  }

  function createRequestId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }

  function hideCustomerSearchResults() {
    customerSearchItems = [];
    customerSearchActiveIndex = -1;
    if (!customerSearchResults) return;
    customerSearchResults.hidden = true;
    customerSearchResults.replaceChildren();
    customerSearchInput.setAttribute('aria-expanded', 'false');
  }

  function setCustomerSearchActive(index) {
    if (!customerSearchResults || !customerSearchItems.length) return;

    const buttons = [...customerSearchResults.querySelectorAll('[data-customer-search-index]')];
    customerSearchActiveIndex = Math.max(0, Math.min(index, buttons.length - 1));

    buttons.forEach((button, buttonIndex) => {
      const active = buttonIndex === customerSearchActiveIndex;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) button.scrollIntoView({ block: 'nearest' });
    });
  }

  async function chooseCustomerSearchResult(result) {
    if (!result?.customer_number) return;

    state.customerSearchSelectedNumber = result.customer_number;
    customerSearchInput.value = result.customer_number;
    hideCustomerSearchResults();
    await resolveCustomer(result.matched_account_id || null);
  }

  function renderCustomerSearchResults(results, query) {
    if (!customerSearchResults) return;

    customerSearchResults.replaceChildren();
    customerSearchItems = results;
    customerSearchActiveIndex = -1;

    if (!results.length) {
      const emptyResult = document.createElement('div');
      emptyResult.className = 'customer-live-search-empty';
      emptyResult.textContent = `No customer found for “${query}”.`;
      customerSearchResults.append(emptyResult);
      customerSearchResults.hidden = false;
      customerSearchInput.setAttribute('aria-expanded', 'true');
      return;
    }

    results.forEach((result, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'customer-live-result';
      button.dataset.customerSearchIndex = String(index);
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', 'false');

      const main = document.createElement('span');
      main.className = 'customer-live-result-main';

      const name = document.createElement('strong');
      name.textContent = result.name || 'Unnamed customer';

      const number = document.createElement('span');
      number.textContent = `Customer ${result.customer_number}`;

      main.append(name, number);

      const meta = document.createElement('small');
      const details = [result.phone || 'No phone'];
      if (result.matched_account_number) {
        details.push(`Account ${result.matched_account_number}`);
      }
      meta.textContent = details.join(' · ');

      button.append(main, meta);
      button.addEventListener('mouseenter', () => setCustomerSearchActive(index));
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        chooseCustomerSearchResult(result);
      });
      customerSearchResults.append(button);
    });

    customerSearchResults.hidden = false;
    customerSearchInput.setAttribute('aria-expanded', 'true');
  }

  async function runDynamicCustomerSearch() {
    const query = customerSearchInput.value.trim();
    const requestId = ++customerSearchRequest;

    if (!query) {
      hideCustomerSearchResults();
      return;
    }

    if (!/^\d{1,3}$/.test(query) && query.length < 2) {
      hideCustomerSearchResults();
      return;
    }

    if (customerSearchResults) {
      customerSearchResults.replaceChildren();
      const loadingResult = document.createElement('div');
      loadingResult.className = 'customer-live-search-empty';
      loadingResult.textContent = 'Searching customers...';
      customerSearchResults.append(loadingResult);
      customerSearchResults.hidden = false;
      customerSearchInput.setAttribute('aria-expanded', 'true');
    }

    try {
      const results = await searchTransactionCustomers(query, { limit: 8 });
      if (requestId !== customerSearchRequest) return;
      renderCustomerSearchResults(results, query);
    } catch (error) {
      if (requestId !== customerSearchRequest) return;
      hideCustomerSearchResults();
      showMessage(error.message, 'error');
    }
  }

  function statusBadge(status) {
    const badge = document.createElement('span');
    badge.className = 'state-badge';
    badge.dataset.status = status;
    badge.textContent = status;
    return badge;
  }

  function typeBadge(type) {
    const badge = document.createElement('span');
    badge.className = 'transaction-type-badge';
    badge.dataset.type = type;
    badge.textContent = type;
    return badge;
  }

  function resetCustomerSelection() {
    state.customerContext = null;
    state.selectedAccount = null;
    state.customerSearchSelectedNumber = '';

    customerPreview.hidden = true;
    customerPreview.replaceChildren();

    accountSelectWrap.hidden = true;
    accountSelect.replaceChildren();

    accountPreview.hidden = true;
    accountPreview.replaceChildren();

    chargeRuleMessage.hidden = true;
    chargeRuleMessage.textContent = '';
    hideCustomerSearchResults();

    updateChargeUI();
  }

  function renderCustomerContext(context, preferredAccountId = null) {
    state.customerContext = context;

    const customer = context?.customer;
    const accounts = Array.isArray(context?.accounts) ? context.accounts : [];

    if (!customer) {
      resetCustomerSelection();
      return;
    }

    renderPreview(customerPreview, [
      ['Customer', customerName(customer) || '—'],
      ['Customer number', customer.customer_number || '—'],
      ['Phone', customer.phone || '—'],
      ['Status', customer.status || '—'],
    ]);
    state.customerSearchSelectedNumber = customer.customer_number || '';
    if (customer.customer_number) customerSearchInput.value = customer.customer_number;
    hideCustomerSearchResults();
    customerPreview.hidden = false;

    accountSelect.replaceChildren();

    if (!accounts.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No accounts found';
      accountSelect.append(option);
      accountSelect.disabled = true;
      accountSelectWrap.hidden = false;
      renderSelectedAccount(null);
      return;
    }

    accountSelect.disabled = false;

    for (const account of accounts) {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent =
        `${account.account_number} · ${account.account_type} · ${formatCurrencyMinor(account.cached_balance_minor, account.currency)}`;
      accountSelect.append(option);
    }

    accountSelectWrap.hidden = false;

    const selected =
      accounts.find((account) => account.id === preferredAccountId) ??
      accounts[0];

    accountSelect.value = selected.id;
    renderSelectedAccount(selected);
  }

  function renderSelectedAccount(account) {
    state.selectedAccount = account;

    if (!account) {
      accountPreview.hidden = true;
      accountPreview.replaceChildren();
      chargeRuleMessage.hidden = true;
      updateChargeUI();
      return;
    }

    renderPreview(accountPreview, [
      ['Account number', account.account_number],
      ['Account type', account.account_type],
      ['Account balance', formatCurrencyMinor(account.cached_balance_minor, account.currency)],
      [
        'Available for normal withdrawal',
        formatCurrencyMinor(
          account.withdrawable_minor ?? (
            BigInt(String(account.cached_balance_minor || 0)) > 0n
              ? BigInt(String(account.cached_balance_minor || 0))
              : 0n
          ),
          account.currency,
        ),
      ],
      [
        'Overdraft outstanding',
        formatCurrencyMinor(account.overdraft_outstanding_minor || 0, account.currency),
      ],
      ['Status', account.status],
    ]);
    accountPreview.hidden = false;

    updateChargeUI();
  }

  async function resolveCustomer(preferredAccountId = null) {
    const customerNumber = newForm.elements.customerNumber.value.trim();

    if (!customerNumber) {
      resetCustomerSelection();
      return null;
    }

    const button = document.querySelector('#lookupCustomer');
    button.disabled = true;
    button.textContent = 'Checking...';

    try {
      const context = await getCustomerTransactionContext(customerNumber);
      renderCustomerContext(context, preferredAccountId);
      return context;
    } catch (error) {
      resetCustomerSelection();
      showMessage(error.message, 'error');
      return null;
    } finally {
      button.disabled = false;
      button.textContent = 'Find customer';
    }
  }

  function updateNetPreview() {
    const type = newForm.elements.type.value;

    if (type !== 'deposit') {
      netPreview.value = '';
      return;
    }

    try {
      const amount = BigInt(
        nairaToMinor(newForm.elements.amount.value || '0', { allowZero: true }),
      );
      const charge = BigInt(
        nairaToMinor(chargeInput.value || '0', { allowZero: true }),
      );

      if (amount <= 0n || charge < 0n || charge >= amount) {
        netPreview.value = '';
        return;
      }

      netPreview.value = formatCurrencyMinor((amount - charge).toString());
    } catch {
      netPreview.value = '';
    }
  }

  function updateChargeUI() {
    const isDeposit = newForm.elements.type.value === 'deposit';
    const account = state.selectedAccount;

    chargeField.hidden = !isDeposit;
    chargeInput.disabled = !isDeposit;
    chargeInput.required = Boolean(
      isDeposit &&
      account?.charge_required,
    );

    if (!isDeposit) {
      chargeInput.value = '0.00';
      chargeRuleMessage.hidden = true;
      chargeRuleMessage.textContent = '';
      netPreview.value = '';
      return;
    }

    if (account?.charge_required) {
      chargeRuleMessage.dataset.type = 'warning';
      chargeRuleMessage.textContent =
        `Charge required: ${account.charge_reason || 'this account requires a deposit charge.'}`;
      chargeRuleMessage.hidden = false;
    } else {
      chargeRuleMessage.hidden = true;
      chargeRuleMessage.textContent = '';
    }

    updateNetPreview();
  }

  function canReview(row) {
    if (!CAN_APPROVE || row.status !== 'pending') return false;
    if (row.initiated_by === session.user.id) return false;
    if (row.type === 'reversal' && !CAN_REVERSE) return false;
    return true;
  }


  function selectedBulkRows() {
    return state.transactions.filter((row) => state.bulkSelectedIds.has(row.id));
  }

  function updateBulkSelectionUI() {
    if (!CAN_APPROVE) return;

    const selectedRows = selectedBulkRows();
    const selectedCount = selectedRows.length;
    const amountMinor = selectedRows.reduce(
      (sum, row) => sum + BigInt(String(row.amount_minor || 0)),
      0n,
    );

    const badge = document.querySelector('#bulkApprovalBadge');
    const amount = document.querySelector('#bulkSelectedAmount');
    const approveButton = document.querySelector('#approveSelectedTransactions');

    if (badge) badge.textContent = `${selectedCount} selected`;
    if (amount) amount.textContent = `Selected amount: ${formatCurrencyMinor(amountMinor)}`;
    if (approveButton) approveButton.disabled = selectedCount === 0 || !state.bulkMakerId;

    document.querySelectorAll('[data-bulk-transaction-id]').forEach((checkbox) => {
      checkbox.checked = state.bulkSelectedIds.has(checkbox.dataset.bulkTransactionId);
    });
  }

  async function loadBulkMakers() {
    if (!CAN_APPROVE) return;

    try {
      state.bulkMakers = await getPendingTransactionMakers();
      const select = document.querySelector('#bulkStaffSelect');
      const previous = state.bulkMakerId;
      select.replaceChildren();

      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = state.bulkMakers.length
        ? 'Choose staff member'
        : 'No eligible pending staff transactions';
      select.append(placeholder);

      for (const maker of state.bulkMakers) {
        const option = document.createElement('option');
        option.value = maker.staff_id;
        option.textContent = `${maker.staff_name} · ${Number(maker.pending_count || 0).toLocaleString('en-NG')} pending · ${formatCurrencyMinor(maker.pending_amount_minor || 0)}`;
        select.append(option);
      }

      if (previous && state.bulkMakers.some((maker) => maker.staff_id === previous)) {
        select.value = previous;
      } else if (previous) {
        state.bulkMakerId = '';
      }
    } catch (error) {
      showMessage(error.message, 'error');
    }
  }

  function renderBulkQueueSummary() {
    if (!CAN_APPROVE) return;
    const summary = document.querySelector('#bulkStaffQueueSummary');
    if (!summary) return;

    if (!state.bulkMakerId) {
      summary.textContent = 'Choose a staff member to begin.';
      return;
    }

    const maker = state.bulkMakers.find((item) => item.staff_id === state.bulkMakerId);
    if (!maker) {
      summary.textContent = `${state.count.toLocaleString('en-NG')} pending transaction(s) in this filtered queue.`;
      return;
    }

    summary.textContent = `${maker.staff_name}: ${Number(maker.pending_count || 0).toLocaleString('en-NG')} pending transaction(s), ${formatCurrencyMinor(maker.pending_amount_minor || 0)} gross amount.`;
  }

  function renderActions(row) {
    const wrap = document.createElement('div');
    wrap.className = 'transaction-actions';

    if (canReview(row)) {
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'mini-button approve';
      approve.textContent = 'Approve';

      approve.addEventListener('click', async () => {
        const extra = row.type === 'deposit' && Number(row.charge_minor || 0) > 0
          ? ` Gross ${formatCurrencyMinor(row.amount_minor, row.currency)}, charge ${formatCurrencyMinor(row.charge_minor, row.currency)}, net ${formatCurrencyMinor(row.net_amount_minor, row.currency)}.`
          : '';

        if (!window.confirm(
          `Approve ${row.reference}?${extra} This will post the ledger entry and update the account balance.`,
        )) {
          return;
        }

        approve.disabled = true;

        try {
          await approveTransaction(row.id);
          showMessage(`${row.reference} approved successfully.`);
          await refreshAll();
        } catch (error) {
          showMessage(error.message, 'error');
        } finally {
          approve.disabled = false;
        }
      });

      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'mini-button danger';
      reject.textContent = 'Reject';

      reject.addEventListener('click', () => {
        state.selectedTransaction = row;
        rejectForm.reset();
        document.querySelector('#rejectTransactionReference').textContent = row.reference;
        rejectDialog.showModal();
      });

      wrap.append(approve, reject);
    }

    if (
      CAN_REVERSE &&
      row.status === 'approved' &&
      ['deposit', 'withdrawal'].includes(row.type) &&
      !row.reversed_by_transaction_id
    ) {
      const reverse = document.createElement('button');
      reverse.type = 'button';
      reverse.className = 'mini-button';
      reverse.textContent = 'Request reversal';

      reverse.addEventListener('click', () => {
        state.selectedTransaction = row;
        reversalForm.reset();
        document.querySelector('#reversalTransactionReference').textContent = row.reference;
        reversalDialog.showModal();
      });

      wrap.append(reverse);
    }

    if (row.status === 'pending' && row.initiated_by === session.user.id) {
      const maker = document.createElement('small');
      maker.className = 'maker-note';
      maker.textContent = 'Awaiting another approver';
      wrap.append(maker);
    }

    if (!wrap.childNodes.length) {
      const dash = document.createElement('span');
      dash.className = 'muted-copy';
      dash.textContent = '—';
      wrap.append(dash);
    }

    return wrap;
  }

  function renderTransactions() {
    tableBody.replaceChildren();

    for (const row of state.transactions) {
      const tr = document.createElement('tr');

      if (CAN_APPROVE) {
        const selectCell = document.createElement('td');
        selectCell.className = 'bulk-select-column';

        if (state.bulkMakerId && row.initiated_by === state.bulkMakerId && canReview(row)) {
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'bulk-transaction-checkbox';
          checkbox.dataset.bulkTransactionId = row.id;
          checkbox.setAttribute('aria-label', `Select ${row.reference} for bulk approval`);
          checkbox.checked = state.bulkSelectedIds.has(row.id);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) state.bulkSelectedIds.add(row.id);
            else state.bulkSelectedIds.delete(row.id);
            updateBulkSelectionUI();
          });
          selectCell.append(checkbox);
        } else {
          selectCell.textContent = '—';
        }

        tr.append(selectCell);
      }

      const reference = document.createElement('td');
      const refStrong = document.createElement('strong');
      refStrong.textContent = row.reference;
      const refSmall = document.createElement('small');
      refSmall.textContent = formatDate(row.created_at);
      reference.append(refStrong, refSmall);

      const customer = document.createElement('td');
      const customerStrong = document.createElement('strong');
      customerStrong.textContent = row.customer_name || '—';
      const customerSmall = document.createElement('small');
      customerSmall.textContent =
        `Customer ${row.customer_number} · ${row.account_number}`;
      customer.append(customerStrong, customerSmall);

      const type = document.createElement('td');
      type.append(typeBadge(row.type));

      if (row.original_reference) {
        const original = document.createElement('small');
        original.textContent = `For ${row.original_reference}`;
        type.append(original);
      }

      const amount = document.createElement('td');
      amount.className = 'money-cell';

      const gross = document.createElement('strong');
      gross.textContent = formatCurrencyMinor(row.amount_minor, row.currency);
      amount.append(gross);

      if (row.type === 'deposit') {
        const breakdown = document.createElement('small');
        breakdown.textContent =
          `Charge ${formatCurrencyMinor(row.charge_minor || 0, row.currency)} · Net ${formatCurrencyMinor(row.net_amount_minor, row.currency)}`;
        amount.append(breakdown);
      } else if (row.type === 'reversal') {
        const posting = document.createElement('small');
        posting.textContent =
          `Ledger amount ${formatCurrencyMinor(row.net_amount_minor, row.currency)}`;
        amount.append(posting);
      }

      const status = document.createElement('td');
      status.append(statusBadge(row.status));

      if (row.rejection_reason) {
        const reason = document.createElement('small');
        reason.textContent = row.rejection_reason;
        status.append(reason);
      }

      const people = document.createElement('td');
      const maker = document.createElement('strong');
      maker.textContent = row.initiated_by_name || '—';
      const checker = document.createElement('small');
      checker.textContent = row.reviewed_by_name
        ? `Reviewed by ${row.reviewed_by_name}`
        : 'Not reviewed';
      people.append(maker, checker);

      const actions = document.createElement('td');
      actions.append(renderActions(row));

      tr.append(reference, customer, type, amount, status, people, actions);
      tableBody.append(tr);
    }

    empty.hidden = state.transactions.length > 0;

    const from = state.count === 0
      ? 0
      : (state.page - 1) * state.pageSize + 1;

    const to = Math.min(
      state.page * state.pageSize,
      state.count,
    );

    document.querySelector('#paginationText').textContent =
      `${from}–${to} of ${state.count}`;

    document.querySelector('#prevPage').disabled =
      state.page <= 1;

    document.querySelector('#nextPage').disabled =
      to >= state.count;

    updateBulkSelectionUI();
    renderBulkQueueSummary();
  }

  function renderFilteredTotals() {
    const totals = state.filteredTotals || {};
    const title = document.querySelector('#filteredTotalsTitle');

    if (title) {
      const maker = state.bulkMakers.find((item) => item.staff_id === state.makerId);
      title.textContent = STAFF_TRANSACTION_ONLY
        ? 'My filtered transaction totals'
        : maker
          ? `${maker.staff_name} filtered totals`
          : 'Filtered transaction totals';
    }

    document.querySelector('#filteredTransactionCount').textContent =
      Number(totals.transaction_count || 0).toLocaleString('en-NG');
    document.querySelector('#filteredGrossAmount').textContent =
      formatCurrencyMinor(totals.gross_amount_minor || 0);
    document.querySelector('#filteredChargeAmount').textContent =
      formatCurrencyMinor(totals.charge_amount_minor || 0);
    document.querySelector('#filteredNetAmount').textContent =
      formatCurrencyMinor(totals.net_amount_minor || 0);
  }

  async function loadTransactions() {
    loading.hidden = false;

    try {
      const [result, totals] = await Promise.all([
        listTransactions(state),
        getFilteredTransactionTotals(state),
      ]);
      state.transactions = result.transactions;
      state.count = result.count;
      state.filteredTotals = totals;

      const visibleIds = new Set(
        state.transactions
          .filter((row) => row.status === 'pending' && row.initiated_by === state.bulkMakerId)
          .map((row) => row.id),
      );
      state.bulkSelectedIds = new Set(
        [...state.bulkSelectedIds].filter((id) => visibleIds.has(id)),
      );

      renderTransactions();
      renderFilteredTotals();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      loading.hidden = true;
    }
  }

  async function loadSummary() {
    if (STAFF_TRANSACTION_ONLY) return;

    try {
      const summary = await getTransactionSummary();

      document.querySelector('#pendingCount').textContent =
        summary.pending_count ?? 0;

      document.querySelector('#approvedTodayCount').textContent =
        summary.approved_today_count ?? 0;

      document.querySelector('#depositsToday').textContent =
        formatCurrencyMinor(summary.deposits_today_minor ?? 0);

      document.querySelector('#chargesToday').textContent =
        formatCurrencyMinor(summary.charges_today_minor ?? 0);

      document.querySelector('#withdrawalsToday').textContent =
        formatCurrencyMinor(summary.withdrawals_today_minor ?? 0);
    } catch (error) {
      showMessage(error.message, 'error');
    }
  }

  async function refreshAll() {
    const tasks = [loadTransactions()];
    if (!STAFF_TRANSACTION_ONLY) tasks.push(loadSummary());
    if (CAN_APPROVE) tasks.push(loadBulkMakers());

    await Promise.all(tasks);
    renderBulkQueueSummary();
  }

  document
    .querySelector('#transactionFilterForm')
    .addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;

      state.page = 1;
      state.search = form.elements.search.value;
      state.status = form.elements.status.value;
      state.type = form.elements.type.value;

      await loadTransactions();
    });

  document
    .querySelector('#clearTransactionFilters')
    .addEventListener('click', async () => {
      const form = document.querySelector('#transactionFilterForm');
      form.reset();

      state.page = 1;
      state.search = '';
      state.status = 'all';
      state.type = 'all';
      state.pageSize = 25;
      state.makerId = STAFF_TRANSACTION_ONLY ? session.user.id : '';
      state.bulkMakerId = '';
      state.bulkSelectedIds.clear();
      const bulkSelect = document.querySelector('#bulkStaffSelect');
      if (bulkSelect) bulkSelect.value = '';

      await loadTransactions();
      renderBulkQueueSummary();
    });

  document
    .querySelector('#refreshTransactions')
    .addEventListener('click', refreshAll);

  document
    .querySelector('#prevPage')
    .addEventListener('click', async () => {
      if (state.page > 1) {
        state.page -= 1;
        await loadTransactions();
      }
    });

  document
    .querySelector('#nextPage')
    .addEventListener('click', async () => {
      if (state.page * state.pageSize < state.count) {
        state.page += 1;
        await loadTransactions();
      }
    });


  if (CAN_APPROVE) {
    const staffSelect = document.querySelector('#bulkStaffSelect');
    const loadStaffButton = document.querySelector('#loadStaffPending');
    const selectAllButton = document.querySelector('#selectAllVisible');
    const clearSelectionButton = document.querySelector('#clearBulkSelection');
    const approveSelectedButton = document.querySelector('#approveSelectedTransactions');

    loadStaffButton.addEventListener('click', async () => {
      const staffId = staffSelect.value;
      if (!staffId) {
        showMessage('Choose a staff member first.', 'error');
        return;
      }

      state.bulkMakerId = staffId;
      state.makerId = staffId;
      state.status = 'pending';
      state.pageSize = 100;
      state.page = 1;
      state.bulkSelectedIds.clear();

      const filterForm = document.querySelector('#transactionFilterForm');
      filterForm.elements.status.value = 'pending';

      await loadTransactions();
      renderBulkQueueSummary();
    });

    staffSelect.addEventListener('change', () => {
      if (!staffSelect.value) {
        state.bulkMakerId = '';
        state.makerId = '';
        state.bulkSelectedIds.clear();
        updateBulkSelectionUI();
        renderBulkQueueSummary();
      }
    });

    selectAllButton.addEventListener('click', () => {
      if (!state.bulkMakerId) {
        showMessage('Load a staff pending queue first.', 'error');
        return;
      }

      for (const row of state.transactions) {
        if (row.initiated_by === state.bulkMakerId && canReview(row)) {
          state.bulkSelectedIds.add(row.id);
        }
      }
      updateBulkSelectionUI();
    });

    clearSelectionButton.addEventListener('click', () => {
      state.bulkSelectedIds.clear();
      updateBulkSelectionUI();
    });

    approveSelectedButton.addEventListener('click', async () => {
      const ids = [...state.bulkSelectedIds];
      if (!state.bulkMakerId || !ids.length) return;

      const rows = selectedBulkRows();
      const amountMinor = rows.reduce(
        (sum, row) => sum + BigInt(String(row.amount_minor || 0)),
        0n,
      );
      const maker = state.bulkMakers.find((item) => item.staff_id === state.bulkMakerId);
      const makerName = maker?.staff_name || 'selected staff';

      if (!window.confirm(
        `Approve ${ids.length} selected transaction(s) from ${makerName} totaling ${formatCurrencyMinor(amountMinor)}? Each item will still run the normal maker-checker and balance rules.`,
      )) return;

      approveSelectedButton.disabled = true;
      approveSelectedButton.textContent = 'Approving...';

      try {
        const result = await bulkApproveStaffTransactions(state.bulkMakerId, ids);
        const approved = Number(result?.approved_count || 0);
        const failed = Number(result?.failed_count || 0);

        state.bulkSelectedIds.clear();

        if (failed > 0) {
          const firstFailures = (result?.results || [])
            .filter((item) => item.status === 'failed')
            .slice(0, 3)
            .map((item) => `${item.reference || 'Transaction'}: ${item.error}`)
            .join(' · ');
          showMessage(
            `${approved} approved, ${failed} failed. ${firstFailures}`,
            'error',
          );
        } else {
          showMessage(`${approved} transaction(s) approved successfully for ${makerName}.`);
        }

        await refreshAll();
      } catch (error) {
        showMessage(error.message, 'error');
      } finally {
        approveSelectedButton.textContent = 'Approve selected';
        updateBulkSelectionUI();
      }
    });
  }

  if (CAN_INITIATE) {
    document
      .querySelector('#openNewTransaction')
      .addEventListener('click', () => {
        transactionRequestKey = createRequestId();
        newForm.reset();
        newForm.elements.charge.value = '0.00';
        resetCustomerSelection();
        newDialog.showModal();
      });

    document
      .querySelector('#lookupCustomer')
      .addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const value = customerSearchInput.value.trim();
        if (/^\d{1,3}$/.test(value)) {
          await resolveCustomer();
          return;
        }
        await runDynamicCustomerSearch();
      });

    customerSearchInput.addEventListener('input', () => {
      const value = customerSearchInput.value.trim();

      if (
        state.customerSearchSelectedNumber &&
        value !== state.customerSearchSelectedNumber
      ) {
        resetCustomerSelection();
      }

      window.clearTimeout(customerSearchTimer);

      if (!value) {
        hideCustomerSearchResults();
        resetCustomerSelection();
        return;
      }

      customerSearchTimer = window.setTimeout(runDynamicCustomerSearch, 220);
    });

    customerSearchInput.addEventListener('keydown', (event) => {
      if (customerSearchResults?.hidden || !customerSearchItems.length) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCustomerSearchActive(
          customerSearchActiveIndex < 0 ? 0 : customerSearchActiveIndex + 1,
        );
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCustomerSearchActive(
          customerSearchActiveIndex <= 0
            ? customerSearchItems.length - 1
            : customerSearchActiveIndex - 1,
        );
      } else if (event.key === 'Enter') {
        const index = customerSearchActiveIndex >= 0 ? customerSearchActiveIndex : 0;
        const result = customerSearchItems[index];
        if (result) {
          event.preventDefault();
          chooseCustomerSearchResult(result);
        }
      } else if (event.key === 'Escape') {
        hideCustomerSearchResults();
      }
    });

    document.addEventListener('click', (event) => {
      if (
        customerSearchResults &&
        !customerSearchResults.contains(event.target) &&
        event.target !== customerSearchInput
      ) {
        hideCustomerSearchResults();
      }
    });

    accountSelect.addEventListener('change', () => {
      const account =
        state.customerContext?.accounts?.find(
          (item) => item.id === accountSelect.value,
        ) ?? null;

      renderSelectedAccount(account);
    });

    newForm.elements.type
      .addEventListener('change', updateChargeUI);

    newForm.elements.amount
      .addEventListener('input', updateNetPreview);

    chargeInput
      .addEventListener('input', updateNetPreview);

    let transactionSubmitting = false;

    newForm.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') {
        event.preventDefault();
      }
    });

    async function submitNewTransaction(event) {
      // Only allow the actual submit button to trigger transaction creation.
      if (event && event.currentTarget && event.currentTarget.type === 'button') {
        return;
      }
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      if (transactionSubmitting) {
        return;
      }

      transactionSubmitting = true;

      if (!state.customerContext) {
        const value = customerSearchInput.value.trim();
        if (!/^\d{1,3}$/.test(value)) {
          showMessage('Choose a customer from the live search results before submitting.', 'error');
          await runDynamicCustomerSearch();
          return;
        }

        const context = await resolveCustomer();
        if (!context) return;
      }

      const account = state.selectedAccount;

      if (!account) {
        showMessage('Select a customer account.', 'error');
        return;
      }

      if (account.status !== 'active') {
        showMessage('Only active accounts can receive new transactions.', 'error');
        return;
      }

      const type = newForm.elements.type.value;
      const charge = type === 'deposit'
        ? newForm.elements.charge.value
        : '0';

      if (
        type === 'deposit' &&
        account.charge_required
      ) {
        try {
          const chargeMinor = BigInt(
            nairaToMinor(charge, { allowZero: true }),
          );

          if (chargeMinor <= 0n) {
            showMessage(
              'A positive charge is mandatory for this deposit.',
              'error',
            );
            return;
          }
        } catch (error) {
          showMessage(error.message, 'error');
          return;
        }
      }

      const submit = newForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = 'Submitting...';

      try {
        const transaction = await initiateTransaction({
          accountId: account.id,
          type,
          amount: newForm.elements.amount.value,
          charge,
          description: newForm.elements.description.value,
          idempotencyKey: transactionRequestKey,
        });

        newDialog.close();
        transactionRequestKey = createRequestId();

        const chargeText =
          type === 'deposit' && Number(transaction.charge_minor || 0) > 0
            ? ` Gross ${formatCurrencyMinor(transaction.amount_minor)}, charge ${formatCurrencyMinor(transaction.charge_minor)}, net ${formatCurrencyMinor(transaction.net_amount_minor)}.`
            : '';

        showMessage(
          `Transaction ${transaction.reference} submitted successfully and is awaiting approval.${chargeText}`,
        );

        await refreshAll();
      } catch (error) {
        showMessage(error.message, 'error');
      } finally {
        transactionSubmitting = false;
        submit.disabled = false;
        submit.textContent = 'Submit for approval';
      }
    }

    const submitNewTransactionButton = newForm.querySelector('button[type="submit"]');
    if (submitNewTransactionButton) {
      submitNewTransactionButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        submitNewTransaction({
          preventDefault: () => {},
          stopPropagation: () => {},
          currentTarget: newForm
        });
      });
    }
  }

  document
    .querySelector('#closeNewTransaction')
    .addEventListener('click', () => newDialog.close());

  document
    .querySelector('#cancelNewTransaction')
    .addEventListener('click', () => newDialog.close());

  document
    .querySelector('#closeRejectDialog')
    .addEventListener('click', () => rejectDialog.close());

  document
    .querySelector('#cancelReject')
    .addEventListener('click', () => rejectDialog.close());

  rejectForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!state.selectedTransaction) return;

    const submit = rejectForm.querySelector('button[type="submit"]');
    submit.disabled = true;

    try {
      await rejectTransaction(
        state.selectedTransaction.id,
        rejectForm.elements.reason.value,
      );

      rejectDialog.close();

      showMessage(
        `${state.selectedTransaction.reference} rejected.`,
      );

      await refreshAll();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  document
    .querySelector('#closeReversalDialog')
    .addEventListener('click', () => reversalDialog.close());

  document
    .querySelector('#cancelReversal')
    .addEventListener('click', () => reversalDialog.close());

  reversalForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!state.selectedTransaction) return;

    const submit = reversalForm.querySelector('button[type="submit"]');
    submit.disabled = true;

    try {
      const reversal = await requestReversal(
        state.selectedTransaction.id,
        reversalForm.elements.reason.value,
      );

      reversalDialog.close();

      showMessage(
        `${reversal.reference} created and is awaiting another administrator's approval.`,
      );

      await refreshAll();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });

  // Customer-page shortcut:
  // The form is still based on customer number. When an account ID
  // is supplied by customer.html, we use it only to preselect the
  // correct customer/account automatically.
  const params = new URLSearchParams(window.location.search);
  const prefillAccountId = params.get('account');
  const prefillType = params.get('type');

  if (CAN_INITIATE && prefillAccountId) {
    try {
      const account = await getAccountById(prefillAccountId);
      const customerNumber = account.customers?.customer_number;

      newForm.reset();
      transactionRequestKey = createRequestId();
      newForm.elements.charge.value = '0.00';

      if (['deposit', 'withdrawal'].includes(prefillType)) {
        newForm.elements.type.value = prefillType;
      }

      newForm.elements.customerNumber.value =
        customerNumber || '';

      if (customerNumber) {
        await resolveCustomer(account.id);
      }

      newDialog.showModal();

      window.history.replaceState(
        {},
        '',
        './transactions.html',
      );
    } catch (error) {
      showMessage(error.message, 'error');
    }
  }

  await refreshAll();
}
