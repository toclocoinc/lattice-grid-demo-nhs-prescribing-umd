/**
 * Load the demo in a real browser and check that it works.
 *
 * It depends on jsDelivr, because that is where the page gets the grid from:
 * this edition has no local copy of the library at all, and a check that
 * loaded one would not be checking the page.
 *
 * By default it also depends on the NHSBSA endpoint, because the page does:
 * the thing this demo exists to show is a grid driving a remote SQL database,
 * and a check that never let it do so would be checking a different page. What
 * the grid sent is read back out of the browser and compared with what the
 * page's own SQL builder writes here in Node, so the check is that the browser
 * sent the statement the builder wrote, not that two hand written strings
 * match.
 *
 * `OFFLINE=1` runs the same page with the endpoint unreachable, and asserts
 * the two honest outcomes: with the live view switched off it makes no request
 * at all and shows the saved copy, and with the live view on it tries, fails,
 * says so, and keeps the saved copy rather than showing nothing or something
 * invented. That mode needs no NHSBSA at all, so a CI run is never red because
 * somebody else's service is down.
 *
 * Beyond "it drew something", it asserts:
 *
 *   - the library arrived by classic script tag: no `type="module"` script,
 *     every library tag points at the pinned release with an integrity hash,
 *     and each left the global it documents, including the pushdown factory;
 *   - the main grid paints rows that came from the endpoint, and its row count
 *     is the count the endpoint gives when asked here;
 *   - searching, sorting, changing what a row is and changing the month each
 *     change the statement AND change the rows, which is what "pushed down"
 *     means and what a page that quietly filtered in the browser would fail;
 *   - scrolling asks for a second window with a non-zero OFFSET;
 *   - the totals row and the tiles agree with queries run here;
 *   - no tool rail, no column menu, no filter funnel, no cell range, no fill
 *     handle, nothing reading "NaN", and no em dash;
 *   - at 400px wide the page does not scroll sideways and the grid still
 *     paints rows.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--shots <dir>]
 *        OFFLINE=1 node tools/verify.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { loadEpdData } from './epd-module.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const OFFLINE = process.env.OFFLINE === '1';

/** The release every library tag must name, and the globals each file leaves. */
const GRID_VERSION = '1.66.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createPushdownSource' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];
/** The distinct files among those tags. */
const LIBRARY_FILES = [...new Set(LIBRARY_TAGS.map((tag) => tag.file))];

/** The host the page queries, for the offline run and the request tally. */
const ENDPOINT_HOST = 'opendata.nhsbsa.net';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

