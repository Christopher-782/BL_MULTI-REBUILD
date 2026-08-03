# BL Multi Concept — Rebuild Step 1

This is the clean foundation for the vanilla HTML/CSS/JavaScript + Supabase rebuild.

## What Step 1 contains

- Responsive login UI
- Supabase JavaScript client
- Email/password sign-in
- Auth session guard
- Protected dashboard shell
- PostgreSQL `profiles` table
- Roles and account statuses
- Row Level Security (RLS)
- No financial tables yet (intentional)

## 1. Create a Supabase project

Create the project in Supabase, then copy:

- Project URL
- Publishable key (`sb_publishable_...`)

Do **not** use a secret key or service-role key in frontend JavaScript.

## 2. Run the database foundation

Open Supabase Dashboard -> SQL Editor and run:

`supabase/001_foundation.sql`

Run it once on a fresh project.

## 3. Add your Supabase browser configuration

Open:

`assets/js/config/supabase-config.js`

Replace the placeholder URL and publishable key.

## 4. Create the first Auth user

In Supabase Dashboard -> Authentication -> Users, create your first user with email/password.

The SQL trigger automatically creates that user's `profiles` row with role `staff`.

For the first administrator only, use the SQL Editor to promote the exact user UUID:

```sql
update public.profiles
set role = 'super_admin'
where id = 'PASTE-THE-AUTH-USER-UUID-HERE';
```

Do not build a public "choose your role" signup form.

## 5. Run through a local web server

Do not double-click the HTML files and run them as `file://` URLs.

Use VS Code Live Server, or from this folder run:

```bash
python -m http.server 5500
```

Then open:

`http://localhost:5500/login.html`

## Step 1 acceptance test

Step 1 is complete only when all of these work:

1. Wrong login shows a generic error.
2. Correct login opens `dashboard.html`.
3. Refreshing the dashboard keeps the user signed in.
4. Opening dashboard while signed out redirects to login.
5. The user's name and role display on the dashboard.
6. Logout returns to login and the protected page can no longer be opened.
7. A browser user cannot update their own `role` or `status` directly.

## Next build step

Step 2 will harden authorization and administration:

- permissions model
- first admin workflow
- staff creation/invitation
- suspended account enforcement
- audit logging foundation
- protected role-management functions

## Existing Auth user but "staff profile is not ready"

If an Auth user was created before `001_foundation.sql` installed the profile trigger, run:

`supabase/003_repair_missing_profiles.sql`

This safely creates missing `public.profiles` rows for existing `auth.users`. It can be run more than once.
