import {
  bindLogoutButtons,
  bindSessionUI,
  requireActiveProfile,
} from '../auth/access.js';

import {
  approveOverdraft,
  closeOverdraft,
  formatCurrencyMinor,
  getCustomerOverdraftContext,
  getOverdraftSummary,
  listOverdrafts,
  nairaToMinor,
  rejectOverdraft,
  requestOverdraft,
} from '../services/overdrafts.service.js';

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
    overdrafts: [],
    customerContext: null,
    selectedAccount: null,
    selectedOverdraft: null,
  };

  const message =
    document.querySelector(
      '#pageMessage',
    );

  const tableBody =
    document.querySelector(
      '#overdraftTableBody',
    );

  const loading =
    document.querySelector(
      '#overdraftLoading',
    );

  const empty =
    document.querySelector(
      '#overdraftEmpty',
    );

  const newDialog =
    document.querySelector(
      '#newOverdraftDialog',
    );

  const newForm =
    document.querySelector(
      '#newOverdraftForm',
    );

  const customerPreview =
    document.querySelector(
      '#overdraftCustomerPreview',
    );

  const accountSelectWrap =
    document.querySelector(
      '#overdraftAccountSelectWrap',
    );

  const accountSelect =
    document.querySelector(
      '#overdraftAccountSelect',
    );

  const accountPreview =
    document.querySelector(
      '#overdraftAccountPreview',
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

  const projectedBalance =
    document.querySelector(
      '#projectedBalance',
    );

  const projectedExposure =
    document.querySelector(
      '#projectedExposure',
    );

  const chargeNote =
    document.querySelector(
      '#overdraftChargeNote',
    );

  const rejectDialog =
    document.querySelector(
      '#rejectOverdraftDialog',
    );

  const rejectForm =
    document.querySelector(
      '#rejectOverdraftForm',
    );

  const closeDialog =
    document.querySelector(
      '#closeOverdraftDialog',
    );

  const closeForm =
    document.querySelector(
      '#closeOverdraftForm',
    );

  if (!CAN_REQUEST) {
    document
      .querySelectorAll(
        '[data-overdraft-request]',
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

  function resetCustomer() {
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

    projectedBalance.value =
      '';

    projectedExposure.value =
      '';
  }

  function updateProjection() {
    const account =
      state.selectedAccount;

    if (!account) {
      projectedBalance.value =
        '';

      projectedExposure.value =
        '';

      return;
    }

    try {
      const current =
        BigInt(
          String(
            account.cached_balance_minor ??
            0,
          ),
        );

      const requested =
        BigInt(
          nairaToMinor(
            newForm.elements
              .requestedAmount
              .value || '0',
            {
              allowZero: true,
            },
          ),
        );

      const projected =
        current -
        requested;

      const exposure =
        projected < 0n
          ? -projected
          : 0n;

      projectedBalance.value =
        formatCurrencyMinor(
          projected.toString(),
          account.currency,
        );

      projectedExposure.value =
        formatCurrencyMinor(
          exposure.toString(),
          account.currency,
        );

      if (
        requested > 0n &&
        projected >= 0n
      ) {
        chargeNote.dataset.type =
          'warning';

        chargeNote.textContent =
          'This payout does not create a negative balance. It should be processed as a normal withdrawal, not an overdraft.';

        chargeNote.hidden =
          false;
      } else {
        chargeNote.dataset.type =
          'info';

        chargeNote.textContent =
          'The manual charge is recorded separately as overdraft revenue. It does not change the projected account balance and does not reduce the payout.';

        chargeNote.hidden =
          false;
      }
    } catch {
      projectedBalance.value =
        '';

      projectedExposure.value =
        '';
    }
  }

  function renderAccount(
    account,
  ) {
    state.selectedAccount =
      account;

    if (!account) {
      accountPreview.hidden =
        true;

      accountPreview
        .replaceChildren();

      updateProjection();
      return;
    }

    renderPreview(
      accountPreview,
      [
        ['Account number', account.account_number],
        [
          'Current balance',
          formatCurrencyMinor(
            account.cached_balance_minor,
            account.currency,
          ),
        ],
        [
          'Existing overdraft outstanding',
          formatCurrencyMinor(
            account.overdraft_outstanding_minor || 0,
            account.currency,
          ),
        ],
        ['Status', account.status],
      ],
    );

    accountPreview.hidden =
      false;

    updateProjection();
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
      resetCustomer();
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

    const eligibleAccounts =
      accounts.filter(
        (account) =>
          account.status ===
          'active',
      );

    if (!eligibleAccounts.length) {
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

      renderAccount(null);

      return;
    }

    accountSelect.disabled =
      false;

    for (
      const account
      of eligibleAccounts
    ) {
      const option =
        document.createElement(
          'option',
        );

      option.value =
        account.id;

      option.textContent =
        `${account.account_number} · ${account.account_type} · ${formatCurrencyMinor(account.cached_balance_minor, account.currency)}`;

      accountSelect.append(
        option,
      );
    }

    accountSelectWrap.hidden =
      false;

    const selected =
      eligibleAccounts.find(
        (account) =>
          account.id ===
          preferredAccountId,
      ) ??
      eligibleAccounts[0];

    accountSelect.value =
      selected.id;

    renderAccount(
      selected,
    );
  }

  async function resolveCustomer(
    preferredAccountId = null,
  ) {
    const customerNumber =
      newForm.elements
        .customerNumber
        .value
        .trim();

    if (!customerNumber) {
      resetCustomer();
      return null;
    }

    const button =
      document.querySelector(
        '#lookupOverdraftCustomer',
      );

    button.disabled =
      true;

    button.textContent =
      'Checking...';

    try {
      const context =
        await getCustomerOverdraftContext(
          customerNumber,
        );

      renderCustomerContext(
        context,
        preferredAccountId,
      );

      return context;
    } catch (error) {
      resetCustomer();

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

  function canReview(
    overdraft,
  ) {
    return Boolean(
      CAN_APPROVE &&
      overdraft.status ===
        'pending' &&
      overdraft.requested_by !==
        session.user.id,
    );
  }

  function renderActions(
    overdraft,
  ) {
    const wrap =
      document.createElement(
        'div',
      );

    wrap.className =
      'transaction-actions';

    if (
      canReview(
        overdraft,
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
          const projected =
            overdraft.projected_balance_minor;

          const charge =
            overdraft.charge_minor;

          if (
            !window.confirm(
              `Approve ${overdraft.overdraft_number}? Payout ${formatCurrencyMinor(overdraft.requested_amount_minor, overdraft.currency)}. Charge ${formatCurrencyMinor(charge, overdraft.currency)} is recorded separately. Projected balance based on request-time balance: ${formatCurrencyMinor(projected, overdraft.currency)}.`,
            )
          ) {
            return;
          }

          approve.disabled =
            true;

          try {
            const result =
              await approveOverdraft(
                overdraft.id,
              );

            showMessage(
              `${overdraft.overdraft_number} approved. New account balance: ${formatCurrencyMinor(result.balance_after_minor, overdraft.currency)}.`,
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
          state.selectedOverdraft =
            overdraft;

          rejectForm.reset();

          document.querySelector(
            '#rejectOverdraftNumber',
          ).textContent =
            overdraft.overdraft_number;

          rejectDialog.showModal();
        },
      );

      wrap.append(
        approve,
        reject,
      );
    }

    if (
      CAN_APPROVE &&
      overdraft.status ===
        'active'
    ) {
      const close =
        document.createElement(
          'button',
        );

      close.type =
        'button';

      close.className =
        'mini-button';

      close.textContent =
        'Close';

      close.addEventListener(
        'click',
        () => {
          state.selectedOverdraft =
            overdraft;

          closeForm.reset();

          document.querySelector(
            '#closeOverdraftNumber',
          ).textContent =
            overdraft.overdraft_number;

          document.querySelector(
            '#closeOverdraftBalance',
          ).textContent =
            formatCurrencyMinor(
              overdraft.account_balance_minor,
              overdraft.currency,
            );

          closeDialog.showModal();
        },
      );

      wrap.append(close);
    }

    if (
      overdraft.status ===
        'pending' &&
      overdraft.requested_by ===
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

    if (!wrap.childNodes.length) {
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

  function renderOverdrafts() {
    tableBody.replaceChildren();

    for (
      const overdraft
      of state.overdrafts
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
        overdraft.overdraft_number;

      const numberSmall =
        document.createElement(
          'small',
        );

      numberSmall.textContent =
        `Requested ${formatDate(
          overdraft.requested_at,
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
        overdraft.customer_name;

      const customerSmall =
        document.createElement(
          'small',
        );

      customerSmall.textContent =
        `Customer ${overdraft.customer_number} · ${overdraft.account_number}`;

      customer.append(
        customerStrong,
        customerSmall,
      );

      const payout =
        document.createElement(
          'td',
        );

      const payoutStrong =
        document.createElement(
          'strong',
        );

      payoutStrong.textContent =
        formatCurrencyMinor(
          overdraft.requested_amount_minor,
          overdraft.currency,
        );

      const chargeSmall =
        document.createElement(
          'small',
        );

      chargeSmall.textContent =
        `Charge ${formatCurrencyMinor(
          overdraft.charge_minor,
          overdraft.currency,
        )}`;

      payout.append(
        payoutStrong,
        chargeSmall,
      );

      const projection =
        document.createElement(
          'td',
        );

      const projectionStrong =
        document.createElement(
          'strong',
        );

      projectionStrong.textContent =
        `Balance ${formatCurrencyMinor(
          overdraft.projected_balance_minor,
          overdraft.currency,
        )}`;

      const projectionSmall =
        document.createElement(
          'small',
        );

      projectionSmall.textContent =
        `Exposure ${formatCurrencyMinor(
          overdraft.overdraft_exposure_at_request_minor,
          overdraft.currency,
        )}`;

      projection.append(
        projectionStrong,
        projectionSmall,
      );

      const current =
        document.createElement(
          'td',
        );

      const currentStrong =
        document.createElement(
          'strong',
        );

      currentStrong.textContent =
        formatCurrencyMinor(
          overdraft.account_balance_minor,
          overdraft.currency,
        );

      const currentSmall =
        document.createElement(
          'small',
        );

      currentSmall.textContent =
        `Current overdraft ${formatCurrencyMinor(
          overdraft.current_overdraft_exposure_minor,
          overdraft.currency,
        )}`;

      current.append(
        currentStrong,
        currentSmall,
      );

      if (
        Number(
          overdraft.account_balance_minor,
        ) < 0
      ) {
        current.classList.add(
          'negative-money',
        );
      }

      const status =
        document.createElement(
          'td',
        );

      status.append(
        statusBadge(
          overdraft.status,
        ),
      );

      if (
        overdraft.rejection_reason
      ) {
        const reason =
          document.createElement(
            'small',
          );

        reason.textContent =
          overdraft.rejection_reason;

        status.append(reason);
      }

      const actions =
        document.createElement(
          'td',
        );

      actions.append(
        renderActions(
          overdraft,
        ),
      );

      row.append(
        number,
        customer,
        payout,
        projection,
        current,
        status,
        actions,
      );

      tableBody.append(row);
    }

    empty.hidden =
      state.overdrafts.length >
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

  async function loadOverdrafts() {
    loading.hidden =
      false;

    try {
      const result =
        await listOverdrafts(
          state,
        );

      state.overdrafts =
        result.overdrafts;

      state.count =
        result.count;

      renderOverdrafts();
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
        await getOverdraftSummary();

      document.querySelector(
        '#pendingOverdraftCount',
      ).textContent =
        summary.pending_count ?? 0;

      document.querySelector(
        '#activeOverdraftCount',
      ).textContent =
        summary.active_count ?? 0;

      document.querySelector(
        '#approvedOverdraftPayouts',
      ).textContent =
        formatCurrencyMinor(
          summary.approved_payouts_minor ?? 0,
        );

      document.querySelector(
        '#overdraftOutstanding',
      ).textContent =
        formatCurrencyMinor(
          summary.outstanding_exposure_minor ?? 0,
        );

      document.querySelector(
        '#overdraftCharges',
      ).textContent =
        formatCurrencyMinor(
          summary.approved_charges_minor ?? 0,
        );
    } catch (error) {
      showMessage(
        error.message,
        'error',
      );
    }
  }

  async function refreshAll() {
    await Promise.all([
      loadOverdrafts(),
      loadSummary(),
    ]);
  }

  document
    .querySelector(
      '#overdraftFilterForm',
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

        await loadOverdrafts();
      },
    );

  document
    .querySelector(
      '#clearOverdraftFilters',
    )
    .addEventListener(
      'click',
      async () => {
        const form =
          document.querySelector(
            '#overdraftFilterForm',
          );

        form.reset();

        state.page = 1;
        state.search = '';
        state.status = 'all';

        await loadOverdrafts();
      },
    );

  document
    .querySelector(
      '#refreshOverdrafts',
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
        if (state.page > 1) {
          state.page -= 1;
          await loadOverdrafts();
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
          await loadOverdrafts();
        }
      },
    );

  if (CAN_REQUEST) {
    document
      .querySelector(
        '#openNewOverdraft',
      )
      .addEventListener(
        'click',
        () => {
          newForm.reset();

          newForm.elements
            .charge.value =
            '0.00';

          resetCustomer();

          chargeNote.hidden =
            false;

          chargeNote.dataset.type =
            'info';

          chargeNote.textContent =
            'The manual charge is recorded separately as overdraft revenue. It does not reduce the customer payout or change the account balance calculation.';

          newDialog.showModal();
        },
      );

    document
      .querySelector(
        '#lookupOverdraftCustomer',
      )
      .addEventListener(
        'click',
        () => resolveCustomer(),
      );

    newForm.elements
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

          renderAccount(
            account,
          );
        },
      );

    newForm.elements
      .requestedAmount
      .addEventListener(
        'input',
        updateProjection,
      );

    newForm.addEventListener(
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

        if (
          !state.selectedAccount
        ) {
          showMessage(
            'Select an active customer account.',
            'error',
          );

          return;
        }

        try {
          const current =
            BigInt(
              String(
                state.selectedAccount
                  .cached_balance_minor ??
                0,
              ),
            );

          const requested =
            BigInt(
              nairaToMinor(
                newForm.elements
                  .requestedAmount
                  .value,
              ),
            );

          if (
            current -
            requested >=
            0n
          ) {
            showMessage(
              'This payout would not make the account negative. Use a normal withdrawal instead.',
              'error',
            );

            return;
          }
        } catch (error) {
          showMessage(
            error.message,
            'error',
          );

          return;
        }

        const submit =
          newForm.querySelector(
            'button[type="submit"]',
          );

        submit.disabled =
          true;

        submit.textContent =
          'Submitting...';

        try {
          const overdraft =
            await requestOverdraft({
              accountId:
                state.selectedAccount.id,

              requestedAmount:
                newForm.elements
                  .requestedAmount
                  .value,

              charge:
                newForm.elements
                  .charge
                  .value,

              purpose:
                newForm.elements
                  .purpose
                  .value,
            });

          newDialog.close();

          showMessage(
            `${overdraft.overdraft_number} submitted. Projected balance: ${formatCurrencyMinor(overdraft.projected_balance_minor, state.selectedAccount.currency)}.`,
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
            'Submit overdraft request';
        }
      },
    );
  }

  document
    .querySelector(
      '#closeNewOverdraft',
    )
    .addEventListener(
      'click',
      () =>
        newDialog.close(),
    );

  document
    .querySelector(
      '#cancelNewOverdraft',
    )
    .addEventListener(
      'click',
      () =>
        newDialog.close(),
    );

  document
    .querySelector(
      '#closeRejectOverdraft',
    )
    .addEventListener(
      'click',
      () =>
        rejectDialog.close(),
    );

  document
    .querySelector(
      '#cancelRejectOverdraft',
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
        !state.selectedOverdraft
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
        await rejectOverdraft(
          state.selectedOverdraft.id,
          rejectForm.elements
            .reason
            .value,
        );

        rejectDialog.close();

        showMessage(
          `${state.selectedOverdraft.overdraft_number} rejected.`,
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
      '#closeCloseOverdraft',
    )
    .addEventListener(
      'click',
      () =>
        closeDialog.close(),
    );

  document
    .querySelector(
      '#cancelCloseOverdraft',
    )
    .addEventListener(
      'click',
      () =>
        closeDialog.close(),
    );

  closeForm.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      if (
        !state.selectedOverdraft
      ) {
        return;
      }

      const submit =
        closeForm.querySelector(
          'button[type="submit"]',
        );

      submit.disabled =
        true;

      try {
        await closeOverdraft(
          state.selectedOverdraft.id,
          closeForm.elements
            .reason
            .value,
        );

        closeDialog.close();

        showMessage(
          `${state.selectedOverdraft.overdraft_number} closed.`,
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
    newForm.reset();

    newForm.elements
      .charge.value =
      '0.00';

    newForm.elements
      .customerNumber
      .value =
      prefillCustomer;

    await resolveCustomer(
      prefillAccount,
    );

    chargeNote.hidden =
      false;

    chargeNote.dataset.type =
      'info';

    chargeNote.textContent =
      'The manual charge is recorded separately as overdraft revenue. It does not reduce the customer payout or change the account balance calculation.';

    newDialog.showModal();

    window.history.replaceState(
      {},
      '',
      './overdrafts.html',
    );
  }

  await refreshAll();
}
