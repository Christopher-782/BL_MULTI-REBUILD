# Step 5 — Loans

Run:

`supabase/009_loans_repayments.sql`

after Step 4 migrations, especially:

- `007_financial_ledger_transactions.sql`
- `008_customer_search_deposit_charges.sql`

## Loan workflow

1. Staff searches by the customer's 3-digit customer number.
2. Staff selects the active account that should receive the loan.
3. Staff enters principal, flat interest rate, term and purpose.
4. Loan is created as `pending`.
5. A different manager/admin/super-admin approves it.
6. Approval atomically:
   - creates an approved `loan_disbursement` transaction,
   - credits the principal to the selected customer account,
   - creates the immutable account ledger entry,
   - activates the loan,
   - sets the due date.

The requester cannot approve or reject their own loan.

## Interest model

Step 5 uses a flat interest amount:

`interest = principal × flat rate`

Example:

- Principal: ₦100,000
- Flat interest: 10%
- Interest: ₦10,000
- Total payable: ₦110,000

The rate is stored as integer basis points.

## Repayment workflow

Repayments in Step 5 represent cash/bank-transfer/other payments made to the business.

They DO NOT automatically debit the customer's deposit account.

1. Staff records a repayment.
2. It is `pending`.
3. A different manager/admin/super-admin approves it.
4. Approved repayment is allocated:
   - interest first,
   - then principal.
5. Outstanding balances are reduced.
6. When both outstanding principal and interest reach zero, the loan becomes `paid`.

A `loan_repayment` event also appears in the transaction register for traceability, but it does not create a customer deposit-account ledger entry.

## Test with two users

Use at least:
- User A: staff
- User B: manager/admin/super-admin

Test:
1. User A creates a loan.
2. User A cannot approve it.
3. User B approves it.
4. Customer account balance increases by principal.
5. User A records a repayment.
6. User A cannot approve their own repayment.
7. User B approves repayment.
8. Loan outstanding reduces.

## Repayment approval queue

`loans.html` includes a Pending Loan Repayments queue.

A repayment requester cannot approve/reject their own repayment.
A different manager/admin/super-admin must review it.
