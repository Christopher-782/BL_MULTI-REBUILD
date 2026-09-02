import { bindLogoutButtons, bindSessionUI, requireActiveProfile } from '../auth/access.js';
import {
  createCustomerAccount,
  getCustomer,
  updateAccountStatus,
  updateCustomer,
} from '../services/customers.service.js';
import { getCustomerTransactionHistory } from '../services/transactions.service.js';

const session = await requireActiveProfile();

if (session) {
  bindSessionUI(session.profile, session.user);
  bindLogoutButtons();

  const CAN_MANAGE = ['super_admin', 'admin', 'manager', 'staff'].includes(session.profile.role);
  const customerId = new URLSearchParams(window.location.search).get('id');
  const message = document.querySelector('#pageMessage');
  const form = document.querySelector('#customerDetailsForm');
  const accountsBody = document.querySelector('#accountsTableBody');
  const transactionsBody = document.querySelector('#customerTransactionsTableBody');
  const transactionsEmpty = document.querySelector('#customerTransactionsEmpty');
  const transactionCount = document.querySelector('#customerTransactionCount');
  const accountDialog = document.querySelector('#createAccountDialog');
  const accountForm = document.querySelector('#createAccountForm');
  let customer = null;

  if (!customerId) {
    window.location.replace('./customers.html');
  }

  if (!CAN_MANAGE) {
    document.querySelectorAll('[data-customer-manage]').forEach((element) => {
      element.hidden = true;
    });
    form.querySelectorAll('input, select, textarea, button[type="submit"]').forEach((element) => {
      element.disabled = true;
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

  function formatCurrencyMinor(value = 0, currency = 'NGN') {
    const minor = BigInt(String(value ?? 0));
    const negative = minor < 0n;
    const absolute = negative ? -minor : minor;
    const whole = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, '0');
    const currencyPart = new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0).find((part) => part.type === 'currency')?.value || currency;
    const groupedWhole = new Intl.NumberFormat('en-NG', {
      maximumFractionDigits: 0,
    }).format(whole);

    return `${negative ? '-' : ''}${currencyPart}${groupedWhole}.${fraction}`;
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

  function fullName(record) {
    return [record.first_name, record.middle_name, record.last_name].filter(Boolean).join(' ');
  }

  function statusBadge(status) {
    const badge = document.createElement('span');
    badge.className = 'state-badge';
    badge.dataset.status = status;
    badge.textContent = status;
    return badge;
  }

  function fillCustomerForm(record) {
    form.elements.firstName.value = record.first_name || '';
    form.elements.middleName.value = record.middle_name || '';
    form.elements.lastName.value = record.last_name || '';
    form.elements.phone.value = record.phone || '';
    form.elements.email.value = record.email || '';
    form.elements.gender.value = record.gender || '';
    form.elements.dateOfBirth.value = record.date_of_birth || '';
    form.elements.occupation.value = record.occupation || '';
    form.elements.address.value = record.address || '';
    form.elements.city.value = record.city || '';
    form.elements.state.value = record.state || '';
    form.elements.nextOfKinName.value = record.next_of_kin_name || '';
    form.elements.nextOfKinPhone.value = record.next_of_kin_phone || '';
    form.elements.status.value = record.status;
  }

  function renderAccounts() {
    accountsBody.replaceChildren();
    const accounts = [...(customer.accounts || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    document.querySelector('#accountCount').textContent = accounts.length;
    document.querySelector('#totalCustomerBalance').textContent = formatCurrencyMinor(
      accounts.reduce(
        (sum, account) => sum + BigInt(String(account.cached_balance_minor || 0)),
        0n,
      ),
    );

    accounts.forEach((account) => {
      const row = document.createElement('tr');

      const numberCell = document.createElement('td');
      const number = document.createElement('strong');
      number.textContent = account.account_number;
      const created = document.createElement('small');
      created.textContent = `Opened ${formatDate(account.created_at)}`;
      numberCell.append(number, created);

      const typeCell = document.createElement('td');
      typeCell.textContent = account.account_type;

      const balanceCell = document.createElement('td');
      balanceCell.textContent = formatCurrencyMinor(account.cached_balance_minor, account.currency);

      const statusCell = document.createElement('td');
      statusCell.append(statusBadge(account.status));

      const actionCell = document.createElement('td');
      if (CAN_MANAGE) {
        const actionWrap = document.createElement('div');
        actionWrap.className = 'account-actions';

        if (account.status === 'active' && customer.status === 'active') {
          const deposit = document.createElement('a');
          deposit.className = 'mini-button approve';
          deposit.href = `./transactions.html?account=${encodeURIComponent(account.id)}&type=deposit`;
          deposit.textContent = 'Deposit';

          const withdrawal = document.createElement('a');
          withdrawal.className = 'mini-button';
          withdrawal.href = `./transactions.html?account=${encodeURIComponent(account.id)}&type=withdrawal`;
          withdrawal.textContent = 'Withdraw';

          const loan = document.createElement('a');
          loan.className = 'mini-button';
          loan.href = `./loans.html?customer=${encodeURIComponent(customer.customer_number)}&account=${encodeURIComponent(account.id)}`;
          loan.textContent = 'Loan';

          const overdraft = document.createElement('a');
          overdraft.className = 'mini-button';
          overdraft.href = `./overdrafts.html?customer=${encodeURIComponent(customer.customer_number)}&account=${encodeURIComponent(account.id)}`;
          overdraft.textContent = 'Overdraft';

          actionWrap.append(deposit, withdrawal, loan, overdraft);
        }

        const select = document.createElement('select');
        select.className = 'compact-select';
        ['active', 'frozen', 'closed'].forEach((status) => {
          const option = document.createElement('option');
          option.value = status;
          option.textContent = status;
          option.selected = status === account.status;
          select.append(option);
        });
        select.addEventListener('change', async () => {
          const previous = account.status;
          select.disabled = true;
          try {
            await updateAccountStatus(account.id, select.value);
            showMessage(`Account ${account.account_number} status updated.`);
            await loadCustomer();
          } catch (error) {
            select.value = previous;
            showMessage(error.message, 'error');
          } finally {
            select.disabled = false;
          }
        });
        actionWrap.append(select);
        actionCell.append(actionWrap);
      } else {
        actionCell.textContent = 'Read only';
      }

      row.append(numberCell, typeCell, balanceCell, statusCell, actionCell);
      accountsBody.append(row);
    });

    document.querySelector('#accountsEmpty').hidden = accounts.length > 0;
  }

  function renderTransactionHistory(transactions) {
    transactionsBody.replaceChildren();
    transactionCount.textContent = String(transactions.length);

    for (const transaction of transactions) {
      const row = document.createElement('tr');

      const referenceCell = document.createElement('td');
      const reference = document.createElement('strong');
      reference.textContent = transaction.reference || '—';
      const initiated = document.createElement('small');
      initiated.textContent = formatDate(transaction.created_at);
      referenceCell.append(reference, initiated);

      const accountCell = document.createElement('td');
      accountCell.textContent = transaction.account_number || '—';

      const typeCell = document.createElement('td');
      typeCell.textContent = transaction.type || '—';

      const amountCell = document.createElement('td');
      amountCell.textContent = formatCurrencyMinor(
        transaction.amount_minor,
        transaction.currency || 'NGN',
      );

      const chargeCell = document.createElement('td');
      chargeCell.textContent = formatCurrencyMinor(
        transaction.charge_minor || 0,
        transaction.currency || 'NGN',
      );

      const netCell = document.createElement('td');
      netCell.textContent = formatCurrencyMinor(
        transaction.net_amount_minor ?? transaction.amount_minor ?? 0,
        transaction.currency || 'NGN',
      );

      const statusCell = document.createElement('td');
      statusCell.append(statusBadge(transaction.status));

      const descriptionCell = document.createElement('td');
      descriptionCell.textContent = transaction.description || '—';

      row.append(
        referenceCell,
        accountCell,
        typeCell,
        amountCell,
        chargeCell,
        netCell,
        statusCell,
        descriptionCell,
      );
      transactionsBody.append(row);
    }

    transactionsEmpty.hidden = transactions.length > 0;
  }

  async function loadTransactionHistory() {
    try {
      const transactions = await getCustomerTransactionHistory(customerId, { limit: 100 });
      renderTransactionHistory(transactions);
    } catch (error) {
      transactionsBody.replaceChildren();
      transactionCount.textContent = '0';
      transactionsEmpty.hidden = false;
      transactionsEmpty.textContent = error.message;
    }
  }

  function renderHeader() {
    document.querySelector('#customerHeading').textContent = fullName(customer);
    document.querySelector('#customerNumber').textContent = customer.customer_number;
    document.querySelector('#customerStatus').replaceChildren(statusBadge(customer.status));
    document.querySelector('#customerCreatedAt').textContent = formatDate(customer.created_at);
  }

  async function loadCustomer() {
    try {
      customer = await getCustomer(customerId);
      fillCustomerForm(customer);
      renderHeader();
      renderAccounts();
      await loadTransactionHistory();
    } catch (error) {
      showMessage(error.message, 'error');
    }
  }

  if (CAN_MANAGE) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = 'Saving...';

      try {
        await updateCustomer({
          customerId,
          firstName: form.elements.firstName.value,
          middleName: form.elements.middleName.value,
          lastName: form.elements.lastName.value,
          phone: form.elements.phone.value,
          email: form.elements.email.value,
          gender: form.elements.gender.value,
          dateOfBirth: form.elements.dateOfBirth.value,
          occupation: form.elements.occupation.value,
          address: form.elements.address.value,
          city: form.elements.city.value,
          state: form.elements.state.value,
          nextOfKinName: form.elements.nextOfKinName.value,
          nextOfKinPhone: form.elements.nextOfKinPhone.value,
          status: form.elements.status.value,
        });
        showMessage('Customer details updated successfully.');
        await loadCustomer();
      } catch (error) {
        showMessage(error.message, 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Save customer';
      }
    });

    document.querySelector('#openCreateAccount').addEventListener('click', () => accountDialog.showModal());
    document.querySelector('#closeCreateAccount').addEventListener('click', () => accountDialog.close());
    document.querySelector('#cancelCreateAccount').addEventListener('click', () => accountDialog.close());

    accountForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = accountForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = 'Creating account...';

      try {
        const account = await createCustomerAccount(customerId, accountForm.elements.accountType.value);
        accountForm.reset();
        accountDialog.close();
        showMessage(`Account ${account.account_number} created successfully.`);
        await loadCustomer();
      } catch (error) {
        showMessage(error.message, 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = 'Create account';
      }
    });
  }

  await loadCustomer();
}
