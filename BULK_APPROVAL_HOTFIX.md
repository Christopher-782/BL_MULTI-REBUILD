# Bulk approval + pending approval notification hotfix

## What was fixed

- `get_pending_transaction_makers()` now has a browser fallback when the RPC is missing from the Supabase schema cache.
- Bulk approval now falls back to the existing `approve_transaction(uuid)` RPC one selected transaction at a time if the batch RPC is unavailable. The normal maker-checker, balance and database approval rules still apply.
- Approvers (`super_admin`, `admin`, `manager`) now get an in-app **Pending approvals** notification badge. It counts pending transactions created by other staff and links to the bulk approval panel.
- The notification refreshes every 60 seconds, when the tab becomes active again, and immediately after transaction approval-queue changes on the current page.

## Required Supabase database fix

The frontend fallback keeps the workflow usable, but you should still repair the database RPC schema cache.

1. Open **Supabase Dashboard -> SQL Editor**.
2. Run `supabase/016_bulk_approval_schema_cache_hotfix.sql` once.
3. Confirm the verification output includes:
   - `get_pending_transaction_makers()`
   - `bulk_approve_staff_transactions(uuid, uuid[])`
4. Refresh the deployed website.

The hotfix ends with `NOTIFY pgrst, 'reload schema';`, which forces PostgREST to refresh the RPC schema cache.
