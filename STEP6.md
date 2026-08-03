# Step 6 — Expenses, Revenue Reports and Management Dashboard

Run:

`supabase/012_expenses_reports_dashboard.sql`

after Step 5B.

## Expenses

Staff, managers, admins and super-admins can submit an expense.

Managers, admins and super-admins can approve/reject.

Maker-checker is enforced:
the requester cannot approve or reject their own expense.

Approved expenses are never edited or deleted by the browser.

Categories included in the UI:
- Rent
- Salaries & Wages
- Utilities
- Transport
- Office Supplies
- Maintenance
- Marketing
- Tax & Regulatory
- Professional Fees
- Other

## Realized revenue

Step 6 only calls revenue "realized" when it has actually been earned/collected:

1. Approved deposit charges
2. Approved overdraft charges
3. Loan interest actually collected through approved repayments

Not treated as revenue:
- customer deposits
- customer withdrawals
- loan principal disbursed
- overdraft payout principal
- uncollected loan interest

## Operational net

Operational net = realized revenue - approved operating expenses.

This is a management metric, NOT a statutory profit-and-loss statement.

## Dashboard

The new dashboard includes:
- active customers
- positive customer balances
- overdraft exposure
- loan outstanding
- today's deposits
- today's withdrawals
- today's realized revenue
- today's expenses
- today's operational net
- pending approval counts
- recent transactions
- recent expenses

## Reports

`reports.html` supports date-range reports and CSV export.

It includes:
- realized revenue
- operating expenses
- operational net
- deposit charges
- overdraft charges
- loan interest collected
- net customer deposits
- withdrawals
- loan disbursements
- loan repayments
- overdraft payouts
- expense-category breakdown
