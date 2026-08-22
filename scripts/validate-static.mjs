import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const publicRoot = join(root, 'public');
const failures = [];
let checkedJavaScript = 0;
let checkedReferences = 0;

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function fail(message) {
  failures.push(message);
}

function localTarget(sourceFile, value) {
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('data:') ||
    value.startsWith('mailto:') ||
    value.startsWith('tel:') ||
    /^[a-z]+:/i.test(value) ||
    value.startsWith('//')
  ) {
    return null;
  }

  const clean = value.split('#')[0].split('?')[0];
  if (!clean) return null;
  return clean.startsWith('/')
    ? join(publicRoot, clean.slice(1))
    : normalize(join(dirname(sourceFile), clean));
}

const publicFiles = walk(publicRoot);
const JavaScriptFiles = publicFiles.filter((path) => extname(path) === '.js');

for (const file of JavaScriptFiles) {
  checkedJavaScript += 1;
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    fail(`${relative(root, file)} failed JavaScript syntax validation: ${result.stderr.trim()}`);
  }

  const source = readFileSync(file, 'utf8');
  const imports = source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g);
  for (const match of imports) {
    const target = localTarget(file, match[1]);
    if (!target) continue;
    checkedReferences += 1;
    if (!existsSync(target)) {
      fail(`${relative(root, file)} imports missing file ${match[1]}`);
    }
  }
}

for (const file of publicFiles.filter((path) => extname(path) === '.html')) {
  const source = readFileSync(file, 'utf8');
  const references = source.matchAll(/(?:href|src)=["']([^"']+)["']/g);

  for (const match of references) {
    const target = localTarget(file, match[1]);
    if (!target) continue;
    checkedReferences += 1;
    if (!existsSync(target)) {
      fail(`${relative(root, file)} references missing file ${match[1]}`);
    }
  }

  if (source.includes('@supabase/supabase-js@2"')) {
    fail(`${relative(root, file)} uses an unpinned Supabase client version`);
  }

  if (
    source.includes('@supabase/supabase-js@') &&
    !source.includes('integrity="sha384-')
  ) {
    fail(`${relative(root, file)} is missing Supabase script integrity metadata`);
  }
}

for (const file of JavaScriptFiles.filter((path) => path.includes('/assets/js/pages/'))) {
  if (/\.innerHTML\s*=/.test(readFileSync(file, 'utf8'))) {
    fail(`${relative(root, file)} contains a dynamic innerHTML assignment`);
  }
}

const transactionHtml = readFileSync(join(publicRoot, 'transactions.html'), 'utf8');
for (const id of [
  'filteredTotalsTitle',
  'filteredTransactionCount',
  'filteredGrossAmount',
  'filteredChargeAmount',
  'filteredNetAmount',
]) {
  if (!transactionHtml.includes(`id="${id}"`)) {
    fail(`transactions.html is missing #${id}`);
  }
}

const hardeningMigration = readFileSync(
  join(root, 'supabase', '018_production_hardening.sql'),
  'utf8',
);

for (const requirement of [
  'idempotency_key',
  'get_filtered_transaction_totals',
  'search_transaction_customers',
  'pg_advisory_xact_lock',
  "status = 'processing'",
]) {
  if (!hardeningMigration.includes(requirement)) {
    fail(`production hardening migration is missing ${requirement}`);
  }
}

if (existsSync(join(root, 'BLSUPABASE.txt'))) {
  fail('BLSUPABASE.txt must not be included in a deployment package');
}

if (existsSync(join(root, 'supabase', '.temp'))) {
  const remaining = walk(join(root, 'supabase', '.temp'));
  if (remaining.length > 0) {
    fail('supabase/.temp contains local project metadata');
  }
}

for (const path of [
  'assets/js/pages/transactions.js',
  'assets/js/services/transactions.service.js',
  'assets/css/app.css',
  'transactions.html',
]) {
  const source = join(root, path);
  const published = join(publicRoot, path);
  if (
    !existsSync(source) ||
    !existsSync(published) ||
    readFileSync(source, 'utf8') !== readFileSync(published, 'utf8')
  ) {
    fail(`${path} is not synchronized with the public deployment copy`);
  }
}

if (failures.length > 0) {
  console.error(`Validation failed with ${failures.length} issue(s):`);
  for (const issue of failures) console.error(`- ${issue}`);
  process.exit(1);
}

console.log(
  `Validated ${checkedJavaScript} JavaScript files and ${checkedReferences} local references.`,
);
console.log('Production hardening checks passed.');
