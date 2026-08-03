import {
  bindLogoutButtons,
  bindSessionUI,
  requireActiveProfile,
} from '../auth/access.js';

import {
  getManagementReport,
} from '../services/reports.service.js';

import {
  formatCurrencyMinor,
} from '../services/transactions.service.js';

const session =
  await requireActiveProfile();

if (session) {
  bindSessionUI(
    session.profile,
    session.user,
  );

  bindLogoutButtons();

  const message =
    document.querySelector(
      '#pageMessage',
    );

  const form =
    document.querySelector(
      '#reportFilterForm',
    );

  let currentReport =
    null;

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

  function hideMessage() {
    message.hidden =
      true;
  }

  function isoDate(
    date,
  ) {
    return date
      .toISOString()
      .slice(0, 10);
  }

  function setDefaultDates() {
    const now =
      new Date();

    const start =
      new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
      );

    form.elements
      .fromDate
      .value =
      isoDate(start);

    form.elements
      .toDate
      .value =
      isoDate(now);
  }

  function renderReport(
    report,
  ) {
    currentReport =
      report;

    const revenue =
      report.revenue || {};

    const activity =
      report.activity || {};

    const totalRevenue =
      revenue.total_revenue_minor ??
      0;

    const expenses =
      report.expenses_minor ??
      0;

    const operationalNet =
      report.operational_net_minor ??
      0;

    document.querySelector(
      '#reportRevenue',
    ).textContent =
      formatCurrencyMinor(
        totalRevenue,
      );

    document.querySelector(
      '#reportExpenses',
    ).textContent =
      formatCurrencyMinor(
        expenses,
      );

    const net =
      document.querySelector(
        '#reportNet',
      );

    net.textContent =
      formatCurrencyMinor(
        operationalNet,
      );

    net.dataset.sign =
      Number(
        operationalNet,
      ) < 0
        ? 'negative'
        : 'positive';

    document.querySelector(
      '#reportDeposits',
    ).textContent =
      formatCurrencyMinor(
        activity.net_deposits_minor ??
        0,
      );

    document.querySelector(
      '#reportWithdrawals',
    ).textContent =
      formatCurrencyMinor(
        activity.withdrawals_minor ??
        0,
      );

    document.querySelector(
      '#depositChargeRevenue',
    ).textContent =
      formatCurrencyMinor(
        revenue.deposit_charges_minor ??
        0,
      );

    document.querySelector(
      '#overdraftChargeRevenue',
    ).textContent =
      formatCurrencyMinor(
        revenue.overdraft_charges_minor ??
        0,
      );

    document.querySelector(
      '#loanInterestRevenue',
    ).textContent =
      formatCurrencyMinor(
        revenue.loan_interest_collected_minor ??
        0,
      );

    document.querySelector(
      '#loanDisbursements',
    ).textContent =
      formatCurrencyMinor(
        activity.loan_disbursements_minor ??
        0,
      );

    document.querySelector(
      '#loanRepayments',
    ).textContent =
      formatCurrencyMinor(
        activity.loan_repayments_minor ??
        0,
      );

    document.querySelector(
      '#overdraftPayouts',
    ).textContent =
      formatCurrencyMinor(
        activity.overdraft_payouts_minor ??
        0,
      );

    document.querySelector(
      '#reportRange',
    ).textContent =
      `${report.from_date} to ${report.to_date}`;

    const body =
      document.querySelector(
        '#expenseBreakdownBody',
      );

    body.replaceChildren();

    const breakdown =
      Array.isArray(
        report.expense_breakdown,
      )
        ? report.expense_breakdown
        : [];

    for (
      const item
      of breakdown
    ) {
      const row =
        document.createElement(
          'tr',
        );

      const category =
        document.createElement(
          'td',
        );

      category.textContent =
        item.category;

      const count =
        document.createElement(
          'td',
        );

      count.textContent =
        item.count;

      const amount =
        document.createElement(
          'td',
        );

      amount.className =
        'money-cell';

      amount.textContent =
        formatCurrencyMinor(
          item.amount_minor,
        );

      row.append(
        category,
        count,
        amount,
      );

      body.append(row);
    }

    document.querySelector(
      '#expenseBreakdownEmpty',
    ).hidden =
      breakdown.length > 0;
  }

  async function generateReport() {
    hideMessage();

    const fromDate =
      form.elements
        .fromDate
        .value;

    const toDate =
      form.elements
        .toDate
        .value;

    const button =
      form.querySelector(
        'button[type="submit"]',
      );

    button.disabled =
      true;

    button.textContent =
      'Generating...';

    try {
      const report =
        await getManagementReport(
          fromDate,
          toDate,
        );

      renderReport(
        report,
      );
    } catch (error) {
      showMessage(
        error.message,
        'error',
      );
    } finally {
      button.disabled =
        false;

      button.textContent =
        'Generate report';
    }
  }

  function csvEscape(
    value,
  ) {
    const text =
      String(
        value ?? '',
      );

    return `"${text.replaceAll(
      '"',
      '""',
    )}"`;
  }

  function downloadCsv() {
    if (!currentReport) {
      showMessage(
        'Generate a report before exporting.',
        'error',
      );

      return;
    }

    const revenue =
      currentReport.revenue ||
      {};

    const activity =
      currentReport.activity ||
      {};

    const lines = [
      [
        'BL Multi Concept Management Report',
      ],
      [
        'From',
        currentReport.from_date,
        'To',
        currentReport.to_date,
      ],
      [],
      [
        'SUMMARY',
      ],
      [
        'Realized revenue',
        Number(
          revenue.total_revenue_minor || 0,
        ) / 100,
      ],
      [
        'Approved expenses',
        Number(
          currentReport.expenses_minor || 0,
        ) / 100,
      ],
      [
        'Operational net',
        Number(
          currentReport.operational_net_minor || 0,
        ) / 100,
      ],
      [],
      [
        'REVENUE BREAKDOWN',
      ],
      [
        'Deposit charges',
        Number(
          revenue.deposit_charges_minor || 0,
        ) / 100,
      ],
      [
        'Overdraft charges',
        Number(
          revenue.overdraft_charges_minor || 0,
        ) / 100,
      ],
      [
        'Loan interest collected',
        Number(
          revenue.loan_interest_collected_minor || 0,
        ) / 100,
      ],
      [],
      [
        'ACTIVITY',
      ],
      [
        'Net deposits',
        Number(
          activity.net_deposits_minor || 0,
        ) / 100,
      ],
      [
        'Withdrawals',
        Number(
          activity.withdrawals_minor || 0,
        ) / 100,
      ],
      [
        'Loan disbursements',
        Number(
          activity.loan_disbursements_minor || 0,
        ) / 100,
      ],
      [
        'Loan repayments',
        Number(
          activity.loan_repayments_minor || 0,
        ) / 100,
      ],
      [
        'Overdraft payouts',
        Number(
          activity.overdraft_payouts_minor || 0,
        ) / 100,
      ],
      [],
      [
        'EXPENSE BREAKDOWN',
      ],
      [
        'Category',
        'Count',
        'Amount',
      ],
      ...(
        currentReport
          .expense_breakdown ||
        []
      ).map(
        (item) => [
          item.category,
          item.count,
          Number(
            item.amount_minor || 0,
          ) / 100,
        ],
      ),
    ];

    const csv =
      lines
        .map(
          (row) =>
            row
              .map(
                csvEscape,
              )
              .join(','),
        )
        .join('\r\n');

    const blob =
      new Blob(
        [csv],
        {
          type:
            'text/csv;charset=utf-8',
        },
      );

    const url =
      URL.createObjectURL(
        blob,
      );

    const anchor =
      document.createElement(
        'a',
      );

    anchor.href =
      url;

    anchor.download =
      `management-report-${currentReport.from_date}-to-${currentReport.to_date}.csv`;

    document.body.append(
      anchor,
    );

    anchor.click();
    anchor.remove();

    URL.revokeObjectURL(
      url,
    );
  }

  form.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      await generateReport();
    },
  );

  document.querySelector(
    '#exportReportCsv',
  ).addEventListener(
    'click',
    downloadCsv,
  );

  document.querySelector(
    '#thisMonthReport',
  ).addEventListener(
    'click',
    async () => {
      setDefaultDates();
      await generateReport();
    },
  );

  setDefaultDates();
  await generateReport();
}
