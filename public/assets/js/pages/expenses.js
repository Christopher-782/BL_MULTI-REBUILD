import {
  bindLogoutButtons,
  bindSessionUI,
  requireActiveProfile,
} from '../auth/access.js';

import {
  approveExpense,
  formatCurrencyMinor,
  getExpenseSummary,
  listExpenses,
  rejectExpense,
  requestExpense,
} from '../services/expenses.service.js';

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
    category: 'all',
    expenses: [],
    selectedExpense: null,
  };

  const message =
    document.querySelector(
      '#pageMessage',
    );

  const tableBody =
    document.querySelector(
      '#expenseTableBody',
    );

  const loading =
    document.querySelector(
      '#expenseLoading',
    );

  const empty =
    document.querySelector(
      '#expenseEmpty',
    );

  const newDialog =
    document.querySelector(
      '#newExpenseDialog',
    );

  const newForm =
    document.querySelector(
      '#newExpenseForm',
    );

  const rejectDialog =
    document.querySelector(
      '#rejectExpenseDialog',
    );

  const rejectForm =
    document.querySelector(
      '#rejectExpenseForm',
    );

  if (!CAN_REQUEST) {
    document
      .querySelectorAll(
        '[data-expense-request]',
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
      new Date(
        String(value).length === 10
          ? `${value}T00:00:00`
          : value,
      );

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

  function statusBadge(
    status,
  ) {
    const badge =
      document.createElement(
        'span',
      );

    badge.className =
      'state-badge';

    badge.dataset.status =
      status;

    badge.textContent =
      status;

    return badge;
  }

  function canReview(
    expense,
  ) {
    return Boolean(
      CAN_APPROVE &&
      expense.status ===
        'pending' &&
      expense.requested_by !==
        session.user.id,
    );
  }

  function renderActions(
    expense,
  ) {
    const wrap =
      document.createElement(
        'div',
      );

    wrap.className =
      'transaction-actions';

    if (
      canReview(
        expense,
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
              `Approve ${expense.expense_number} for ${formatCurrencyMinor(expense.amount_minor)}?`,
            )
          ) {
            return;
          }

          approve.disabled =
            true;

          try {
            await approveExpense(
              expense.id,
            );

            showMessage(
              `${expense.expense_number} approved.`,
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
          state.selectedExpense =
            expense;

          rejectForm.reset();

          document.querySelector(
            '#rejectExpenseNumber',
          ).textContent =
            expense.expense_number;

          rejectDialog.showModal();
        },
      );

      wrap.append(
        approve,
        reject,
      );
    }

    if (
      expense.status ===
        'pending' &&
      expense.requested_by ===
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

    if (
      !wrap.childNodes.length
    ) {
      const dash =
        document.createElement(
          'span',
        );

      dash.className =
        'muted-copy';

      dash.textContent =
        '—';

      wrap.append(dash);
    }

    return wrap;
  }

  function renderExpenses() {
    tableBody.replaceChildren();

    for (
      const expense
      of state.expenses
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
        expense.expense_number;

      const numberSmall =
        document.createElement(
          'small',
        );

      numberSmall.textContent =
        formatDate(
          expense.expense_date,
        );

      number.append(
        numberStrong,
        numberSmall,
      );

      const category =
        document.createElement(
          'td',
        );

      const categoryStrong =
        document.createElement(
          'strong',
        );

      categoryStrong.textContent =
        expense.category;

      const description =
        document.createElement(
          'small',
        );

      description.textContent =
        expense.description;

      category.append(
        categoryStrong,
        description,
      );

      const amount =
        document.createElement(
          'td',
        );

      amount.className =
        'money-cell';

      amount.textContent =
        formatCurrencyMinor(
          expense.amount_minor,
        );

      const payment =
        document.createElement(
          'td',
        );

      const method =
        document.createElement(
          'strong',
        );

      method.textContent =
        expense.payment_method;

      const reference =
        document.createElement(
          'small',
        );

      reference.textContent =
        expense.external_reference ||
        'No reference';

      payment.append(
        method,
        reference,
      );

      const people =
        document.createElement(
          'td',
        );

      const maker =
        document.createElement(
          'strong',
        );

      maker.textContent =
        expense.requested_by_name ||
        '—';

      const checker =
        document.createElement(
          'small',
        );

      checker.textContent =
        expense.approved_by_name
          ? `Approved by ${expense.approved_by_name}`
          : expense.rejected_by_name
            ? `Rejected by ${expense.rejected_by_name}`
            : 'Not reviewed';

      people.append(
        maker,
        checker,
      );

      const status =
        document.createElement(
          'td',
        );

      status.append(
        statusBadge(
          expense.status,
        ),
      );

      if (
        expense.rejection_reason
      ) {
        const reason =
          document.createElement(
            'small',
          );

        reason.textContent =
          expense.rejection_reason;

        status.append(reason);
      }

      const actions =
        document.createElement(
          'td',
        );

      actions.append(
        renderActions(
          expense,
        ),
      );

      row.append(
        number,
        category,
        amount,
        payment,
        people,
        status,
        actions,
      );

      tableBody.append(row);
    }

    empty.hidden =
      state.expenses.length >
      0;

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

  async function loadExpenses() {
    loading.hidden =
      false;

    try {
      const result =
        await listExpenses(
          state,
        );

      state.expenses =
        result.expenses;

      state.count =
        result.count;

      renderExpenses();
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
        await getExpenseSummary();

      document.querySelector(
        '#pendingExpenseCount',
      ).textContent =
        summary.pending_count ?? 0;

      document.querySelector(
        '#expenseToday',
      ).textContent =
        formatCurrencyMinor(
          summary.today_minor ?? 0,
        );

      document.querySelector(
        '#expenseMonth',
      ).textContent =
        formatCurrencyMinor(
          summary.month_minor ?? 0,
        );

      document.querySelector(
        '#approvedExpenseCount',
      ).textContent =
        summary.approved_count ?? 0;
    } catch (error) {
      showMessage(
        error.message,
        'error',
      );
    }
  }

  async function refreshAll() {
    await Promise.all([
      loadExpenses(),
      loadSummary(),
    ]);
  }

  document
    .querySelector(
      '#expenseFilterForm',
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

        state.category =
          form.elements
            .category
            .value;

        await loadExpenses();
      },
    );

  document
    .querySelector(
      '#clearExpenseFilters',
    )
    .addEventListener(
      'click',
      async () => {
        const form =
          document.querySelector(
            '#expenseFilterForm',
          );

        form.reset();

        state.page = 1;
        state.search = '';
        state.status = 'all';
        state.category = 'all';

        await loadExpenses();
      },
    );

  document
    .querySelector(
      '#refreshExpenses',
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

          await loadExpenses();
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

          await loadExpenses();
        }
      },
    );

  if (CAN_REQUEST) {
    document
      .querySelector(
        '#openNewExpense',
      )
      .addEventListener(
        'click',
        () => {
          newForm.reset();

          newForm.elements
            .expenseDate
            .value =
            new Date()
              .toISOString()
              .slice(0, 10);

          newDialog.showModal();
        },
      );

    newForm.addEventListener(
      'submit',
      async (event) => {
        event.preventDefault();

        const submit =
          newForm.querySelector(
            'button[type="submit"]',
          );

        submit.disabled =
          true;

        submit.textContent =
          'Submitting...';

        try {
          const expense =
            await requestExpense({
              expenseDate:
                newForm.elements
                  .expenseDate
                  .value,

              category:
                newForm.elements
                  .category
                  .value,

              description:
                newForm.elements
                  .description
                  .value,

              amount:
                newForm.elements
                  .amount
                  .value,

              paymentMethod:
                newForm.elements
                  .paymentMethod
                  .value,

              externalReference:
                newForm.elements
                  .externalReference
                  .value,
            });

          newDialog.close();

          showMessage(
            `${expense.expense_number} submitted for approval.`,
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
            'Submit expense';
        }
      },
    );
  }

  document
    .querySelector(
      '#closeNewExpense',
    )
    .addEventListener(
      'click',
      () =>
        newDialog.close(),
    );

  document
    .querySelector(
      '#cancelNewExpense',
    )
    .addEventListener(
      'click',
      () =>
        newDialog.close(),
    );

  document
    .querySelector(
      '#closeRejectExpense',
    )
    .addEventListener(
      'click',
      () =>
        rejectDialog.close(),
    );

  document
    .querySelector(
      '#cancelRejectExpense',
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
        !state.selectedExpense
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
        await rejectExpense(
          state.selectedExpense.id,
          rejectForm.elements
            .reason
            .value,
        );

        rejectDialog.close();

        showMessage(
          `${state.selectedExpense.expense_number} rejected.`,
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

  await refreshAll();
}