/** This check needs Node's built-in WebSocket, which arrived in Node 22. */
function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`,
    );
  }
}

/** A free TCP port, asked of the operating system. */
function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

/** The part of a statement that is not the window: everything before LIMIT. */
const shapeOf = (sql) => String(sql || '').split(' LIMIT ')[0].trim();

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const EpdData = await loadEpdData();
  const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
  const savedSubstances = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'substances.json'), 'utf8'));

  /** Run one statement here in Node, so a page figure is checked against something else. */
  async function ask(statement, label) {
    const url = `${EpdData.SQL_URL}?resource_id=${encodeURIComponent(statement.resource)}`
      + `&sql=${encodeURIComponent(statement.sql)}`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    const inner = body && body.result && body.result.result;
    if (!response.ok || !inner || !inner.records) {
      throw new Error(`${label}: the endpoint answered ${response.status}`);
    }
    return inner.records;
  }

  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);
  console.log(`Mode:    ${OFFLINE ? 'offline, the endpoint is blocked' : 'live, the page queries the endpoint'}`);
  console.log(`Saved:   built ${meta.builtAt}; ${meta.latest}; `
    + `${savedSubstances.length} substances; ${meta.rowsInLatestMonth.toLocaleString('en-GB')} rows in the month`);

  profile = await mkdtemp(join(tmpdir(), 'nhs-prescribing-verify-'));
  const port = await freePort();
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];
  let endpointRequests = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
    if (message.method === 'Network.requestWillBeSent') {
      const url = message.params.request.url || '';
      if (url.includes(ENDPOINT_HOST)) endpointRequests.push(url);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Network.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open the page with a clean error log and wait for it to finish settling. */
  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    endpointRequests = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__prescribingDemo && window.__prescribingDemo.ready_)', 150000, `${label} to settle`);
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label, allow) => {
    const permitted = allow || (() => false);
    const bad = consoleErrors.filter((text) => !permitted(text));
    check(bad.length === 0, `${label}: no console errors`, bad.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /** What the page is showing, and what it last sent. */
  const READ = `(() => {
    const d = window.__prescribingDemo;
    if (!d || !d.mainGrid) return { built: false, error: (d && d.error) || 'the page left no dashboard behind' };
    const host = document.querySelector('.primary-host');
    const gridRoot = host && host.querySelector('.lattice');
    const viewport = gridRoot && gridRoot.querySelector('.lat-body-viewport');
    const rows = d.mainGrid.rows.data();
    return {
      built: true,
      isLive: !!d.isLive,
      error: d.lastError || null,
      month: d.view.month,
      level: d.view.level,
      substance: d.view.substance,
      count: d.mainGrid.rows.count(),
      first: rows[0] ? { name: rows[0].name, cost: rows[0].cost, items: rows[0].items } : null,
      names: rows.slice(0, 5).map((r) => r.name),
      dataRows: viewport ? viewport.querySelectorAll('.lat-row[data-index]').length : 0,
      bodyCells: viewport ? viewport.querySelectorAll('[role="gridcell"]').length : 0,
      columnHeaders: gridRoot ? gridRoot.querySelectorAll('[role="columnheader"]').length : 0,
      headings: gridRoot ? [...gridRoot.querySelectorAll('[role="columnheader"]')].map((c) => c.textContent.trim()) : [],
      pinned: d.mainGrid.getPinnedRows({ edge: 'bottom' }),
      queries: (d.queries || []).map((q) => ({ label: q.label, sql: q.sql, rows: q.rows, ms: q.ms, source: q.source, error: q.error || null })),
      status: (document.querySelector('.freshness') || {}).textContent || '',
      pill: (document.querySelector('.pill') || {}).textContent || '',
      notice: (() => { const n = document.querySelector('.notice'); return n && !n.hidden ? n.textContent : null; })(),
      sqlOnPage: [...document.querySelectorAll('.query-sql')].map((p) => p.textContent),
      tiles: d.kpi ? d.kpi.tiles().map((t) => ({ id: t.id, value: t.value, formatted: t.formatted, delta: t.delta })) : [],
    };
  })()`;

  /** The statement the page's own builder writes for the state on screen. */
  const expectedRowsSql = (state) => EpdData.rowsSql(state).sql;

  /* =================================================================== */
  /* 1. How the library arrived. The same either way.                     */
  /* =================================================================== */

  await open(`${origin}/index.html${OFFLINE ? '?live=0' : ''}`, OFFLINE ? 'the page, live view off' : 'the page, live');

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.jsdelivr\\.net/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.jsdelivr\\.net/.test(s.src) && s.integrity).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).href || null,
      stylesheetIntegrity: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).integrity || null,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        createPushdownSource: typeof (window.LatticeGrid || {}).createPushdownSource,
        setLicence: typeof (window.LatticeGrid || {}).setLicence,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity hash; `
    + `module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(delivery.librarySrcs.length === LIBRARY_FILES.length,
    `delivery: ${LIBRARY_FILES.length} library script tags point at the CDN`, `${delivery.librarySrcs.length}`);
  for (const file of LIBRARY_FILES) {
    check(delivery.librarySrcs.includes(`${CDN_BASE}${file}`),
      `delivery: ${file} is loaded from the pinned ${GRID_VERSION} release`, `${CDN_BASE}${file}`);
  }
  for (const tag of LIBRARY_TAGS) {
    check(delivery.members[tag.member] === 'function',
      `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === LIBRARY_FILES.length, 'delivery: every library tag carries an integrity hash',
    `${delivery.withIntegrity} of ${LIBRARY_FILES.length}`);
  check(delivery.stylesheetSrc === `${CDN_BASE}lattice-grid.min.css`,
    `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`, delivery.stylesheetSrc);
  check(!!delivery.stylesheetIntegrity, 'delivery: the stylesheet carries an integrity hash');

  /* =================================================================== */
  /* 2. The page, however it was opened.                                  */
  /* =================================================================== */

  if (OFFLINE) {
    /* ---- the live view switched off: no request is made at all ---- */

    const off = await evaluate(READ);
    check(off.built === true, 'the page built its dashboard', off.built ? '' : String(off.error));
    if (!off.built) throw new Error(`the page did not build: ${off.error}`);
    console.log(`  live view off: ${off.count} rows, pill "${off.pill}", ${endpointRequests.length} requests to ${ENDPOINT_HOST}`);
    check(off.isLive === false, 'live view off: the page says it is not live', `isLive ${off.isLive}`);
    check(endpointRequests.length === 0, `live view off: nothing was requested from ${ENDPOINT_HOST}`,
      `${endpointRequests.length} requests`);
    check(off.count === savedSubstances.length, 'live view off: the grid holds the saved copy',
      `${off.count} rows, expected ${savedSubstances.length}`);
    check(off.dataRows > 0, 'live view off: the grid paints data rows', `${off.dataRows}`);
    check(off.pinned.length === 1 && /saved copy/i.test(off.pinned[0].name),
      'live view off: the totals row says it is the saved copy', off.pinned[0] && off.pinned[0].name);
    check(/saved copy/i.test(off.pill), 'live view off: the badge says saved copy', off.pill);
    check(off.tiles.length === 4, 'live view off: the four tiles are drawn from the saved totals', `${off.tiles.length}`);
    const offControls = await evaluate(`(() => {
      const ids = ['.controls select', '.controls input', '.controls button'];
      const all = ids.flatMap((sel) => [...document.querySelectorAll(sel)]);
      return { total: all.length, disabled: all.filter((e) => e.disabled).length };
    })()`);
    check(offControls.total > 0 && offControls.disabled === offControls.total,
      'live view off: every control is off, because every one of them is a query',
      `${offControls.disabled} of ${offControls.total}`);
    check(!!off.notice && /controls above are off/i.test(off.notice),
      'live view off: and the page says why', off.notice);
    const savedItems = off.tiles.find((t) => t.id === 'items');
    check(!!savedItems && near(Number(savedItems.value), meta.totals.items, 1e-9),
      'live view off: the items tile is the saved figure',
      `${savedItems && savedItems.value}, expected ${meta.totals.items}`);
    noErrors('live view off');
    await shoot('05-offline-live-off');

    /* ---- the endpoint blocked: it tries, fails, and says so ---- */

    await call('Network.setBlockedURLs', { urls: [`*${ENDPOINT_HOST}*`] });
    await open(`${origin}/index.html`, 'the page with the endpoint blocked');

    const blocked = await evaluate(READ);
    console.log(`  blocked: isLive ${blocked.isLive}, ${blocked.count} rows, notice "${String(blocked.notice).slice(0, 90)}"`);
    check(blocked.isLive === false, 'blocked: the page does not claim to be live', `isLive ${blocked.isLive}`);
    check(endpointRequests.length > 0, 'blocked: the page did try the endpoint', `${endpointRequests.length} attempts`);
    check(blocked.count === savedSubstances.length, 'blocked: the saved copy is still on screen',
      `${blocked.count} rows, expected ${savedSubstances.length}`);
    check(blocked.dataRows > 0, 'blocked: the grid still paints data rows', `${blocked.dataRows}`);
    check(!!blocked.notice && /did not answer/i.test(blocked.notice),
      'blocked: the page says the endpoint did not answer', blocked.notice);
    check(!!blocked.notice && /no figure on this page is invented/i.test(blocked.notice),
      'blocked: and says no figure was invented', blocked.notice);
    check(blocked.tiles.length === 4, 'blocked: the tiles are still the saved figures', `${blocked.tiles.length}`);
    const blockedNan = await evaluate(`(() => {
      const bad = [];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walk.nextNode())) if (/\\bNaN\\b/.test(node.nodeValue || '')) bad.push((node.nodeValue || '').trim().slice(0, 60));
      return bad.slice(0, 5);
    })()`);
    check(blockedNan.length === 0, 'blocked: nothing on the page reads "NaN"', blockedNan.join(' | '));
    /* A blocked request is logged by the browser itself. That is the thing
       being tested, so it is the one message this run tolerates. */
    noErrors('blocked', (text) => /ERR_BLOCKED_BY_CLIENT|Failed to load resource/i.test(text));
    await shoot('06-offline-blocked');
    await call('Network.setBlockedURLs', { urls: [] });
  } else {
    /* ---- it went live ---- */

    const live = await evaluate(READ);
    check(live.built === true, 'the page built its dashboard', live.built ? '' : String(live.error));
    if (!live.built) throw new Error(`the page did not build: ${live.error}`);
    console.log(`  live: ${live.count} rows at level "${live.level}" for ${live.month}, `
      + `${live.dataRows} painted, ${live.queries.length} statements sent`);
    for (const q of live.queries.slice().reverse()) {
      console.log(`    ${String(q.label).padEnd(30)} ${String(q.ms + ' ms').padStart(8)}  ${q.rows} rows  ${q.source}`);
    }
    check(live.isLive === true, 'the page went live against the endpoint', `isLive ${live.isLive}, error ${live.error}`);
    check(live.error === null, 'and reported no failure', String(live.error));
    check(/Live from opendata\.nhsbsa\.net/.test(live.status), 'the status line names the endpoint', live.status);
    check(/rows in /.test(live.status), 'and how many rows the month holds', live.status);
    check(/^live$/i.test(live.pill.trim()), 'the badge says live', live.pill);
    check(live.notice === null, 'no failure notice is showing', String(live.notice));
    check(live.dataRows > 0, 'the main grid painted data rows', `${live.dataRows}`);
    check(live.bodyCells > 0, 'the main grid painted cells', `${live.bodyCells}`);
    check(live.columnHeaders > 0, 'the main grid drew a column header row', `${live.columnHeaders}`);
    check(endpointRequests.length > 0, `the page really did call ${ENDPOINT_HOST}`, `${endpointRequests.length} requests`);

    /* The row count is the endpoint's own answer, asked again from here. */
    const countState = {
      month: live.month, level: live.level, schemaMap: meta.schemaMap,
      filters: null, quick: '', sort: [],
    };
    const counted = Number((await ask(EpdData.countSql(countState), 'the substance count'))[0].n);
    check(live.count === counted, 'the grid holds exactly as many rows as the endpoint says match',
      `${live.count} on the page, ${counted} from a query run here`);
    check(live.count !== savedSubstances.length || counted === savedSubstances.length,
      'and that number is the live one, not the length of the saved copy',
      `${live.count} vs ${savedSubstances.length} saved`);

    /* ---- the statement the grid sent is the one the builder writes ---- */

    const rowsQuery = live.queries.find((q) => q.label === 'grid rows');
    const expected = expectedRowsSql({
      month: live.month, level: live.level, schemaMap: meta.schemaMap,
      filters: null, quick: '', sort: [{ col: 'cost', dir: 'desc' }], start: 0, end: 100,
    });
    console.log(`  the statement the grid sent:\n    ${rowsQuery && rowsQuery.sql}`);
    check(!!rowsQuery, 'the grid sent a row query');
    check(!!rowsQuery && shapeOf(rowsQuery.sql) === shapeOf(expected),
      'and it is the statement the page\'s own builder writes for that state',
      rowsQuery ? `sent ${shapeOf(rowsQuery.sql).slice(0, 110)}` : 'none');
    check(!!rowsQuery && /GROUP BY name/.test(rowsQuery.sql), 'the statement groups in the engine', 'GROUP BY name');
    check(!!rowsQuery && /LIMIT \d+ OFFSET \d+/.test(rowsQuery.sql), 'and takes a window rather than everything',
      (rowsQuery.sql.match(/LIMIT \d+ OFFSET \d+/) || [])[0]);
    check(live.sqlOnPage.some((text) => text === (rowsQuery && rowsQuery.sql)),
      'the query panel shows that statement, character for character');

    /* ---- searching goes to the endpoint ---- */

    const searched = await evaluate(`(async () => {
      const d = window.__prescribingDemo;
      const before = { count: d.mainGrid.rows.count(), first: (d.mainGrid.rows.data()[0] || {}).name, sql: (d.queries[0] || {}).sql };
      d.controls.search.value = 'statin';
      d.controls.search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 9000));
      const rows = d.mainGrid.rows.data();
      return {
        before,
        count: d.mainGrid.rows.count(),
        names: rows.map((r) => r.name),
        sql: (d.queries.find((q) => q.label === 'grid rows') || {}).sql,
        totalsSql: (d.queries.find((q) => q.label === 'totals row') || {}).sql,
        pinned: d.mainGrid.getPinnedRows({ edge: 'bottom' })[0] || null,
      };
    })()`);
    console.log(`  searching for "statin": ${searched.before.count} rows -> ${searched.count} rows`);
    console.log(`    ${searched.sql}`);
    check(searched.count > 0 && searched.count < searched.before.count,
      'searching narrows the grid', `${searched.before.count} -> ${searched.count}`);
    check(/LIKE '%statin%'/.test(searched.sql || ''), 'and the text reached the endpoint as a WHERE clause',
      (searched.sql || '').slice(0, 140));
    check(searched.sql !== searched.before.sql, 'the statement changed');
    check(searched.names.length > 0 && searched.names.every((name) => /statin/i.test(name)),
      'every row that came back matches the search', searched.names.slice(0, 5).join(', '));

    /* The endpoint, asked the same question from here, gives the same count. */
    const searchCount = Number((await ask(EpdData.countSql({
      month: live.month, level: live.level, schemaMap: meta.schemaMap, filters: null, quick: 'statin', sort: [],
    }), 'the search count'))[0].n);
    check(searched.count === searchCount, 'and the count is the endpoint\'s own',
      `${searched.count} on the page, ${searchCount} from a query run here`);
    check(!!searched.pinned && /Total of/.test(searched.pinned.name),
      'the totals row follows the search', searched.pinned && searched.pinned.name);
    const searchTotals = (await ask(EpdData.matchTotalsSql({
      month: live.month, level: live.level, schemaMap: meta.schemaMap, filters: null, quick: 'statin', sort: [],
    }), 'the search totals'))[0];
    check(!!searched.pinned && near(Number(searched.pinned.cost), Number(searchTotals.cost), 1e-6),
      'and its cost is the endpoint\'s total over everything the search matched, not over the page',
      `${searched.pinned && searched.pinned.cost}, expected ${searchTotals.cost}`);

    /* ---- a threshold on a measure becomes a HAVING ---- */

    const thresholded = await evaluate(`(async () => {
      const d = window.__prescribingDemo;
      d.controls.clearButton.click();
      await new Promise((r) => setTimeout(r, 7000));
      const before = d.mainGrid.rows.count();
      d.controls.costFloor.value = '1000000';
      d.controls.costFloor.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 11000));
      const rows = d.mainGrid.rows.data();
      return {
        before,
        count: d.mainGrid.rows.count(),
        lowest: Math.min(...rows.map((r) => Number(r.cost))),
        sql: (d.queries.find((q) => q.label === 'grid rows') || {}).sql,
      };
    })()`);
    console.log(`  actual cost at least 1,000,000: ${thresholded.before} rows -> ${thresholded.count} rows`);
    check(/HAVING SUM\(SAFE_CAST\(ACTUAL_COST AS FLOAT64\)\) >= 1000000/.test(thresholded.sql || ''),
      'a threshold on a measure reached the endpoint as a HAVING, not a WHERE',
      (thresholded.sql || '').slice(0, 200));
    check(thresholded.count > 0 && thresholded.count < thresholded.before,
      'and it narrowed the grid', `${thresholded.before} -> ${thresholded.count}`);
    check(thresholded.lowest >= 1000000, 'every row that came back is over the threshold',
      `lowest ${thresholded.lowest}`);
    const havingCount = Number((await ask(EpdData.countSql({
      month: live.month, level: live.level, schemaMap: meta.schemaMap,
      filters: { col: 'cost', op: 'gte', value: 1000000 }, quick: '', sort: [],
    }), 'the threshold count'))[0].n);
    check(thresholded.count === havingCount, 'and the count is the endpoint\'s own',
      `${thresholded.count} on the page, ${havingCount} from a query run here`);

    /* ---- sorting goes to the endpoint ---- */

    const sorted = await evaluate(`(async () => {
      const d = window.__prescribingDemo;
      d.controls.clearButton.click();
      d.controls.costFloor.value = '';
      d.controls.costFloor.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 9000));
      const before = (d.mainGrid.rows.data()[0] || {}).name;
      d.mainGrid.sort.set([{ col: 'name', dir: 'asc' }]);
      await new Promise((r) => setTimeout(r, 9000));
      return {
        before,
        count: d.mainGrid.rows.count(),
        first: (d.mainGrid.rows.data()[0] || {}).name,
        sql: (d.queries.find((q) => q.label === 'grid rows') || {}).sql,
      };
    })()`);
    console.log(`  sorting by name over ${sorted.count} rows: first row "${sorted.before}" -> "${sorted.first}"`);
    check(/ORDER BY BNF_CHEMICAL_SUBSTANCE ASC/.test(sorted.sql || ''),
      'sorting reached the endpoint as an ORDER BY', (sorted.sql || '').slice(-90));
    check(sorted.first !== sorted.before, 'and the rows came back in the new order',
      `${sorted.before} -> ${sorted.first}`);

    /* ---- changing what a row is rewrites the GROUP BY ---- */

    const regrouped = await evaluate(`(async () => {
      const d = window.__prescribingDemo;
      d.mainGrid.sort.set([{ col: 'cost', dir: 'desc' }]);
      await new Promise((r) => setTimeout(r, 6000));
      d.controls.levelPicker.value = 'icb';
      d.controls.levelPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 16000));
      const rows = d.mainGrid.rows.data();
      return {
        level: d.view.level,
        count: d.mainGrid.rows.count(),
        first: rows[0] ? rows[0].name : null,
        region: rows[0] ? rows[0].region : null,
        sql: (d.queries.find((q) => q.label === 'grid rows') || {}).sql,
        headings: [...document.querySelectorAll('.primary-host [role="columnheader"]')].map((c) => c.textContent.trim()),
      };
    })()`);
    console.log(`  one row is a care board: ${regrouped.count} rows, first "${regrouped.first}"`);
    console.log(`    ${regrouped.sql}`);
    check(/SELECT ICB_NAME AS name/.test(regrouped.sql || ''), 'changing what a row is rewrote the SELECT',
      (regrouped.sql || '').slice(0, 90));
    check(/ANY_VALUE\(REGIONAL_OFFICE_NAME\) AS region/.test(regrouped.sql || ''),
      'and brought the region with it as an aggregate over the group');
    check(regrouped.count > 0 && regrouped.count < 100, 'there are far fewer care boards than substances',
      `${regrouped.count}`);
    check(!!regrouped.region, 'and each row carries its region', regrouped.region);
    check(regrouped.headings.some((h) => /Integrated care board/i.test(h)),
      'the first heading changed with it', regrouped.headings.slice(0, 3).join(' | '));
    const boardCount = Number((await ask(EpdData.countSql({
      month: live.month, level: 'icb', schemaMap: meta.schemaMap, filters: null, quick: '', sort: [],
    }), 'the care board count'))[0].n);
    check(regrouped.count === boardCount, 'and the number of them is the endpoint\'s',
      `${regrouped.count} on the page, ${boardCount} from a query run here`);

    /* ---- scrolling asks for a second window ---- */

    const paged = await evaluate(`(async () => {
      const d = window.__prescribingDemo;
      d.controls.levelPicker.value = 'practice';
      d.controls.levelPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 14000));
      const viewport = document.querySelector('.primary-host .lat-body-viewport');
      const before = d.queries.length;
      viewport.scrollTop = 9000;
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 12000));
      const offsets = d.queries
        .filter((q) => q.label === 'grid rows')
        .map((q) => Number((String(q.sql).match(/OFFSET (\\d+)/) || [0, -1])[1]));
      return {
        count: d.mainGrid.rows.count(),
        offsets,
        statements: d.queries.length - before,
        drawnIndex: (() => {
          const row = document.querySelector('.primary-host .lat-row[data-index]');
          return row ? Number(row.getAttribute('data-index')) : -1;
        })(),
      };
    })()`);
    console.log(`  practices: ${paged.count} rows; windows asked for at offsets ${paged.offsets.join(', ')}; `
      + `first drawn row index ${paged.drawnIndex}`);
    check(paged.count > 1000, 'there are thousands of practices', `${paged.count}`);
    check(paged.offsets.some((offset) => offset > 0), 'scrolling asked the endpoint for a later window',
      `offsets ${paged.offsets.join(', ')}`);
    check(paged.drawnIndex > 0, 'and the rows underneath are reachable', `first drawn row index ${paged.drawnIndex}`);

    /* ---- changing the month changes the table ---- */

    const monthChanged = await evaluate(`(async () => {
      const d = window.__prescribingDemo;
      d.controls.levelPicker.value = 'chapter';
      d.controls.levelPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10000));
      const before = { month: d.view.month, cost: (d.mainGrid.rows.data()[0] || {}).cost };
      const options = [...d.controls.monthPicker.options].map((o) => o.value);
      const other = options.find((m) => m !== d.view.month);
      d.controls.monthPicker.value = other;
      d.controls.monthPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 32000));
      return {
        before,
        months: options.length,
        month: d.view.month,
        cost: (d.mainGrid.rows.data()[0] || {}).cost,
        sql: (d.queries.find((q) => q.label === 'grid rows') || {}).sql,
        status: (document.querySelector('.freshness') || {}).textContent || '',
        tiles: d.kpi.tiles().map((t) => ({ id: t.id, value: t.value })),
      };
    })()`);
    console.log(`  month ${monthChanged.before.month} -> ${monthChanged.month} (${monthChanged.months} offered)`);
    check(monthChanged.months >= 12, 'the month picker offers the months the dataset holds', `${monthChanged.months}`);
    check(monthChanged.month !== monthChanged.before.month, 'the month changed', monthChanged.month);
    check(new RegExp('FROM `' + EpdData.resourceFor(monthChanged.month) + '`').test(monthChanged.sql || ''),
      'and the statement names that month\'s own table',
      (monthChanged.sql || '').slice(0, 120));
    check(Number(monthChanged.cost) !== Number(monthChanged.before.cost),
      'and the figures are that month\'s, not the one before',
      `${monthChanged.before.cost} -> ${monthChanged.cost}`);
    const otherTotals = (await ask(EpdData.totalsSql(monthChanged.month), 'the other month totals'))[0];
    const itemsTile = monthChanged.tiles.find((t) => t.id === 'items');
    check(!!itemsTile && near(Number(itemsTile.value), Number(otherTotals.items), 1e-9),
      'the tiles followed the month, and match a query run here',
      `${itemsTile && itemsTile.value}, expected ${otherTotals.items}`);

    /* ---- a slow answer cannot overwrite a newer one ---- */

    /*
     * Deliberately raced. Asking for practices sends a totals statement the
     * session has never seen, which takes seconds; going straight back to
     * substances sends one it has, which is answered in the same tick. So the
     * slow answer is guaranteed to arrive after the fast one, and the totals
     * row must still describe the grid a reader is looking at.
     */
    const raced = await evaluate(`(async () => {
      const d = window.__prescribingDemo;
      d.controls.levelPicker.value = 'practice';
      d.controls.levelPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      d.controls.levelPicker.value = 'substance';
      d.controls.levelPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30000));
      return {
        level: d.view.level,
        count: d.mainGrid.rows.count(),
        pinned: d.mainGrid.getPinnedRows({ edge: 'bottom' })[0] || null,
      };
    })()`);
    console.log(`  after a raced level change: ${raced.count} rows, totals row "${raced.pinned && raced.pinned.name}"`);
    check(raced.level === 'substance', 'the raced level change landed on substances', raced.level);
    check(!!raced.pinned && /chemical substances/i.test(raced.pinned.name),
      'a slow answer for a level the reader has left cannot overwrite the totals row of the one they are on',
      raced.pinned && raced.pinned.name);
    check(!!raced.pinned && Number(raced.pinned.items) > 0,
      'and the totals row still carries figures', raced.pinned && raced.pinned.items);

    /* ---- back to where the screenshot should be taken ---- */

    await evaluate(`(async () => {
      const d = window.__prescribingDemo;
      d.controls.monthPicker.value = ${JSON.stringify(live.month)};
      d.controls.monthPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 18000));
      d.controls.levelPicker.value = 'substance';
      d.controls.levelPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 12000));
      d.mainGrid.sort.set([{ col: 'cost', dir: 'desc' }]);
      await new Promise((r) => setTimeout(r, 8000));
      /* Back to the top, so the screenshot shows the grid as a reader meets it
         rather than where the paging check left it. */
      const viewport = document.querySelector('.primary-host .lat-body-viewport');
      if (viewport) { viewport.scrollTop = 0; viewport.dispatchEvent(new Event('scroll', { bubbles: true })); }
      await new Promise((r) => setTimeout(r, 4000));
    })()`);

    const settled = await evaluate(READ);

    /*
     * The totals row describes the grid it is under.
     *
     * Every level over the same month sums to the same figures, so a totals
     * row left over from another level agrees with every arithmetic check
     * there is and is still wrong: it names the wrong thing. The label is what
     * catches it. This went wrong for real, because a statement answered from
     * the page's own memory comes back in the same tick while the one asked
     * for before it is still in flight.
     */
    check(!!settled.pinned[0] && /chemical substances/i.test(settled.pinned[0].name),
      'the totals row names what a row of the grid currently is, not what it was',
      settled.pinned[0] && settled.pinned[0].name);
    check(!!settled.pinned[0] && settled.pinned[0].name.includes(String(settled.count).replace(/\B(?=(\d{3})+(?!\d))/g, ',')),
      'and counts the same rows the status bar does',
      `${settled.pinned[0] && settled.pinned[0].name} against ${settled.count} rows`);

    /* ---- the totals row is a query, not a sum of the page ---- */

    const wholeTotals = (await ask(EpdData.matchTotalsSql({
      month: live.month, level: 'substance', schemaMap: meta.schemaMap, filters: null, quick: '', sort: [],
    }), 'the whole month totals'))[0];
    const totalsRow = settled.pinned[0] || null;
    console.log(`  totals row: ${totalsRow && totalsRow.name} / cost ${totalsRow && totalsRow.cost}`);
    check(!!totalsRow, 'a totals row is pinned under the grid');
    check(!!totalsRow && near(Number(totalsRow.cost), Number(wholeTotals.cost), 1e-6),
      'and its cost is the endpoint\'s total over the month',
      `${totalsRow && totalsRow.cost}, expected ${wholeTotals.cost}`);
    check(!!totalsRow && near(Number(totalsRow.items), Number(wholeTotals.items), 1e-9),
      'and so are its items', `${totalsRow && totalsRow.items}, expected ${wholeTotals.items}`);
    const loadedCost = await evaluate(`window.__prescribingDemo.mainGrid.rows.data().reduce((a, r) => a + Number(r.cost || 0), 0)`);
    check(Number(totalsRow.cost) > loadedCost * 1.05,
      'and it is plainly not the sum of the rows that happen to be loaded',
      `total ${Math.round(totalsRow.cost)} against ${Math.round(loadedCost)} loaded`);

    /* ---- the tiles ---- */

    const monthTotals = (await ask(EpdData.totalsSql(live.month), 'the month totals'))[0];
    console.log(`  tiles: ${settled.tiles.map((t) => t.id + '=' + t.formatted).join(', ')}`);
    check(settled.tiles.length === 4, 'four tiles', `${settled.tiles.length}`);
    for (const [id, expectedValue] of [
      ['items', Number(monthTotals.items)],
      ['cost', Number(monthTotals.cost)],
      ['practices', Number(monthTotals.practices)],
      ['costPerItem', Number(monthTotals.cost) / Number(monthTotals.items)],
    ]) {
      const tile = settled.tiles.find((t) => t.id === id);
      check(!!tile && near(Number(tile.value), expectedValue, 1e-9), `the ${id} tile matches a query run here`,
        `${tile && tile.value}, expected ${expectedValue}`);
    }
    const tilePaint = await evaluate(`(() => {
      const painted = [...document.querySelectorAll('.kpi-strip .lat-kpi__value')].map((e) => ({
        text: e.textContent,
        clipped: e.scrollWidth > e.clientWidth + 1,
        bg: getComputedStyle(e.closest('.lat-kpi__tile') || e).backgroundColor,
        height: Math.round((e.closest('.lat-kpi__tile') || e).getBoundingClientRect().height),
      }));
      return { painted, deltas: document.querySelectorAll('.kpi-strip .lat-kpi__delta').length };
    })()`);
    check(tilePaint.painted.every((p) => !p.clipped), 'no tile figure is cut short by an ellipsis',
      tilePaint.painted.filter((p) => p.clipped).map((p) => p.text).join(', '));
    check(tilePaint.painted.every((p) => p.bg === 'rgb(255, 255, 255)'), 'every tile is drawn on a white card',
      tilePaint.painted.map((p) => p.bg).join(', '));
    check(new Set(tilePaint.painted.map((p) => p.height)).size === 1, 'every tile is the same height',
      [...new Set(tilePaint.painted.map((p) => p.height))].join(', '));
    check(tilePaint.deltas === 4, 'each tile shows its movement against the same month a year earlier',
      `${tilePaint.deltas}`);

    /* ---- the charts ---- */

    const charts = await evaluate(`(async () => {
      const d = window.__prescribingDemo;
      const shapeOf = (chart) => {
        const data = chart && chart.data();
        const series = (data && data.series) || [];
        return {
          kind: data && data.kind,
          empty: !!(data && data.empty),
          points: series.reduce((n, s) => n + s.points.length, 0),
          withValue: series.reduce((n, s) => n + s.points.filter((p) => p.y != null).length, 0),
        };
      };
      d.tabs.activate('boards');
      await new Promise((r) => setTimeout(r, 900));
      const boards = shapeOf(d.charts.boards);
      const boardBars = document.querySelectorAll('.chart-box rect.lat-chartview__bar, .chart-box svg rect').length;
      d.tabs.activate('trend');
      await new Promise((r) => setTimeout(r, 900));
      const trend = shapeOf(d.charts.trend);
      const trendLines = d.charts.trend.element.querySelectorAll('path.lat-chartview__line').length;
      d.tabs.activate('chapters');
      await new Promise((r) => setTimeout(r, 900));
      const chapters = shapeOf(d.charts.chapters);
      return { boards, boardBars, trend, trendLines, chapters, trendRows: d.trendGrid.rows.count() };
    })()`);
    console.log(`  charts: chapters ${charts.chapters.withValue} bars, boards ${charts.boards.withValue} bars, `
      + `trend ${charts.trend.withValue} points over ${charts.trendRows} months`);
    check(charts.chapters.withValue === 15, 'the chapter chart draws fifteen bars', `${charts.chapters.withValue}`);
    check(charts.chapters.empty === false, 'and is not showing its empty state');
    check(charts.boards.withValue === 15, 'the care board chart draws fifteen bars', `${charts.boards.withValue}`);
    check(charts.trend.withValue >= 20, 'the trend chart draws two years of months', `${charts.trend.withValue}`);
    check(charts.trendLines >= 1, 'and draws them as a line', `${charts.trendLines}`);

    const trendRows = await ask(EpdData.trendSql(settled.substance, meta.months, meta.schemaMap), 'the trend');
    check(charts.trendRows === trendRows.length, 'the trend holds the months the endpoint returns',
      `${charts.trendRows} on the page, ${trendRows.length} from a query run here`);

    /* ---- the statements are all shown ---- */

    const panel = await evaluate(`(() => ({
      entries: document.querySelectorAll('.query-log .query-entry').length,
      labels: [...document.querySelectorAll('.query-log .query-label')].map((e) => e.textContent),
      cached: [...document.querySelectorAll('.query-log .query-source')].map((e) => e.textContent),
    }))()`);
    console.log(`  query panel: ${panel.entries} statements, labels ${[...new Set(panel.labels)].join(', ')}`);
    check(panel.entries > 0, 'the query panel lists the statements that were sent', `${panel.entries}`);
    check(panel.labels.includes('grid rows'), 'including the grid\'s own row query');
    check(panel.cached.includes('session memory'),
      'and says when one was answered from the session rather than sent again',
      [...new Set(panel.cached)].join(', '));

    await shoot('01-dashboard-1280');
    noErrors('the live page');
  }

  /* =================================================================== */
  /* 3. Things that must be true whichever way the page was opened.       */
  /* =================================================================== */

  const furniture = await evaluate(`(() => ({
    rails: document.querySelectorAll('.lat-panel-dock').length,
    menus: document.querySelectorAll('.lat-header-menu').length,
    filters: document.querySelectorAll('.lat-header-filter').length,
    sorts: document.querySelectorAll('.lat-header-sort').length,
    movable: document.querySelectorAll('[data-movable="true"]').length,
    reorderTips: [...document.querySelectorAll('[title]')].filter((e) => /to reorder/i.test(e.getAttribute('title') || '')).length,
  }))()`);
  console.log(`  furniture: ${JSON.stringify(furniture)}`);
  check(furniture.rails === 0, 'no grid shows the right-hand tool rail', `${furniture.rails}`);
  check(furniture.menus === 0, 'no heading carries a column menu', `${furniture.menus}`);
  check(furniture.filters === 0, 'no heading carries a filter funnel', `${furniture.filters}`);
  check(furniture.reorderTips === 0, 'no heading offers to be dragged to reorder', `${furniture.reorderTips}`);
  check(furniture.movable === 0, 'and none is marked as draggable', `${furniture.movable}`);
  check(furniture.sorts > 0, 'the sort control is still there, which on this page is the ORDER BY',
    `${furniture.sorts}`);

  const clicking = await evaluate(`(async () => {
    const root = document.querySelector('.primary-host .lattice');
    const cell = root.querySelector('.lat-body-viewport [role="gridcell"]:not(:first-child)');
    if (cell) cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    if (cell) cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 400));
    return {
      ranges: (() => { const sel = window.__prescribingDemo.mainGrid.selection; return sel && sel.ranges ? sel.ranges().length : 0; })(),
      fillHandles: document.querySelectorAll('.lat-fill-handle').length,
      rangeCells: document.querySelectorAll('.lat-cell--range').length,
    };
  })()`);
  check(clicking.ranges === 0, 'clicking a cell starts no cell range', `${clicking.ranges}`);
  check(clicking.fillHandles === 0, 'there is no fill handle to grab', `${clicking.fillHandles}`);
  check(clicking.rangeCells === 0, 'no cell is drawn as selected', `${clicking.rangeCells}`);

  const headings = await evaluate(`[...document.querySelectorAll('.primary-host [role="columnheader"]')].map((c) => c.textContent.trim())`);
  console.log(`  headings: ${headings.join(' | ')}`);
  for (const metric of EpdData.METRICS) {
    check(headings.some((h) => h.includes(metric.title) && h.includes(metric.unit)),
      `the ${metric.title} heading states its unit, "${metric.unit}"`, headings.join(' | '));
  }

  const text = await evaluate(`(() => {
    const nan = [];
    const dashes = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      const value = node.nodeValue || '';
      if (/\\bNaN\\b/.test(value)) nan.push(value.trim().slice(0, 60));
      if (value.includes(String.fromCharCode(8212))) dashes.push(value.trim().slice(0, 70));
    }
    return { nan: nan.slice(0, 5), dashes: dashes.slice(0, 5) };
  })()`);
  check(text.nan.length === 0, 'nothing on the page reads "NaN"', text.nan.join(' | '));
  check(text.dashes.length === 0, 'no visible text on the page uses an em dash', text.dashes.join(' | '));

  const credit = await evaluate(`(() => {
    const foot = document.querySelector('.foot');
    return {
      text: foot ? foot.textContent : '',
      ogl: !!document.querySelector('.foot a[href*="open-government-licence/version/3"]'),
      portal: !!document.querySelector('.foot a[href*="opendata.nhsbsa.net"]'),
    };
  })()`);
  check(/NHS Business Services Authority, English Prescribing Dataset/.test(credit.text),
    'the page credits the publisher and names the dataset');
  check(/Open Government Licence v3\.0/.test(credit.text), 'and states the licence');
  check(credit.ogl, 'with a link to the licence itself');
  check(credit.portal, 'and a link to the dataset');

  /* =================================================================== */
  /* 4. On a phone.                                                       */
  /* =================================================================== */

  await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: true });
  await open(`${origin}/index.html${OFFLINE ? '?live=0' : ''}`, 'the page, 400px wide');

  const narrow = await evaluate(`(() => {
    const de = document.documentElement;
    const viewport = document.querySelector('.primary-host .lat-body-viewport');
    const widest = [];
    const clipped = (e) => getComputedStyle(e).overflowX !== 'visible';
    const walk = (e) => {
      for (const child of e.children) {
        const box = child.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.right > de.clientWidth + 1) widest.push(String(child.className || child.tagName).slice(0, 40) + ' @' + Math.round(box.right));
        if (!clipped(child)) walk(child);
      }
    };
    walk(document.body);
    return {
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      dataRows: viewport ? viewport.querySelectorAll('.lat-row[data-index]').length : 0,
      tiles: document.querySelectorAll('.kpi-strip .lat-kpi__tile').length,
      tileRows: new Set([...document.querySelectorAll('.kpi-strip .lat-kpi__tile')].map((t) => Math.round(t.getBoundingClientRect().top))).size,
      sql: document.querySelectorAll('.query-sql').length,
      sqlEmpty: document.querySelectorAll('.query-empty').length,
      sticking: widest.slice(0, 5),
    };
  })()`);
  console.log(`  at 400px: scrollWidth ${narrow.scrollWidth} vs clientWidth ${narrow.clientWidth}, `
    + `${narrow.dataRows} data rows, ${narrow.tiles} tiles in ${narrow.tileRows} rows, ${narrow.sql} statements shown`);
  if (narrow.sticking.length) console.log(`  sticking out: ${narrow.sticking.join(', ')}`);
  check(narrow.scrollWidth <= narrow.clientWidth, 'at 400px: the page does not scroll sideways',
    `scrollWidth ${narrow.scrollWidth} > clientWidth ${narrow.clientWidth}; ${narrow.sticking.join(', ')}`);
  check(narrow.dataRows > 0, 'at 400px: the main grid still paints data rows', `${narrow.dataRows}`);
  check(narrow.tiles > 0, 'at 400px: the tiles are still drawn', `${narrow.tiles}`);
  check(narrow.tileRows === narrow.tiles, 'at 400px: the tiles are one per line rather than four across',
    `${narrow.tiles} tiles on ${narrow.tileRows} lines`);
  if (OFFLINE) {
    check(narrow.sqlEmpty > 0, 'at 400px, live view off: the query panel says nothing has been sent',
      `${narrow.sqlEmpty}`);
  } else {
    check(narrow.sql > 0, 'at 400px: the query panel still shows the statements', `${narrow.sql}`);
  }
  await shoot(OFFLINE ? '07-offline-400' : '02-dashboard-400');
  noErrors('at 400px');

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
