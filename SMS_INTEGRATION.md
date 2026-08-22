# BL Multi Concept — BulkSMS Nigeria Integration

This build integrates the supplied `smsService.js` behavior into the Supabase-based website without exposing the BulkSMS API token in browser code.

The original supplied service is Node/CommonJS (`require`, `process.env`, Axios). This BL Multi Concept deployment is a static Render site, so the provider call runs inside the authenticated Supabase Edge Function instead.

## What is integrated

Automatic SMS queue events are created for:

- approved deposit / credit alerts;
- approved withdrawal / debit alerts;
- transaction rejection alerts;
- approved/disbursed and rejected loans;
- approved and rejected loan repayments;
- approved and rejected overdrafts;
- bulk staff transaction approvals (one customer alert per approved transaction).

The supplied service's Nigerian phone normalization, message sanitization and BL Multi Concept alert style are retained. The Edge Function uses BulkSMS Nigeria's current v2 API rather than exposing credentials in the static frontend.

Financial approvals and SMS delivery are deliberately decoupled. A transaction remains successfully approved even if the SMS provider is temporarily unavailable; the alert stays retryable in `public.sms_outbox`.

## 1. Run the database migrations

Run these in Supabase SQL Editor in order if they have not already been applied:

1. `supabase/015_sms_alerts.sql`
2. `supabase/016_bulk_approval_schema_cache_hotfix.sql`
3. `supabase/017_staff_transaction_only.sql`

## 2. Configure Edge Function secrets

Never put the SMS token in HTML, frontend JavaScript, Render environment variables served to the browser, GitHub, or a public SQL file.

Configure the following secrets for the `sms-alerts` Supabase Edge Function:

- `BULKSMS_TOKEN` — BulkSMS Nigeria API token.
- `SMS_SENDER_ID` — the approved sender ID from the BulkSMS account (maximum 11 characters).
- `SMS_PROVIDER=bulksmsnigeria`
- `SMS_TEST_MODE=true`
- `SMS_GATEWAY=direct-refund`

Compatibility aliases from the supplied service are also supported:

- `TEST_MODE` may be used if `SMS_TEST_MODE` is not defined.
- `BULKSMS_SENDER_ID` may be used if `SMS_SENDER_ID` is not defined.

Keep test mode enabled while validating the integration. Switch it off only after the sender ID and test requests work.

## 3. Deploy the Edge Function

Deploy:

`supabase/functions/sms-alerts/index.ts`

as the Supabase Edge Function named:

`sms-alerts`

## 4. Deploy the website

Render serves the `public` folder. Redeploy after pushing the updated build.

The administration SMS page remains:

`/sms.html`

Only Super Admin/Admin accounts can open it. They can see provider status, Test/Live mode, queue totals, dispatch pending alerts, and send a connection test. The API token is never displayed.

## 5. Recommended test sequence

1. Set `SMS_TEST_MODE=true`.
2. Run migration 015 if it has not been run.
3. Deploy `sms-alerts`.
4. Open `/sms.html` as an Admin/Super Admin.
5. Verify the provider says `Configured`.
6. Send a test to your own Nigerian number.
7. Create a small deposit as a staff user.
8. Approve it from a different management account.
9. Confirm the SMS outbox item changes to `sent` in test mode.
10. Set `SMS_TEST_MODE=false` only when ready for real delivery.

## Staff access model in this build

A user whose profile role is `staff` is transaction-only:

- login lands on `/transactions.html`;
- dashboard and other operational pages redirect back to Transactions;
- sidebar shows Transactions only;
- management transaction metrics are hidden;
- staff see their own transaction submissions in the register;
- staff can initiate deposits/withdrawals;
- staff cannot approve transactions;
- database authorization helpers no longer allow staff to create/manage customers or initiate loan, overdraft, or expense workflows.
