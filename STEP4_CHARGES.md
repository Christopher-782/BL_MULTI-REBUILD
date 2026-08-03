# Step 4 patch — customer-number search and deposit charges

Run `supabase/008_customer_search_deposit_charges.sql` AFTER
`007_financial_ledger_transactions.sql`.

Changes:
- New transaction lookup is by customer number (e.g. 001), not account number.
- If the customer has multiple accounts, staff select the account after lookup.
- Deposit form has Gross Amount, Charges and calculated Net Amount.
- Approved deposit posting = gross deposit - charge.
- Charge is mandatory when the selected account is currently at zero and:
  1. it has stayed at zero for more than 7 days, OR
  2. a full approved withdrawal reduced it to zero.
- The database re-checks the rule at approval time.
- Charges are stored separately on the transaction and included in audit metadata.
- Ledger entries contain the actual net posting amount.
- A full withdrawal sets the zero-balance charge flag immediately.
- A successful deposit clears the zero-balance charge flag.
- Existing transactions are backfilled with zero charge and net = amount.

No fixed charge value is imposed. When a charge is mandatory it must be > 0 and
less than the gross deposit.
