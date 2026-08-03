# Dashboard Loader Hotfix

Root cause: `dashboard.html` did not load `@supabase/supabase-js@2`.

The app's `assets/js/config/supabase.js` requires `window.supabase.createClient`.
Without the CDN script the dashboard module failed during import, before the
clock, session UI, KPI summary, recent transactions, or recent expenses ran.

Changes:
- Added Supabase JS v2 CDN loader before dashboard module.
- Cache-busted dashboard CSS/JS references.
- Added visible runtime startup error reporting.
- No SQL changes required for this hotfix.
