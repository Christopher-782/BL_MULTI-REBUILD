# Step 4 — Financial Ledger and Transactions

Run `supabase/007_financial_ledger_transactions.sql` after Step 3.

Features:
- Deposits and withdrawals are created as pending requests.
- Pending requests do not change balances.
- Maker-checker protection: the initiator cannot approve/reject their own request.
- Managers/admins/super-admins can approve normal transactions.
- Only admins/super-admins can request and approve reversals.
- Approval atomically updates the cached account balance and inserts one immutable ledger entry.
- Reversals are compensating transactions; ledger rows are never deleted.
- Account balances remain integer minor units (kobo).
- Browser roles have SELECT-only access to financial tables and call restricted RPCs for changes.

Test with at least two staff accounts so the maker-checker rule can be verified.
