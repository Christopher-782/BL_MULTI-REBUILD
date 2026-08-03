# BL Multi Concept — Professional UI V3

This package updates the presentation layer while preserving the working
Supabase/data/authentication architecture.

## Main design changes

- Manrope font across the application
- Tabular numerals for financial values
- Unified dark-blue / blue corporate theme
- Narrower, more disciplined sidebar
- Smaller professional corner radii
- Reduced shadows and gradients
- Cleaner KPI hierarchy
- Consistent forms and focus states
- Sticky table headers
- Cleaner transaction / loan / expense registers
- More professional dialogs
- Responsive mobile navigation
- Automatic active navigation based on current URL
- Dynamic staff initials
- Live search clear control and `/` search shortcut
- Subtle page entrance motion with `prefers-reduced-motion` support
- Dashboard mobile sidebar now works instead of disappearing

## Files changed

- assets/css/base.css
- assets/css/app.css
- assets/css/dashboard.css
- assets/js/ui/shell.js
- dashboard-redesigned.js
- dashboard.html
- staff.html
- customers.html
- customer.html
- transactions.html
- loans.html
- loan.html
- overdrafts.html
- expenses.html
- reports.html

No SQL migration is required.

The reconciliation route remains referenced by the redesigned dashboard, but
this uploaded project still does not contain reconciliation.html. This UI
package does not invent backend reconciliation logic.
