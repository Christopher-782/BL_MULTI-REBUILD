import {
  bindLogoutButtons,
  bindSessionUI,
  requireActiveProfile,
} from '../auth/access.js';

import {
  approveLoan,
  approveLoanRepayment,
  basisPointsToPercent,
  calculateFlatLoanPreview,
  formatCurrencyMinor,
  getCustomerLoanContext,
  getLoanSummary,
  listLoans,
  listPendingLoanRepayments,
  nairaToMinor,
  rejectLoan,
  rejectLoanRepayment,
  requestLoan,
  requestLoanRepayment,
} from '../services/loans.service.js';

const session =
  await requireActiveProfile();

if (session) {
  bindSessionUI(
    session.profile,
    session.user,
  );

  bindLogoutButtons();

  const CAN_REQUEST =
    [
      'super_admin',
      'admin',
      'manager',
      'staff',
    ].includes(
      session.profile.role,
    );

  const CAN_APPROVE =
    [
      'super_admin',
      'admin',
      'manager',
    ].includes(
      session.profile.role,
    );

  const state = {
    page: 1,
    pageSize: 25,
    count: 0,
    search: '',
    status: 'all',
    loans: [],
    pendingRepayments: [],
    customerContext: null,
    selectedAccount: null,
    selectedLoan: null,
    selectedRepayment: null,
  };

  const message =
    document.querySelector(
      '#pageMessage',
    );

  const tableBody =
    document.querySelector(
      '#loansTableBody',
    );

  const loading =
    document.querySelector(
      '#loansLoading',
    );

  const empty =
    document.querySelector(
      '#loansEmpty',
    );

  const pendingRepaymentsBody =
    document.querySelector(
      '#pendingRepaymentsBody',
    );

  const pendingRepaymentsLoading =
    document.querySelector(
      '#pendingRepaymentsLoading',
    );

  const pendingRepaymentsEmpty =
    document.querySelector(
      '#pendingRepaymentsEmpty',
    );

  const loanDialog =
    document.querySelector(
      '#newLoanDialog',
    );

  const loanForm =
    document.querySelector(
      '#newLoanForm',
    );

  const customerPreview =
    document.querySelector(
      '#loanCustomerPreview',
    );

  const accountSelectWrap =
    document.querySelector(
      '#loanAccountSelectWrap',
    );

  const accountSelect =
    document.querySelector(
      '#loanAccountSelect',
    );

  const accountPreview =
    document.querySelector(
      '#loanAccountPreview',
    );

  function renderPreview(
    container,
    fields,
  ) {
    container.replaceChildren();

    for (const [label, value] of fields) {
      const item = document.createElement('div');
      const caption = document.createElement('span');
      const content = document.createElement('strong');

      caption.textContent = label;
      content.textContent = value ?? '—';
      item.append(caption, content);
      container.append(item);
    }
  }

  const rejectDialog =
    document.querySelector(
      '#rejectLoanDialog',
    );

  const rejectForm =
    document.querySelector(
      '#rejectLoanForm',
    );

  const repaymentDialog =
    document.querySelector(
      '#repaymentDialog',
    );

  const repaymentForm =
    document.querySelector(
      '#repaymentForm',
    );

  const rejectRepaymentDialog =
    document.querySelector(
      '#rejectRepaymentDialog',
    );

  const rejectRepaymentForm =
    document.querySelector(
      '#rejectRepaymentForm',
    );

  if (!CAN_REQUEST) {
    document
      .querySelectorAll(
        '[data-loan-request]',
      )
      .forEach((element) => {
        element.hidden = true;
      });
  }

  function showMessage(
    text,
    type = 'success',
  ) {
    message.textContent =
      text;

    message.dataset.type =
      type;

    message.hidden =
      false;

    window.clearTimeout(
      showMessage.timer,
    );

    showMessage.timer =
      window.setTimeout(
        () => {
          message.hidden =
            true;
        },
        7000,
      );
  }

  function formatDate(
    value,
    withTime = false,
  ) {
    if (!value) return '—';

    const date =
      new Date(value);

    if (
      Number.isNaN(
        date.getTime(),
      )
    ) {
      return '—';
    }

    return new Intl.DateTimeFormat(
      'en-NG',
      withTime
        ? {
            dateStyle: 'medium',
            timeStyle: 'short',
          }
        : {
            dateStyle: 'medium',
          },
    ).format(date);
  }

  function customerName(
    customer,
  ) {
    return [
      customer?.first_name,
      customer?.middle_name,
      customer?.last_name,
    ]
      .filter(Boolean)
      .join(' ');
  }

  function statusBadge(
    status,
    overdue = false,
  ) {
    const badge =
      document.createElement(
        'span',
      );

    badge.className =
      'state-badge';

    badge.dataset.status =
      overdue
        ? 'overdue'
        : status;

    badge.textContent =
      overdue
        ? 'overdue'
        : status;

    return badge;
  }

  function resetLoanCustomer() {
    state.customerContext =
      null;

    state.selectedAccount =
      null;

    customerPreview.hidden =
      true;

    customerPreview
      .replaceChildren();

    accountSelectWrap.hidden =
      true;

    accountSelect
      .replaceChildren();

    accountPreview.hidden =
      true;

    accountPreview
      .replaceChildren();
  }

  function renderSelectedAccount(
    account,
  ) {
    state.selectedAccount =
      account;

    if (!account) {
      accountPreview.hidden =
        true;

      accountPreview
        .replaceChildren();

      return;
    }

    renderPreview(
      accountPreview,
      [
        ['Account number', account.account_number],
        ['Account type', account.account_type],
        [
          'Current balance',
          formatCurrencyMinor(
            account.cached_balance_minor,
            account.currency,
          ),
        ],
        ['Status', account.status],
      ],
    );

    accountPreview.hidden =
      false;
  }

  function renderCustomerContext(
    context,
    preferredAccountId = null,
  ) {
    state.customerContext =
      context;

    const customer =
      context?.customer;

    const accounts =
      Array.isArray(
        context?.accounts,
      )
        ? context.accounts
        : [];

    if (!customer) {
      resetLoanCustomer();
      return;
    }

    renderPreview(
      customerPreview,
      [
        ['Customer', customerName(customer) || '—'],
        ['Customer number', customer.customer_number || '—'],
        ['Phone', customer.phone || '—'],
        ['Status', customer.status || '—'],
      ],
    );

    customerPreview.hidden =
      false;

    accountSelect
      .replaceChildren();

    const activeAccounts =
      accounts.filter(
        (account) =>
          account.status === 'active',
      );

    if (!activeAccounts.length) {
      const option =
        document.createElement(
          'option',
        );

      option.value = '';

      option.textContent =
        'No active accounts';

      accountSelect.append(
        option,
      );

      accountSelect.disabled =
        true;

      accountSelectWrap.hidden =
        false;

      renderSelectedAccount(
        null,
      );

      return;
    }

    accountSelect.disabled =
      false;

    for (
      const account
      of activeAccounts
    ) {
      const option =
        document.createElement(
          'option',
        );

      option.value =
        account.id;

      option.textContent =
        `${account.account_number} · ${account.account_type}`;

      accountSelect.append(
        option,
      );
    }

    accountSelectWrap.hidden =
      false;

    const selected =
      activeAccounts.find(
        (account) =>
          account.id ===
          preferredAccountId,
      ) ??
      activeAccounts[0];

    accountSelect.value =
      selected.id;

    renderSelectedAccount(
      selected,
    );
  }

  async function resolveCustomer(
    preferredAccountId = null,
  ) {
    const customerNumber =
      loanForm.elements
        .customerNumber
        .value
        .trim();

    if (!customerNumber) {
      resetLoanCustomer();
      return null;
    }

    const button =
      document.querySelector(
        '#lookupLoanCustomer',
      );

    button.disabled =
      true;

    button.textContent =
      'Checking...';

    try {
      const context =
        await getCustomerLoanContext(
          customerNumber,
        );

      renderCustomerContext(
        context,
        preferredAccountId,
      );

      return context;
    } catch (error) {
      resetLoanCustomer();

      showMessage(
        error.message,
        'error',
      );

      return null;
    } finally {
      button.disabled =
        false;

      button.textContent =
        'Find customer';
    }
  }

  function updateLoanPreview() {
    const principalValue =
      loanForm.elements
        .principal.value;

    const interestValue =
      loanForm.elements
        .interestRate.value;

    try {
      const principalMinor =
        BigInt(
          nairaToMinor(
            principalValue || '0',
            {
              allowZero: true,
            },
          ),
        );

      if (
        principalMinor <= 0n
      ) {
        throw new Error();
      }

      const normalizedRate =
        String(
          interestValue || '0',
        ).trim();

      if (
        !/^\d+(?:\.\d{1,2})?$/.test(
          normalizedRate,
        )
      ) {
        throw new Error();
      }

      const [
        whole,
        fraction = '',
      ] =
        normalizedRate.split('.');

      const bps =
        Number(
          (BigInt(whole) * 100n) +
          BigInt(
            fraction.padEnd(
              2,
              '0',
            ),
          ),
        );

      const preview =
        calculateFlatLoanPreview(
          principalMinor.toString(),
          bps,
        );

      document.querySelector(
        '#loanInterestPreview',
      ).value =
        formatCurrencyMinor(
          preview.interestMinor,
        );

      document.querySelector(
        '#loanTotalPreview',
      ).value =
        formatCurrencyMinor(
          preview.totalMinor,
        );
    } catch {
      document.querySelector(
        '#loanInterestPreview',
      ).value = '';

      document.querySelector(
        '#loanTotalPreview',
      ).value = '';
    }
  }

  function canReviewLoan(
    loan,
  ) {
    return Boolean(
      CAN_APPROVE &&
      loan.status === 'pending' &&
      loan.requested_by !==
        session.user.id,
    );
  }

  function renderLoanActions(
    loan,
  ) {
    const wrap =
      document.createElement(
        'div',
      );

    wrap.className =
      'transaction-actions';

    const view =
      document.createElement(
        'a',
      );

    view.className =
      'mini-button';

    view.href =
      `./loan.html?id=${encodeURIComponent(loan.id)}`;

    view.textContent =
      'View';

    wrap.append(view);

    if (
      canReviewLoan(loan)
    ) {
      const approve =
        document.createElement(
          'button',
        );

      approve.type =
        'button';

      approve.className =
        'mini-button approve';

      approve.textContent =
        'Approve';

      approve.addEventListener(
        'click',
        async () => {
          if (
            !window.confirm(
              `Approve ${loan.loan_number}? ${formatCurrencyMinor(
                loan.principal_minor,
                loan.currency,
              )} will be credited to account ${loan.account_number}.`,
            )
          ) {
            return;
          }

          approve.disabled =
            true;

          try {
            await approveLoan(
              loan.id,
            );

            showMessage(
              `${loan.loan_number} approved and disbursed.`,
            );

            await refreshAll();
          } catch (error) {
            showMessage(
              error.message,
              'error',
            );
          } finally {
            approve.disabled =
              false;
          }
        },
      );

      const reject =
        document.createElement(
          'button',
        );

      reject.type =
        'button';

      reject.className =
        'mini-button danger';

      reject.textContent =
        'Reject';

      reject.addEventListener(
        'click',
        () => {
          state.selectedLoan =
            loan;

          rejectForm.reset();

          document.querySelector(
            '#rejectLoanNumber',
          ).textContent =
            loan.loan_number;

          rejectDialog.showModal();
        },
      );

      wrap.append(
        approve,
        reject,
      );
    }

    if (
      CAN_REQUEST &&
      loan.status === 'active'
    ) {
      const repayment =
        document.createElement(
          'button',
        );

      repayment.type =
        'button';

      repayment.className =
        'mini-button';

      repayment.textContent =
        'Record repayment';

      repayment.addEventListener(
        'click',
        () => {
          state.selectedLoan =
            loan;

          repaymentForm.reset();

          document.querySelector(
            '#repaymentLoanNumber',
          ).textContent =
            loan.loan_number;

          document.querySelector(
            '#repaymentOutstanding',
          ).textContent =
            formatCurrencyMinor(
              loan.outstanding_minor,
              loan.currency,
            );

          repaymentDialog.showModal();
        },
      );

      wrap.append(
        repayment,
      );
    }

    if (
      loan.status === 'pending' &&
      loan.requested_by ===
        session.user.id
    ) {
      const note =
        document.createElement(
          'small',
        );

      note.className =
        'maker-note';

      note.textContent =
        'Awaiting another approver';

      wrap.append(note);
    }

    return wrap;
  }

  function renderLoans() {
    tableBody.replaceChildren();

    for (
      const loan
      of state.loans
    ) {
      const row =
        document.createElement(
          'tr',
        );

      const number =
        document.createElement(
          'td',
        );

      const numberStrong =
        document.createElement(
          'strong',
        );

      numberStrong.textContent =
        loan.loan_number;

      const numberSmall =
        document.createElement(
          'small',
        );

      numberSmall.textContent =
        `Requested ${formatDate(
          loan.requested_at,
          true,
        )}`;

      number.append(
        numberStrong,
        numberSmall,
      );

      const customer =
        document.createElement(
          'td',
        );

      const customerStrong =
        document.createElement(
          'strong',
        );

      customerStrong.textContent =
        loan.customer_name;

      const customerSmall =
        document.createElement(
          'small',
        );

      customerSmall.textContent =
        `Customer ${loan.customer_number} · ${loan.account_number}`;

      customer.append(
        customerStrong,
        customerSmall,
      );

      const terms =
        document.createElement(
          'td',
        );

      const principal =
        document.createElement(
          'strong',
        );

      principal.textContent =
        formatCurrencyMinor(
          loan.principal_minor,
          loan.currency,
        );

      const interest =
        document.createElement(
          'small',
        );

      interest.textContent =
        `${basisPointsToPercent(
          loan.interest_rate_bps,
        )}% flat · Interest ${formatCurrencyMinor(
          loan.interest_minor,
          loan.currency,
        )}`;

      terms.append(
        principal,
        interest,
      );

      const outstanding =
        document.createElement(
          'td',
        );

      outstanding.className =
        'money-cell';

      outstanding.textContent =
        formatCurrencyMinor(
          loan.outstanding_minor,
          loan.currency,
        );

      const term =
        document.createElement(
          'td',
        );

      const termStrong =
        document.createElement(
          'strong',
        );

      termStrong.textContent =
        `${loan.term_months} month${loan.term_months === 1 ? '' : 's'}`;

      const due =
        document.createElement(
          'small',
        );

      due.textContent =
        loan.due_date
          ? `Due ${formatDate(
              loan.due_date,
            )}`
          : 'Due after approval';

      term.append(
        termStrong,
        due,
      );

      const status =
        document.createElement(
          'td',
        );

      status.append(
        statusBadge(
          loan.status,
          loan.overdue,
        ),
      );

      if (
        loan.rejection_reason
      ) {
        const reason =
          document.createElement(
            'small',
          );

        reason.textContent =
          loan.rejection_reason;

        status.append(reason);
      }

      const actions =
        document.createElement(
          'td',
        );

      actions.append(
        renderLoanActions(
          loan,
        ),
      );

      row.append(
        number,
        customer,
        terms,
        outstanding,
        term,
        status,
        actions,
      );

      tableBody.append(row);
    }

    empty.hidden =
      state.loans.length > 0;

    const from =
      state.count === 0
        ? 0
        : (
            (state.page - 1) *
            state.pageSize
          ) + 1;

    const to =
      Math.min(
        state.page *
          state.pageSize,
        state.count,
      );

    document.querySelector(
      '#paginationText',
    ).textContent =
      `${from}–${to} of ${state.count}`;

    document.querySelector(
      '#prevPage',
    ).disabled =
      state.page <= 1;

    document.querySelector(
      '#nextPage',
    ).disabled =
      to >= state.count;
  }

  function canReviewRepayment(
    repayment,
  ) {
    return Boolean(
      CAN_APPROVE &&
      repayment.status === 'pending' &&
      repayment.requested_by !==
        session.user.id,
    );
  }

  function renderPendingRepayments() {
    pendingRepaymentsBody
      .replaceChildren();

    for (
      const repayment
      of state.pendingRepayments
    ) {
      const row =
        document.createElement(
          'tr',
        );

      const number =
        document.createElement(
          'td',
        );

      const strong =
        document.createElement(
          'strong',
        );

      strong.textContent =
        repayment.repayment_number;

      const date =
        document.createElement(
          'small',
        );

      date.textContent =
        formatDate(
          repayment.requested_at,
          true,
        );

      number.append(
        strong,
        date,
      );

      const loan =
        document.createElement(
          'td',
        );

      const loanStrong =
        document.createElement(
          'strong',
        );

      loanStrong.textContent =
        repayment.loan_number;

      const loanSmall =
        document.createElement(
          'small',
        );

      loanSmall.textContent =
        `${repayment.customer_name} · Customer ${repayment.customer_number}`;

      loan.append(
        loanStrong,
        loanSmall,
      );

      const amount =
        document.createElement(
          'td',
        );

      amount.className =
        'money-cell';

      amount.textContent =
        formatCurrencyMinor(
          repayment.amount_minor,
        );

      const method =
        document.createElement(
          'td',
        );

      const methodStrong =
        document.createElement(
          'strong',
        );

      methodStrong.textContent =
        repayment.payment_method;

      const reference =
        document.createElement(
          'small',
        );

      reference.textContent =
        repayment.external_reference ||
        'No external reference';

      method.append(
        methodStrong,
        reference,
      );

      const maker =
        document.createElement(
          'td',
        );

      maker.textContent =
        repayment.requested_by_name ||
        '—';

      const actions =
        document.createElement(
          'td',
        );

      const wrap =
        document.createElement(
          'div',
        );

      wrap.className =
        'transaction-actions';

      if (
        canReviewRepayment(
          repayment,
        )
      ) {
        const approve =
          document.createElement(
            'button',
          );

        approve.type =
          'button';

        approve.className =
          'mini-button approve';

        approve.textContent =
          'Approve';

        approve.addEventListener(
          'click',
          async () => {
            if (
              !window.confirm(
                `Approve ${repayment.repayment_number} for ${formatCurrencyMinor(repayment.amount_minor)}?`,
              )
            ) {
              return;
            }

            approve.disabled =
              true;

            try {
              await approveLoanRepayment(
                repayment.id,
              );

              showMessage(
                `${repayment.repayment_number} approved.`,
              );

              await refreshAll();
            } catch (error) {
              showMessage(
                error.message,
                'error',
              );
            } finally {
              approve.disabled =
                false;
            }
          },
        );

        const reject =
          document.createElement(
            'button',
          );

        reject.type =
          'button';

        reject.className =
          'mini-button danger';

        reject.textContent =
          'Reject';

        reject.addEventListener(
          'click',
          () => {
            state.selectedRepayment =
              repayment;

            rejectRepaymentForm.reset();

            document.querySelector(
              '#rejectRepaymentNumber',
            ).textContent =
              repayment.repayment_number;

            rejectRepaymentDialog
              .showModal();
          },
        );

        wrap.append(
          approve,
          reject,
        );
      } else {
        const note =
          document.createElement(
            'small',
          );

        note.className =
          'maker-note';

        note.textContent =
          repayment.requested_by ===
            session.user.id
            ? 'Awaiting another approver'
            : 'Read only';

        wrap.append(note);
      }

      actions.append(wrap);

      row.append(
        number,
        loan,
        amount,
        method,
        maker,
        actions,
      );

      pendingRepaymentsBody
        .append(row);
    }

    pendingRepaymentsEmpty.hidden =
      state.pendingRepayments.length > 0;
  }

  async function loadPendingRepayments() {
    pendingRepaymentsLoading.hidden =
      false;

    try {
      state.pendingRepayments =
        await listPendingLoanRepayments();

      renderPendingRepayments();
    } catch (error) {
      showMessage(
        error.message,
        'error',
      );
    } finally {
      pendingRepaymentsLoading.hidden =
        true;
    }
  }

  async function loadLoans() {
    loading.hidden =
      false;

    try {
      const result =
        await listLoans(
          state,
        );

      state.loans =
        result.loans;

      state.count =
        result.count;

      renderLoans();
    } catch (error) {
      showMessage(
        error.message,
        'error',
      );
    } finally {
      loading.hidden =
        true;
    }
  }

  async function loadSummary() {
    try {
      const summary =
        await getLoanSummary();

      document.querySelector(
        '#pendingLoanCount',
      ).textContent =
        summary.pending_loans ?? 0;

      document.querySelector(
        '#activeLoanCount',
      ).textContent =
        summary.active_loans ?? 0;

      document.querySelector(
        '#loanOutstanding',
      ).textContent =
        formatCurrencyMinor(
          summary.outstanding_minor ?? 0,
        );

      document.querySelector(
        '#repaymentsToday',
      ).textContent =
        formatCurrencyMinor(
          summary.repayments_today_minor ?? 0,
        );

      document.querySelector(
        '#overdueLoanCount',
      ).textContent =
        summary.overdue_loans ?? 0;
    } catch (error) {
      showMessage(
        error.message,
        'error',
      );
    }
  }

  async function refreshAll() {
    await Promise.all([
      loadLoans(),
      loadSummary(),
      loadPendingRepayments(),
    ]);
  }

  document
    .querySelector(
      '#loanFilterForm',
    )
    .addEventListener(
      'submit',
      async (event) => {
        event.preventDefault();

        const form =
          event.currentTarget;

        state.page = 1;

        state.search =
          form.elements
            .search
            .value;

        state.status =
          form.elements
            .status
            .value;

        await loadLoans();
      },
    );

  document
    .querySelector(
      '#clearLoanFilters',
    )
    .addEventListener(
      'click',
      async () => {
        const form =
          document.querySelector(
            '#loanFilterForm',
          );

        form.reset();

        state.page = 1;
        state.search = '';
        state.status = 'all';

        await loadLoans();
      },
    );

  document
    .querySelector(
      '#refreshLoans',
    )
    .addEventListener(
      'click',
      refreshAll,
    );

  document
    .querySelector(
      '#prevPage',
    )
    .addEventListener(
      'click',
      async () => {
        if (
          state.page > 1
        ) {
          state.page -= 1;
          await loadLoans();
        }
      },
    );

  document
    .querySelector(
      '#nextPage',
    )
    .addEventListener(
      'click',
      async () => {
        if (
          state.page *
            state.pageSize <
          state.count
        ) {
          state.page += 1;
          await loadLoans();
        }
      },
    );

  if (CAN_REQUEST) {
    document
      .querySelector(
        '#openNewLoan',
      )
      .addEventListener(
        'click',
        () => {
          loanForm.reset();
          resetLoanCustomer();
          updateLoanPreview();
          loanDialog.showModal();
        },
      );

    document
      .querySelector(
        '#lookupLoanCustomer',
      )
      .addEventListener(
        'click',
        () => resolveCustomer(),
      );

    loanForm.elements
      .customerNumber
      .addEventListener(
        'change',
        () => resolveCustomer(),
      );

    accountSelect
      .addEventListener(
        'change',
        () => {
          const account =
            state.customerContext
              ?.accounts
              ?.find(
                (item) =>
                  item.id ===
                  accountSelect.value,
              ) ?? null;

          renderSelectedAccount(
            account,
          );
        },
      );

    loanForm.elements
      .principal
      .addEventListener(
        'input',
        updateLoanPreview,
      );

    loanForm.elements
      .interestRate
      .addEventListener(
        'input',
        updateLoanPreview,
      );

    loanForm.addEventListener(
      'submit',
      async (event) => {
        event.preventDefault();

        if (
          !state.customerContext
        ) {
          const context =
            await resolveCustomer();

          if (!context) return;
        }

        const account =
          state.selectedAccount;

        if (!account) {
          showMessage(
            'Select an active customer account.',
            'error',
          );

          return;
        }

        const submit =
          loanForm.querySelector(
            'button[type="submit"]',
          );

        submit.disabled =
          true;

        submit.textContent =
          'Submitting...';

        try {
          const loan =
            await requestLoan({
              accountId:
                account.id,
              principal:
                loanForm.elements
                  .principal
                  .value,
              interestRate:
                loanForm.elements
                  .interestRate
                  .value,
              termMonths:
                loanForm.elements
                  .termMonths
                  .value,
              purpose:
                loanForm.elements
                  .purpose
                  .value,
            });

          loanDialog.close();

          showMessage(
            `${loan.loan_number} submitted for approval.`,
          );

          await refreshAll();
        } catch (error) {
          showMessage(
            error.message,
            'error',
          );
        } finally {
          submit.disabled =
            false;

          submit.textContent =
            'Submit loan application';
        }
      },
    );
  }

  document
    .querySelector(
      '#closeNewLoan',
    )
    .addEventListener(
      'click',
      () =>
        loanDialog.close(),
    );

  document
    .querySelector(
      '#cancelNewLoan',
    )
    .addEventListener(
      'click',
      () =>
        loanDialog.close(),
    );

  document
    .querySelector(
      '#closeRejectLoan',
    )
    .addEventListener(
      'click',
      () =>
        rejectDialog.close(),
    );

  document
    .querySelector(
      '#cancelRejectLoan',
    )
    .addEventListener(
      'click',
      () =>
        rejectDialog.close(),
    );

  rejectForm.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      if (
        !state.selectedLoan
      ) {
        return;
      }

      const submit =
        rejectForm.querySelector(
          'button[type="submit"]',
        );

      submit.disabled =
        true;

      try {
        await rejectLoan(
          state.selectedLoan.id,
          rejectForm.elements
            .reason
            .value,
        );

        rejectDialog.close();

        showMessage(
          `${state.selectedLoan.loan_number} rejected.`,
        );

        await refreshAll();
      } catch (error) {
        showMessage(
          error.message,
          'error',
        );
      } finally {
        submit.disabled =
          false;
      }
    },
  );

  document
    .querySelector(
      '#closeRepayment',
    )
    .addEventListener(
      'click',
      () =>
        repaymentDialog.close(),
    );

  document
    .querySelector(
      '#cancelRepayment',
    )
    .addEventListener(
      'click',
      () =>
        repaymentDialog.close(),
    );

  repaymentForm.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      if (
        !state.selectedLoan
      ) {
        return;
      }

      const submit =
        repaymentForm.querySelector(
          'button[type="submit"]',
        );

      submit.disabled =
        true;

      try {
        const repayment =
          await requestLoanRepayment({
            loanId:
              state.selectedLoan.id,
            amount:
              repaymentForm.elements
                .amount
                .value,
            paymentMethod:
              repaymentForm.elements
                .paymentMethod
                .value,
            externalReference:
              repaymentForm.elements
                .externalReference
                .value,
            notes:
              repaymentForm.elements
                .notes
                .value,
          });

        repaymentDialog.close();

        showMessage(
          `${repayment.repayment_number} submitted for repayment approval.`,
        );

        await refreshAll();
      } catch (error) {
        showMessage(
          error.message,
          'error',
        );
      } finally {
        submit.disabled =
          false;
      }
    },
  );

  document
    .querySelector(
      '#closeRejectRepayment',
    )
    .addEventListener(
      'click',
      () =>
        rejectRepaymentDialog.close(),
    );

  document
    .querySelector(
      '#cancelRejectRepayment',
    )
    .addEventListener(
      'click',
      () =>
        rejectRepaymentDialog.close(),
    );

  rejectRepaymentForm.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      if (
        !state.selectedRepayment
      ) {
        return;
      }

      const submit =
        rejectRepaymentForm.querySelector(
          'button[type="submit"]',
        );

      submit.disabled =
        true;

      try {
        await rejectLoanRepayment(
          state.selectedRepayment.id,
          rejectRepaymentForm.elements
            .reason
            .value,
        );

        rejectRepaymentDialog.close();

        showMessage(
          `${state.selectedRepayment.repayment_number} rejected.`,
        );

        await refreshAll();
      } catch (error) {
        showMessage(
          error.message,
          'error',
        );
      } finally {
        submit.disabled =
          false;
      }
    },
  );

  // Deep-link from customer account.
  const params =
    new URLSearchParams(
      window.location.search,
    );

  const prefillCustomer =
    params.get('customer');

  const prefillAccount =
    params.get('account');

  if (
    CAN_REQUEST &&
    prefillCustomer
  ) {
    loanForm.reset();

    loanForm.elements
      .customerNumber
      .value =
      prefillCustomer;

    await resolveCustomer(
      prefillAccount,
    );

    loanDialog.showModal();

    window.history.replaceState(
      {},
      '',
      './loans.html',
    );
  }

  await refreshAll();
}
