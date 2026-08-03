# Step 3 — Customers + Customer Accounts

This overlay assumes Steps 1 and 2 are already working.

## Install

1. Extract this overlay into your current project and replace matching files.
2. Do **not** replace `assets/js/config/supabase-config.js`; this overlay does not contain it.
3. In Supabase SQL Editor, run `supabase/005_customers_accounts.sql` once.
4. Refresh the app with Ctrl+F5.
5. Open `customers.html`.

## Security model

- Active signed-in staff can read customer/account records.
- `auditor` is read-only.
- `staff`, `manager`, `admin`, and `super_admin` can create/update customer records.
- Browser clients only receive `SELECT` privileges on `customers` and `accounts`.
- All writes run through restricted PostgreSQL RPC functions.
- Customer/account numbers are generated in PostgreSQL.
- Customer deletion is intentionally not implemented.
- Account balances are cached as integer minor units (kobo) but remain `0` until Step 4 creates the ledger.

## Test checklist

1. Super admin can open Customers.
2. Create a customer and confirm a `BLMxxxxxxx` customer number is generated.
3. Confirm a 10-digit account number is generated automatically.
4. Confirm the customer appears in the directory.
5. Search by name, phone, email, or customer number.
6. Open customer details and edit them.
7. Open a second account.
8. Freeze/reactivate an account.
9. Login as auditor: customer records should be visible but editing/creation controls should be hidden/disabled.
10. Check `audit_logs` for `customer.created`, `customer.updated`, `account.created`, and `account.status_updated`.

Step 4 will build deposits, withdrawals, approvals, immutable ledger entries, balance posting, and reversals.
