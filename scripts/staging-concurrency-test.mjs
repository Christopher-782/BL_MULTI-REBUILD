import process from 'node:process';
import { randomUUID } from 'node:crypto';

const {
  ALLOW_STAGING_MUTATION,
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  STAFF_ACCESS_TOKEN,
  MANAGER_ACCESS_TOKEN,
  TEST_ACCOUNT_ID,
  TEST_TRANSACTION_TYPE = 'deposit',
  TEST_AMOUNT_MINOR = '100',
  TEST_CHARGE_MINOR = '0',
  TEST_CONCURRENCY = '5',
} = process.env;

if (ALLOW_STAGING_MUTATION !== 'yes') {
  throw new Error(
    'This test creates and may approve real transactions. Run only in staging with ALLOW_STAGING_MUTATION=yes.',
  );
}

for (const [name, value] of Object.entries({
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  STAFF_ACCESS_TOKEN,
  TEST_ACCOUNT_ID,
})) {
  if (!value) throw new Error(`${name} is required.`);
}

const concurrency = Math.min(Math.max(Number(TEST_CONCURRENCY) || 5, 2), 20);
const endpoint = SUPABASE_URL.replace(/\/$/, '');

async function rpc(name, body, accessToken) {
  const response = await fetch(`${endpoint}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${name} failed with HTTP ${response.status}: ${payload?.message || JSON.stringify(payload)}`,
    );
  }

  return payload;
}

function transactionRequest(idempotencyKey, label) {
  return {
    p_account_id: TEST_ACCOUNT_ID,
    p_type: TEST_TRANSACTION_TYPE,
    p_amount_minor: TEST_AMOUNT_MINOR,
    p_charge_minor: TEST_CHARGE_MINOR,
    p_description: `Staging concurrency test ${label}`,
    p_idempotency_key: idempotencyKey,
  };
}

const duplicateKey = randomUUID();
const duplicateRequest = transactionRequest(duplicateKey, 'idempotency');
const duplicateResults = await Promise.all(
  Array.from(
    { length: concurrency },
    () => rpc('initiate_transaction', duplicateRequest, STAFF_ACCESS_TOKEN),
  ),
);

const duplicateIds = new Set(duplicateResults.map((item) => item.id));
if (duplicateIds.size !== 1) {
  throw new Error(
    `Idempotency failed: ${duplicateIds.size} transaction IDs were created for one request key.`,
  );
}

const parallelRequests = Array.from({ length: concurrency }, (_, index) =>
  transactionRequest(randomUUID(), `parallel-${index + 1}`)
);
const parallelResults = await Promise.all(
  parallelRequests.map((request) =>
    rpc('initiate_transaction', request, STAFF_ACCESS_TOKEN)
  ),
);

const parallelIds = new Set(parallelResults.map((item) => item.id));
if (parallelIds.size !== concurrency) {
  throw new Error(
    `Parallel initiation failed: expected ${concurrency} unique transactions and received ${parallelIds.size}.`,
  );
}

console.log(
  `Idempotency passed: ${concurrency} simultaneous retries produced one transaction.`,
);
console.log(
  `Parallel initiation passed: ${concurrency} unique requests produced ${parallelIds.size} transactions.`,
);

if (!MANAGER_ACCESS_TOKEN) {
  console.log(
    'MANAGER_ACCESS_TOKEN was not provided. Parallel approval was skipped and the staging transactions remain pending.',
  );
  process.exit(0);
}

const approvals = await Promise.allSettled(
  [...parallelIds, ...duplicateIds].map((transactionId) =>
    rpc(
      'approve_transaction',
      { p_transaction_id: transactionId },
      MANAGER_ACCESS_TOKEN,
    )
  ),
);

const rejected = approvals.filter((result) => result.status === 'rejected');
if (rejected.length > 0) {
  for (const result of rejected) {
    console.error(result.reason?.message || result.reason);
  }
  throw new Error(
    `Parallel approval failed for ${rejected.length} of ${approvals.length} staging transactions.`,
  );
}

console.log(
  `Parallel approval passed for all ${approvals.length} staging transactions.`,
);
