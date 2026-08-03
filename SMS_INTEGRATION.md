# BL Multi Concept — SMS Integration

The original application used BulkSMS Nigeria. The Supabase rebuild now uses
the same provider family, but the provider credential is kept inside a
Supabase Edge Function secret rather than in Render/browser code.

## What is connected

Automatic queued alerts are created for:

- approved and rejected deposits/withdrawals/reversals;
- approved/disbursed and rejected loans;
- approved and rejected loan repayments;
- approved and rejected overdrafts;
- bulk staff transaction approvals (one SMS event per approved transaction).

SMS delivery is deliberately separate from the financial transaction itself.
If BulkSMS Nigeria is temporarily unavailable, the financial approval remains
successful and the SMS stays retryable in `public.sms_outbox`.

## 1. Run SQL

Run:

`supabase/015_sms_alerts.sql`

in Supabase SQL Editor.

## 2. Create Edge Function secrets

Do NOT put the SMS token in Render, HTML, JavaScript, GitHub, or a public SQL
file.

Configure these secrets for the `sms-alerts` Supabase Edge Function:

- `BULKSMS_TOKEN` — your existing BulkSMS Nigeria API token.
- `SMS_SENDER_ID` — an approved BulkSMS Nigeria sender ID. Current provider
  documentation limits the sender ID to 11 characters.
- `SMS_PROVIDER=bulksmsnigeria`
- `SMS_TEST_MODE=true`
- `SMS_GATEWAY=direct-refund`

Keep `SMS_TEST_MODE=true` while testing. Change it to `false` only after a
sandbox test succeeds and the sender ID is approved.

The old project used `BL MULTI CONCEPT` as the provider `from` value. Current
BulkSMS Nigeria v2 documentation limits `from` to 11 characters, so use the
actual approved sender ID from your BulkSMS Nigeria account rather than
hard-coding the old longer value.

## 3. Deploy the Edge Function

Deploy:

`supabase/functions/sms-alerts/index.ts`

as the Supabase Edge Function named:

`sms-alerts`

The function requires an authenticated BL Multi Concept staff session.

## 4. Deploy frontend to Render

Deploy the updated `public` folder.

A new Administration page is available:

`/sms.html`

Super admins/admins can:

- see whether the provider is configured;
- see Test vs Live mode;
- view pending/failed/skipped/sent-today counts;
- dispatch pending alerts;
- send a test SMS.

The API token is never displayed.

## 5. Test in this order

1. Leave `SMS_TEST_MODE=true`.
2. Open `/sms.html`.
3. Confirm `Configured`.
4. Send a test to your own Nigerian number.
5. Approve one small test deposit.
6. Confirm the outbox item changes to `sent`.
7. After validation, set `SMS_TEST_MODE=false`.
8. Test one real SMS before normal use.

## Security model

- Provider credential: Supabase Edge Function secret only.
- Browser: only invokes the authenticated Edge Function.
- Database: records event payload/status, never the provider token.
- Financial RPCs do not fail because of an external SMS outage.
- Duplicate SMS prevention uses unique event keys.
- Failed messages retry with increasing delay up to the configured attempt cap.
