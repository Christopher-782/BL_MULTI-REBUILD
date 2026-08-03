STEP 2 - ADMIN-CREATED STAFF PASSWORD PATCH

This patch changes staff onboarding from email invitations to direct account creation.

Replace these files in your current working project:
- staff.html
- assets/js/pages/staff.js
- assets/js/services/staff.service.js
- supabase/functions/staff-admin/index.ts

Then redeploy the Supabase Edge Function named: staff-admin

No new SQL migration is required.

New behavior:
- Admin enters full name, email, phone, role, password, confirm password.
- Edge Function creates the Supabase Auth user with email_confirm=true.
- Staff can log in immediately using the admin-created password.
- Password is not stored in public.profiles or audit_logs.
- Edit Staff also supports an optional admin password reset.

The old accept-invite.html page is no longer used and may be deleted later.
