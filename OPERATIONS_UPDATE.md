# Operations Update — Customers, Dashboard, Bulk Approvals

## Database
Run `supabase/014_customer_dashboard_bulk_approval.sql` once in Supabase SQL Editor.

## Customer page
- Shows true total positive customer balances across all open accounts.
- Keeps the current page balance as a separate metric.
- Uses a database summary RPC with a read-only frontend fallback.

## Dashboard
- Controller moved to `assets/js/pages/dashboard.js`.
- Dashboard no longer depends on a root-level JS file.
- Summary, recent transactions, and recent expenses load independently.
- Legacy `opening_balance` transactions are excluded from the normal recent transaction list, while their balances remain in customer-fund totals.
- SQL migration refreshes `get_dashboard_summary()` against the current schema.

## Bulk transaction approval
- Visible only to super_admin/admin/manager.
- Choose a staff maker and load that staff member's pending queue.
- Select individual items or all eligible transactions on the current page.
- Maximum 100 selected items per batch.
- Each transaction is still approved through the existing `approve_transaction()` RPC.
- Maker-checker, balance checks, deposit-charge checks, account locking and immutable ledger logic are preserved.
- Partial failures are returned individually; successful items remain approved.
