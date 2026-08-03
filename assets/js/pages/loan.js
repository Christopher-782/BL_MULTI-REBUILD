import {
  bindLogoutButtons,
  bindSessionUI,
  requireActiveProfile,
} from '../auth/access.js';

import {
  basisPointsToPercent,
  formatCurrencyMinor,
  getLoan,
  listLoanRepayments,
} from '../services/loans.service.js';

const session =
  await requireActiveProfile();

if (session) {
  bindSessionUI(
    session.profile,
    session.user,
  );

  bindLogoutButtons();

  const loanId =
    new URLSearchParams(
      window.location.search,
    ).get('id');

  const message =
    document.querySelector(
      '#pageMessage',
    );

  if (!loanId) {
    window.location.replace(
      './loans.html',
    );
  }

  function showMessage(
    text,
    type = 'error',
  ) {
    message.textContent =
      text;

    message.dataset.type =
      type;

    message.hidden =
      false;
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

  function renderLoan(
    loan,
  ) {
    document.querySelector(
      '#loanHeading',
    ).textContent =
      loan.loan_number;

    document.querySelector(
      '#loanCustomerName',
    ).textContent =
      loan.customer_name;

    document.querySelector(
      '#loanCustomerNumber',
    ).textContent =
      loan.customer_number;

    document.querySelector(
      '#loanAccountNumber',
    ).textContent =
      loan.account_number;

    const status =
      document.querySelector(
        '#loanStatus',
      );

    status.replaceChildren(
      statusBadge(
        loan.status,
        loan.overdue,
      ),
    );

    document.querySelector(
      '#loanPrincipal',
    ).textContent =
      formatCurrencyMinor(
        loan.principal_minor,
        loan.currency,
      );

    document.querySelector(
      '#loanInterest',
    ).textContent =
      formatCurrencyMinor(
        loan.interest_minor,
        loan.currency,
      );

    document.querySelector(
      '#loanTotalPayable',
    ).textContent =
      formatCurrencyMinor(
        loan.total_payable_minor,
        loan.currency,
      );

    document.querySelector(
      '#loanOutstanding',
    ).textContent =
      formatCurrencyMinor(
        loan.outstanding_minor,
        loan.currency,
      );

    document.querySelector(
      '#loanPrincipalOutstanding',
    ).textContent =
      formatCurrencyMinor(
        loan.principal_outstanding_minor,
        loan.currency,
      );

    document.querySelector(
      '#loanInterestOutstanding',
    ).textContent =
      formatCurrencyMinor(
        loan.interest_outstanding_minor,
        loan.currency,
      );

    document.querySelector(
      '#loanRate',
    ).textContent =
      `${basisPointsToPercent(
        loan.interest_rate_bps,
      )}% flat`;

    document.querySelector(
      '#loanTerm',
    ).textContent =
      `${loan.term_months} month${loan.term_months === 1 ? '' : 's'}`;

    document.querySelector(
      '#loanDueDate',
    ).textContent =
      loan.due_date
        ? formatDate(
            loan.due_date,
          )
        : 'After approval';

    document.querySelector(
      '#loanRequestedBy',
    ).textContent =
      `${loan.requested_by_name} · ${formatDate(
        loan.requested_at,
        true,
      )}`;

    document.querySelector(
      '#loanApprovedBy',
    ).textContent =
      loan.approved_by_name
        ? `${loan.approved_by_name} · ${formatDate(
            loan.approved_at,
            true,
          )}`
        : '—';

    document.querySelector(
      '#loanPurpose',
    ).textContent =
      loan.purpose ||
      'No purpose recorded';

    document.querySelector(
      '#loanRejectionReason',
    ).textContent =
      loan.rejection_reason ||
      '—';
  }

  function renderRepayments(
    repayments,
    currency = 'NGN',
  ) {
    const body =
      document.querySelector(
        '#repaymentHistoryBody',
      );

    body.replaceChildren();

    for (
      const repayment
      of repayments
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

      const amount =
        document.createElement(
          'td',
        );

      amount.textContent =
        formatCurrencyMinor(
          repayment.amount_minor,
          currency,
        );

      const allocation =
        document.createElement(
          'td',
        );

      allocation.innerHTML = `
        <strong>Interest ${formatCurrencyMinor(
          repayment.interest_component_minor,
          currency,
        )}</strong>
        <small>Principal ${formatCurrencyMinor(
          repayment.principal_component_minor,
          currency,
        )}</small>
      `;

      const method =
        document.createElement(
          'td',
        );

      method.innerHTML = `
        <strong>${repayment.payment_method}</strong>
        <small>${repayment.external_reference || 'No external reference'}</small>
      `;

      const status =
        document.createElement(
          'td',
        );

      status.append(
        statusBadge(
          repayment.status,
        ),
      );

      if (
        repayment.rejection_reason
      ) {
        const reason =
          document.createElement(
            'small',
          );

        reason.textContent =
          repayment.rejection_reason;

        status.append(reason);
      }

      const people =
        document.createElement(
          'td',
        );

      people.innerHTML = `
        <strong>${repayment.requested_by_name || '—'}</strong>
        <small>${
          repayment.approved_by_name
            ? `Approved by ${repayment.approved_by_name}`
            : repayment.rejected_by_name
              ? `Rejected by ${repayment.rejected_by_name}`
              : 'Awaiting review'
        }</small>
      `;

      row.append(
        number,
        amount,
        allocation,
        method,
        status,
        people,
      );

      body.append(row);
    }

    document.querySelector(
      '#repaymentHistoryEmpty',
    ).hidden =
      repayments.length > 0;
  }

  try {
    const [
      loan,
      repayments,
    ] =
      await Promise.all([
        getLoan(loanId),
        listLoanRepayments(
          loanId,
        ),
      ]);

    renderLoan(loan);

    renderRepayments(
      repayments,
      loan.currency,
    );
  } catch (error) {
    showMessage(
      error.message,
      'error',
    );
  }
}
