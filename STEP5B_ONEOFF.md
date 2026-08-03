# Step 5B Patch — One-off Overdraft Flow

Run:

`supabase/011_one_off_overdraft_flow.sql`

after `010_overdrafts.sql`.

## Business rule implemented

Example:

- Customer account balance: ₦5,000
- Customer requests payout: ₦10,000
- Manual overdraft charge: ₦1,000

On approval:

- The customer receives / is paid ₦10,000.
- The account is debited by ₦10,000.
- Account balance becomes -₦5,000.
- Overdraft exposure is ₦5,000.
- The ₦1,000 charge is recorded separately as overdraft charge revenue.

The charge does NOT:
- make the account -₦6,000,
- reduce the payout to ₦9,000,
- create another account debit.

## Normal withdrawal vs overdraft

If the customer has enough balance for the requested payout, the system refuses
to create an overdraft request and instructs staff to use a normal withdrawal.

Example:
- Balance ₦20,000
- Requested payout ₦10,000
- Result would be ₦10,000 positive
=> normal withdrawal.

## Approval-time check

The database uses the CURRENT account balance when the overdraft is approved.

Example:
- Request created when balance is ₦5,000.
- Before approval customer deposits ₦20,000.
- Current balance becomes ₦25,000.
- A ₦10,000 payout would no longer create an overdraft.
=> approval is refused; use normal withdrawal instead.

## Clearing the overdraft

Deposits naturally reduce a negative balance.

Example:
- Balance -₦5,000
- Approved net deposit ₦3,000
- New balance -₦2,000

Then:
- Approved net deposit ₦2,000
- New balance ₦0
- Active overdraft record is automatically closed.

## Charges

The overdraft charge is manually entered.

No percentage, minimum, maximum, or automatic charge amount is imposed in this patch.
