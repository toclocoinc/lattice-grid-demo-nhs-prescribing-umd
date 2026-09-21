/**
 * Build the saved copy in `data/snapshot`.
 *
 * The page does not need this to show live data: the endpoint answers browser
 * requests, and every view on the page is a live query. The saved copy exists
 * so the page has something true on it in the first second, before the first
 * query has come back, and so it still has something true on it when the
 * endpoint is down. Nothing in it is synthetic: every figure was returned by
 * the same endpoint the page queries, and `meta.json` records when.
 *
 * It also records something the page cannot work out for itself in one
 * request: which column flavour each month uses. The publisher renamed several
 * columns in March 2025, so a query written for the newest month is refused by
 * an older one. Reading the real column list of every saved month here, once a
 * night, is what lets the page ask for a two year trend in one statement.
 *
 * Usage: node tools/build-snapshot.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEpdData } from './epd-module.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'data', 'snapshot');

const EpdData = await loadEpdData();

/** How many months of history the page offers, and the trend covers. */
const MONTHS = 24;
/** How many substances the saved copy holds for the latest month. */
const TOP_SUBSTANCES = 500;
/** The substance the trend chart opens on. */
const DEFAULT_SUBSTANCE = 'Atorvastatin';

/** One request to the action API, as JSON. */
async function api(path) {
  const response = await fetch(EpdData.API + path, { headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success === false) {
    throw new Error('the action API answered HTTP ' + response.status + ' for ' + path);
  }
  return body;
}

/** One SQL statement, timed, with the truncation guard the page uses. */
async function sql(statement, label) {
  const url = EpdData.SQL_URL
    + '?resource_id=' + encodeURIComponent(statement.resource)
    + '&sql=' + encodeURIComponent(statement.sql);
  const started = Date.now();
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => null);
  const ms = Date.now() - started;
  const inner = body && body.result && body.result.result;
  const records = inner && inner.records;
  if (!response.ok || !records || String(inner.records_truncated) === 'true') {
    const reason = (body && body.error && body.error.message) || ('HTTP ' + response.status);
    throw new Error(label + ' failed: ' + reason);
  }
  console.log('  ' + label.padEnd(34) + String(ms + ' ms').padStart(9) + '  ' + records.length + ' rows');
  return { records, ms };
}

/** Which flavour a month's columns are, read from the month itself. */
async function flavourOf(resource) {
  const body = await api('/datastore_search?resource_id=' + encodeURIComponent(resource) + '&limit=0');
  const fields = (body.result.fields || []).map((field) => field.id);
  const has = (name) => fields.includes(name);
  if (has('BNF_PRESENTATION_NAME')) return 'current';
  if (has('STP_NAME')) return 'early';
  return 'legacy';
}

console.log('Reading the dataset...');
const pkg = await api('/package_show?id=' + EpdData.DATASET);
const names = (pkg.result.resources || [])
  .map((resource) => resource.name)
  .filter((name) => /^EPD_SNOMED_\d{6}$/.test(name))
  .sort()
  .reverse();
if (!names.length) throw new Error('the dataset lists no monthly tables');

const monthOf = (name) => name.slice(-6, -2) + '-' + name.slice(-2);
const months = names.slice(0, MONTHS).map(monthOf);
const latest = months[0];
const yearAgo = EpdData.yearBefore(latest);

console.log('  ' + names.length + ' monthly tables, newest ' + latest);

console.log('Reading each month\'s column flavour...');
const schemaMap = {};
for (const month of months) {
  schemaMap[month] = await flavourOf(EpdData.resourceFor(month));
}
const flavours = {};
for (const month of months) flavours[schemaMap[month]] = (flavours[schemaMap[month]] || 0) + 1;
console.log('  ' + Object.entries(flavours).map(([k, v]) => v + ' ' + k).join(', '));

console.log('Querying ' + latest + '...');
const totals = (await sql(EpdData.totalsSql(latest), 'totals for ' + latest)).records[0];
let yearAgoTotals = null;
if (months.includes(yearAgo)) {
  yearAgoTotals = (await sql(EpdData.totalsSql(yearAgo), 'totals for ' + yearAgo)).records[0];
}

const substances = (await sql({
  resource: EpdData.resourceFor(latest),
  sql: EpdData.rowsSql({
    month: latest, level: 'substance', schemaMap, filters: null, quick: '',
    sort: [{ col: 'cost', dir: 'desc' }], start: 0, end: TOP_SUBSTANCES,
  }).sql,
}, 'top ' + TOP_SUBSTANCES + ' substances')).records;

const substanceCount = (await sql(EpdData.countSql({
  month: latest, level: 'substance', schemaMap, filters: null, quick: '', sort: [],
}), 'substances in the month')).records[0];

const chapters = (await sql(EpdData.chapterSql(latest, 20), 'chapters by cost')).records;
const icbs = (await sql(EpdData.icbSql(latest, schemaMap), 'care boards by cost')).records;

const trendStatement = EpdData.trendSql(DEFAULT_SUBSTANCE, months, schemaMap);
let trend = [];
let trendMs = null;
try {
  const answer = await sql(trendStatement, 'two year trend, one statement');
  trend = answer.records;
  trendMs = answer.ms;
} catch (error) {
  /* The multi month statement is a measured behaviour of the endpoint rather
     than a documented one. If it is ever refused, the saved copy simply holds
     no trend and the page asks for the months one at a time. */
  console.log('  the multi month statement was refused: ' + error.message);
}

const meta = {
  builtAt: new Date().toISOString(),
  endpoint: EpdData.SQL_URL,
  dataset: EpdData.DATASET,
  latest,
  yearAgo: yearAgoTotals ? yearAgo : null,
  months,
  monthsAvailable: names.length,
  schemaMap,
  defaultSubstance: DEFAULT_SUBSTANCE,
  rowsInLatestMonth: Number(totals.prescriptions),
  substancesInLatestMonth: Number(substanceCount.n),
  totals: {
    items: Number(totals.items),
    cost: Number(totals.cost),
    quantity: Number(totals.quantity),
    practices: Number(totals.practices),
    prescriptions: Number(totals.prescriptions),
  },
  yearAgoTotals: yearAgoTotals ? {
    items: Number(yearAgoTotals.items),
    cost: Number(yearAgoTotals.cost),
    quantity: Number(yearAgoTotals.quantity),
    practices: Number(yearAgoTotals.practices),
    prescriptions: Number(yearAgoTotals.prescriptions),
  } : null,
  counts: {
    substances: substances.length,
    chapters: chapters.length,
    icbs: icbs.length,
    trend: trend.length,
  },
  trendMs,
};

await mkdir(out, { recursive: true });
const files = [
  ['meta.json', meta],
  ['substances.json', substances],
  ['chapters.json', chapters],
  ['icbs.json', icbs],
  ['trend.json', trend],
];
for (const [name, body] of files) {
  const text = JSON.stringify(body, null, name === 'meta.json' ? 1 : 0);
  await writeFile(join(out, name), text + '\n');
  console.log('  wrote ' + name.padEnd(18) + (text.length / 1024).toFixed(1) + ' KB');
}

console.log('\nSaved copy built from ' + latest + ': '
  + meta.rowsInLatestMonth.toLocaleString('en-GB') + ' rows in the month, '
  + substances.length + ' substances saved.');
