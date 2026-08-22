# BL Multi Concept deployment checklist

Complete these steps in order before accepting real transactions.

## 1. Rotate the exposed database credential

An earlier project copy contained a database password in a tracked text file. That file is not included in this release, but deleting a file does not invalidate the credential or remove it from earlier Git history.

1. Rotate the Supabase database password in the project dashboard.
2. Update only the trusted deployment systems that require the new password.
3. If this project is pushed to Git, remove the historical secret with a history-rewriting tool such as git-filter-repo, then invalidate any old clones.
4. Confirm there are no service-role or secret keys in browser files. The publishable browser key is expected to be public and is protected by RLS.

Reference: [GitHub guidance for removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

## 2. Apply database migrations

Back up the database, then apply the numbered SQL files in order. For an existing installation already on migration 017, apply:

1. `supabase/018_production_hardening.sql`
2. Refresh the Supabase schema cache if the migration notification is not observed.
3. Run `supabase/tests/database/production_hardening.test.sql` in a disposable or staging database with pgTAP available.

References: [Supabase database testing](https://supabase.com/docs/guides/database/testing) and [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security)

Migration 018 adds:

- role-scoped filtered staff totals;
- transaction idempotency;
- deterministic bulk-approval locks;
- restricted customer and account lookup RPCs;
- staff-only visibility for their related customer/account rows;
- recovery of SMS jobs abandoned in `processing`.

## 3. Configure services

1. Confirm the Supabase URL and publishable key in `public/assets/js/config/supabase-config.js`.
2. Deploy the `staff-admin` and `sms-alerts` Edge Functions.
3. Configure the SMS provider secrets only in Supabase Edge Function secrets.
4. Set the allowed site URL and invitation redirect URL in Supabase Auth.
5. Verify that Render serves `./public` and applies the headers in `render.yaml`.

Reference: [Render static-site response headers](https://render.com/docs/static-site-headers)

## 4. Validate and stage

Run:

```bash
npm test
```

In staging, test:

1. Repeatedly submit the same transaction request and confirm only one pending transaction is created.
2. Submit and approve deposits and withdrawals concurrently against the same account.
3. Bulk approve two overlapping staff batches and confirm there are no deadlocks or duplicate ledger entries.
4. Confirm staff filtered totals change with search, status, and type filters and never include another staff member's transactions.
5. Confirm management can select a staff member and see that maker's filtered totals.
6. Stop an SMS worker after claiming a job, wait more than 10 minutes, then confirm another worker reclaims it.
7. Test invitation, sign-in, session expiry, role restrictions, and logout.

The guarded concurrency runner automates the first three transaction checks. It creates real staging transactions and must never be pointed at production:

```bash
ALLOW_STAGING_MUTATION=yes \
SUPABASE_URL=https://YOUR-STAGING-PROJECT.supabase.co \
SUPABASE_PUBLISHABLE_KEY=YOUR_STAGING_PUBLISHABLE_KEY \
STAFF_ACCESS_TOKEN=STAGING_STAFF_JWT \
MANAGER_ACCESS_TOKEN=STAGING_MANAGER_JWT \
TEST_ACCOUNT_ID=STAGING_ACTIVE_ACCOUNT_UUID \
npm run test:staging-concurrency
```

## 5. Go-live controls

1. Take a final database backup.
2. Enable deployment health monitoring and error alerts.
3. Start with a limited transaction window and reconcile account balances against ledger entries.
4. Keep a rollback copy of the prior static deployment and database backup.
