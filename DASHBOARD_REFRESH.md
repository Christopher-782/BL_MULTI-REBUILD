# BL Multi Concept — Enterprise Dashboard Refresh

This patch redesigns only the dashboard experience.

It is based on the current Step 7 project and preserves all dashboard IDs used
by the existing Supabase data layer.

## What changed

The old dashboard was visually repetitive:
- 9 similar metric cards
- 5 separate approval cards
- 2 generic table panels

The new structure is intentionally flatter and more operational:

1. Executive portfolio summary
2. Today's money movement in one dark-blue control surface
3. Compact row-based approval queue
4. Quick access bar for core operations
5. Recent transactions
6. Recent expenses
7. End-of-day staff reconciliation callout

## Design direction

- Dark navy + restrained blue
- Flat enterprise surfaces
- Thin dividers
- 7–9px corners rather than large rounded cards
- Minimal shadows
- No decorative gradient card collection
- Clear information hierarchy
- Responsive desktop/tablet/mobile layout

## Preserved data IDs

- activeCustomers
- customerFunds
- overdraftExposure
- loanOutstanding
- todayDeposits
- todayWithdrawals
- todayRevenue
- todayExpenses
- todayOperationalNet
- pendingTotal
- pendingTransactions
- pendingLoans
- pendingRepayments
- pendingOverdrafts
- pendingExpenses
- recentTransactionsBody
- recentExpensesBody
- refreshDashboard
- pageMessage

## Install

Overlay these files into the current Step 7 project:

- dashboard.html
- assets/css/app.css
- assets/js/pages/dashboard.js

No SQL migration is required.
