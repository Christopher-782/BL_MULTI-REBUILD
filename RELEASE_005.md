# BL Multi Concept — Release 005

## Changes

### SMS integration
- Adapted the supplied Node/CommonJS `smsService.js` behavior to the existing Supabase `sms-alerts` Edge Function.
- BulkSMS credentials remain server-side; no API token is added to public browser JavaScript.
- Supports `BULKSMS_TOKEN`, `SMS_SENDER_ID`, `SMS_TEST_MODE`, and compatibility aliases `BULKSMS_SENDER_ID` / `TEST_MODE`.
- Automatic queued alerts remain connected to transaction, loan, loan-repayment and overdraft approval/rejection events.
- Transaction individual and bulk approvals kick the SMS dispatcher after the financial operation completes.

### Transaction-only staff workspace
- Role `staff` signs in directly to `transactions.html`.
- Direct attempts by staff to open other application pages redirect back to Transactions.
- Staff sidebar exposes Transactions only.
- Dashboard/management transaction metrics are hidden from staff.
- Staff transaction register is scoped to transactions initiated by the current staff user.
- Staff can continue initiating deposits and withdrawals, but cannot approve transactions.
- Migration `017_staff_transaction_only.sql` removes staff from customer-management, loan-request, overdraft-request and expense-request authorization helpers and blocks dashboard summary access for staff.

### Dynamic customer transaction search
- New-transaction lookup now searches while typing.
- Matches customer number, first/middle/last name, phone, email, and account number.
- Results appear in a live dropdown and support mouse selection plus Arrow Up/Down, Enter and Escape.
- Selecting a result resolves the full transaction context and preselects the matched account when the lookup came from an account number.

## Deployment
1. Apply `supabase/015_sms_alerts.sql` if SMS tables/triggers have not already been installed.
2. Apply `supabase/016_bulk_approval_schema_cache_hotfix.sql` if not already applied.
3. Apply `supabase/017_staff_transaction_only.sql`.
4. Configure the `sms-alerts` Edge Function secrets listed in `SMS_INTEGRATION.md`.
5. Deploy `supabase/functions/sms-alerts/index.ts` as the `sms-alerts` Edge Function.
6. Redeploy the Render static site (`public`).
