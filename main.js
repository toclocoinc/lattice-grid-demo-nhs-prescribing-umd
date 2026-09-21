/**
 * The entry point: read the saved copy, hand it to the dashboard, draw, then
 * let the dashboard go live.
 *
 * This is the script-tag edition. The grid and its modules arrived as classic
 * `<script src>` tags from jsDelivr, ahead of this file, and left globals
 * behind: `LatticeGrid` (the core, which the charts module extends),
 * `LatticeGridDataRouter`, `LatticeGridKPI` and `LatticeGridTabs`. This file
 * picks the factories off those globals and hands them to the dashboard, which
 * never touches a global itself.
 *
 * `?live=0` opens the page on the saved copy and leaves it there, which is how
 * the offline check reads it. Nothing else on the page changes.
 */
(function (root) {
  'use strict';

  const TITLE = 'What England prescribes, live';

  const host = document.querySelector('#app');

  /** Draw the waiting state, and return a function that updates its message. */
  function showProgress(first) {
    host.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'loading';
    const title = document.createElement('h1');
    title.textContent = TITLE;
    const message = document.createElement('p');
    message.className = 'loading-message';
    message.textContent = first;
    const bar = document.createElement('div');
    bar.className = 'loading-bar';
    const fill = document.createElement('div');
    fill.className = 'loading-fill';
    bar.append(fill);
    panel.append(title, message, bar);
    host.append(panel);
    return (text, fraction) => {
      message.textContent = text;
      fill.style.width = `${Math.round((fraction || 0) * 100)}%`;
    };
  }

  /** Say what went wrong, in words a reader can act on. */
  function showError(error) {
    host.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'loading';
    const title = document.createElement('h1');
    title.textContent = 'The prescribing data could not be loaded';
    const message = document.createElement('p');
    message.className = 'loading-message';
    message.textContent = String((error && error.message) || error);
    panel.append(title, message);
    host.append(panel);
    console.error('[prescribing demo]', error);
  }

  /**
   * The grid's factories, read off the globals the script tags left behind.
   *
   * Checked by name rather than assumed, so a script tag that did not load, or
   * loaded in the wrong order, is reported as the sentence it is rather than
   * as "undefined is not a function" somewhere inside the dashboard.
   *
   * @returns {object} the factories and `setLicence`
   */
  function libraryFromGlobals() {
    const missing = [];
    const need = (object, name, what) => {
      const value = object && object[name];
      if (typeof value !== 'function') missing.push(what);
      return value;
    };
    const createGrid = need(root.LatticeGrid, 'createGrid', 'lattice-grid.min.js (LatticeGrid.createGrid)');
    const setLicence = need(root.LatticeGrid, 'setLicence', 'lattice-grid.min.js (LatticeGrid.setLicence)');
    /* The one that makes this demo what it is: the grid's own translation
       layer from its query state to an engine. */
    const createPushdownSource = need(root.LatticeGrid, 'createPushdownSource', 'lattice-grid.min.js (LatticeGrid.createPushdownSource)');
    /* The charts module extends the core global rather than defining its own,
       so it has to be loaded after the core; this is where that shows. */
    const createChart = need(root.LatticeGrid, 'createChart', 'modules/charts.min.js (LatticeGrid.createChart)');
    const createDataRouter = need(root.LatticeGridDataRouter, 'createDataRouter', 'modules/data-router.min.js (LatticeGridDataRouter.createDataRouter)');
    const createKPI = need(root.LatticeGridKPI, 'createKPI', 'modules/kpi.min.js (LatticeGridKPI.createKPI)');
    const createTabs = need(root.LatticeGridTabs, 'createTabs', 'modules/tabs.min.js (LatticeGridTabs.createTabs)');
    if (missing.length) {
      throw new Error(
        `The grid did not load from the CDN. Missing: ${missing.join('; ')}. `
          + 'Check that the script tags in index.html are reachable and in order, with the core first.',
      );
    }
    return { createGrid, setLicence, createPushdownSource, createChart, createDataRouter, createKPI, createTabs };
  }

  async function start() {
    const started = performance.now();
    try {
      const library = libraryFromGlobals();
      const { readSnapshot, buildDashboard } = root.NhsPrescribing;

      /* Applied before anything is drawn, because a grid that already exists
         keeps whatever licence was in force when it was built. */
      library.setLicence(DEMO_LICENCE);

      const update = showProgress('Reading the saved copy...');
      const snapshot = await readSnapshot(update);
      update('Building the page...', 1);
      const read = performance.now();

      const live = new URLSearchParams(location.search).get('live') !== '0';

      const built = buildDashboard({
        root: host,
        createGrid: library.createGrid,
        createChart: library.createChart,
        createKPI: library.createKPI,
        createTabs: library.createTabs,
        createDataRouter: library.createDataRouter,
        createPushdownSource: library.createPushdownSource,
        snapshot,
        live,
      });

      const drawn = performance.now();
      built.timings = {
        savedSubstances: snapshot.substances.length,
        readMs: Math.round(read - started),
        drawMs: Math.round(drawn - read),
      };
      built.ready_ = false;
      root.__prescribingDemo = built;
      console.log('[prescribing demo] drawn from the saved copy', built.timings);

      /* The page is usable now. Going live happens behind it, and the flag is
         what a check waits on rather than a fixed sleep. */
      built.ready.then(() => {
        built.ready_ = true;
        console.log('[prescribing demo] live', {
          isLive: built.isLive,
          error: built.lastError,
          queries: built.queries.length,
          rows: built.mainGrid.rows.count(),
        });
      });
    } catch (error) {
      root.__prescribingDemo = { ready_: true, isLive: false, error: String((error && error.message) || error) };
      showError(error);
    }
  }

  start();
})(window);
