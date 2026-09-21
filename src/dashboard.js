/**
 * The page.
 *
 * It opens on the saved copy so there is something true on screen in the first
 * second, then goes live: the main grid's source is replaced with a pushdown
 * source, and from that point every scroll, sort, search and filter is a SQL
 * statement sent to NHS Business Services Authority and answered over the
 * public internet. The statements are shown under the grid exactly as they
 * were sent.
 *
 * Nothing here computes a figure the endpoint could compute. The totals line is
 * a query, the tiles are a query, each chart is a query. A figure worked out
 * in the browser from the hundred rows that happen to be loaded would describe
 * the page rather than the month, and this page is about the month.
 */
(function (root) {
  'use strict';

  const D = root.EpdData;
  const S = root.EpdSource;

  /**
   * How many statements the query panel keeps.
   *
   * Enough that scrolling a grid for a while does not push the interesting
   * ones off the end, and bounded, because a page left open all afternoon
   * should not grow a list without limit. The caption says the number, so the
   * panel never implies it is showing more than it is.
   */
  const QUERY_LOG_LENGTH = 40;
  /** How long after the last keystroke the search reaches the endpoint. */
  const SEARCH_DEBOUNCE_MS = 300;
  /** How many chapters and care boards the charts draw. */
  const CHART_ROWS = 15;
  /** How many rows one window of the grid is. */
  const PAGE_SIZE = 100;

  /**
   * An element, with an optional class and text.
   *
   * @param {string} tag the tag name
   * @param {string|null} [cls] a class name
   * @param {string} [text] its text
   * @returns {HTMLElement} the element
   */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * A two line column heading: the name, and under it the unit its numbers are
   * in. A reader asked to compare a cost with a count needs to be told which
   * is which where the numbers are, not in a note somewhere else.
   *
   * @param {string} main the heading proper
   * @param {string} sub the second line
   * @returns {() => HTMLElement} the renderer
   */
  function twoLineHeading(main, sub) {
    return () => {
      const wrap = el('span', 'col-head');
      wrap.append(el('span', 'col-head-main', main));
      wrap.append(el('span', 'col-head-sub', sub));
      return wrap;
    };
  }

  /**
   * The settings every grid on this page agrees on.
   *
   * No tool rail, no column menu, no filter funnel: the heading keeps its sort
   * arrow and nothing else. The sort arrow earns its place here more than on
   * most pages, because clicking it sends a new ORDER BY to the endpoint.
   *
   * @param {string} title the grid's title
   * @param {object} [extra] the rest of the configuration
   * @returns {object} the configuration
   */
  function baseGridConfig(title, extra) {
    return Object.assign({
      rowKey: 'name',
      theme: 'light',
      density: 'compact',
      stripedRows: true,
      columnMenu: false,
      statusBar: true,
      selection: 'none',
      title,
    }, extra || {});
  }

  /** A column's layout, with the one thing every column here agrees on. */
  function fixedLayout(extra) {
    return Object.assign({ movable: false }, extra || {});
  }

  /**
   * The main grid's columns for one level.
   *
   * Every width is declared. A grid that measures its own columns has to have
   * rows to measure, and this grid's first rows arrive from a query: sizing
   * from them would move every column the moment the endpoint answered.
   *
   * @param {object} level the level
   * @returns {object[]} the columns
   */
  function mainColumns(level) {
    const columns = [{
      id: 'name',
      field: 'name',
      title: level.title,
      type: 'text',
      /* No funnel on the heading. Filtering on this page is not a per column
         affair: a filter here is a WHERE or a HAVING in a statement sent to
         another country, and the controls above the grid are where that is
         asked for, in words that say what will happen. */
      filter: { enabled: false },
      /* Declared, not measured: a `min` the name never goes below, and a share
         of whatever is left over so the row reaches the right hand edge rather
         than stopping halfway with an empty strip beside it. Sizing this one
         to its content would move every column the moment a query answered. */
      layout: fixedLayout({ width: level.width, min: level.width, flex: 1 }),
      allowGroup: false,
    }];
    for (const extra of level.extras) {
      columns.push({
        id: extra.id,
        field: extra.id,
        title: extra.title,
        type: 'text',
        filter: { enabled: false },
        layout: fixedLayout({ width: extra.width }),
        allowGroup: false,
      });
    }
    for (const metric of D.METRICS) {
      columns.push({
        id: metric.id,
        field: metric.id,
        title: metric.title + ', ' + metric.unit,
        header: { render: twoLineHeading(metric.title, metric.unit) },
        type: 'number',
        format: metric.format,
        filter: { enabled: false },
        layout: fixedLayout({ width: metric.width, align: 'end' }),
        allowGroup: false,
      });
    }
    return columns;
  }

  /* ------------------------------------------------------------------ */
  /* The saved copy                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Read the five files in `data/snapshot`.
   *
   * @param {(text: string, fraction: number) => void} [report] progress
   * @returns {Promise<object>} the saved copy
   */
  async function readSnapshot(report) {
    const say = report || (() => {});
    const names = ['meta', 'substances', 'chapters', 'icbs', 'trend'];
    const out = {};
    for (let i = 0; i < names.length; i += 1) {
      say('Reading the saved copy...', (i + 1) / names.length);
      const response = await fetch('./data/snapshot/' + names[i] + '.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('data/snapshot/' + names[i] + '.json could not be read');
      out[names[i]] = await response.json();
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* The stream the router partitions                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Every viewer on this page but the main grid reads one stream, keyed by
   * what a row is. The saved copy is loaded into it first and the live answers
   * replace it as they arrive, so the tiles and the charts move from the saved
   * figure to the live one by a keyed difference rather than by being torn
   * down and rebuilt.
   *
   * @param {object} parts `{ totals, yearAgoTotals, chapters, icbs, trend, substance }`
   * @returns {object[]} the stream
   */
  function streamOf(parts) {
    const rows = [];
    if (parts.totals) {
      rows.push(Object.assign({ id: 'total|latest', kind: 'total', period: 'latest' }, parts.totals));
    }
    if (parts.yearAgoTotals) {
      rows.push(Object.assign({ id: 'total|yearAgo', kind: 'total', period: 'yearAgo' }, parts.yearAgoTotals));
    }
    for (const row of (parts.chapters || []).slice(0, CHART_ROWS)) {
      rows.push({
        id: 'chapter|' + row.name, kind: 'chapter', name: row.name,
        items: Number(row.items), cost: Number(row.cost),
      });
    }
    for (const row of (parts.icbs || []).slice(0, CHART_ROWS)) {
      rows.push({
        id: 'icb|' + row.name, kind: 'icb', name: shortenBoard(row.name),
        items: Number(row.items), cost: Number(row.cost),
      });
    }
    for (const row of parts.trend || []) {
      rows.push({
        id: 'trend|' + row.month, kind: 'trend', month: row.month,
        items: Number(row.items), cost: Number(row.cost),
        substance: parts.substance || '',
      });
    }
    return rows;
  }

  /**
   * A care board's name, short enough to read on an axis.
   *
   * Every one of the thirty seven is published in capitals and ends in
   * "INTEGRATED CARE BOARD", which on a chart axis is thirty seven repetitions
   * of the same four words. The grid shows the published name in full; only
   * the chart shortens it.
   *
   * @param {string} name the published name
   * @returns {string} the name for an axis
   */
  function shortenBoard(name) {
    const text = String(name || '')
      .replace(/^NHS\s+/i, '')
      .replace(/\s+INTEGRATED CARE BOARD$/i, '');
    return text.charAt(0) + text.slice(1).toLowerCase();
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Build the whole page into `host`.
   *
   * @param {object} options everything the page needs, all handed in
   * @returns {object} the pieces that were built
   */
  function buildDashboard(options) {
    const {
      root: host, createGrid, createChart, createKPI, createTabs,
      createDataRouter, createPushdownSource, snapshot, live,
    } = options;
    const meta = snapshot.meta;

    host.textContent = '';

    /** The view the main grid is showing. The adapter reads it on every query. */
    const view = {
      month: meta.latest,
      level: 'substance',
      schemaMap: meta.schemaMap,
      substance: meta.defaultSubstance,
    };

    const built = {
      view,
      meta,
      snapshot,
      mainGrid: null,
      tileGrid: null,
      chapterGrid: null,
      icbGrid: null,
      trendGrid: null,
      kpi: null,
      router: null,
      tabs: null,
      charts: {},
      queries: [],
      appliedQuick: '',
      appliedFloor: null,
      months: meta.months.slice(),
      liveEnabled: live !== false,
      isLive: false,
      lastError: null,
      totals: meta.totals,
      yearAgoTotals: meta.yearAgoTotals,
      matched: { matched: meta.substancesInLatestMonth, items: meta.totals.items, cost: meta.totals.cost, quantity: meta.totals.quantity, costPerItem: meta.totals.cost / meta.totals.items },
      rowsInMonth: meta.rowsInLatestMonth,
    };

    /* ---------------- the endpoint client ---------------- */

    const client = S.createClient({
      onQuery(entry, phase) {
        if (phase === 'dropped') {
          /* Superseded before it was answered. It never reached the endpoint
             on anyone's behalf, so it is taken off the list rather than left
             there looking like a failure. */
          const at = built.queries.indexOf(entry);
          if (at >= 0) built.queries.splice(at, 1);
          drawQueryLog();
          return;
        }
        /* The same entry is offered twice: once when the statement is queued,
           once when it lands. It is the same object both times, so it moves to
           the top only on the first. */
        if (!built.queries.includes(entry)) built.queries.unshift(entry);
        if (built.queries.length > QUERY_LOG_LENGTH) built.queries.length = QUERY_LOG_LENGTH;
        /* A statement that came back is the endpoint answering, so a failure
           notice from a minute ago stops being true and stops being shown. */
        if (entry.status === 'done' && !entry.error && entry.source === 'endpoint') built.lastError = null;
        drawQueryLog();
        drawStatus();
        /* A control the reader moved while a statement was in flight has been
           waiting for this moment. */
        if (entry.status === 'done') catchUp();
      },
    });
    built.client = client;

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, 'What England prescribes, live'));
    heading.append(el('p', 'lede',
      'Every prescription item dispensed in England, around eighteen million rows a month, queried where it '
      + 'lives. The grid turns its own state into SQL and sends it to the NHS Business Services Authority open '
      + 'data endpoint: scrolling is LIMIT and OFFSET, the sort arrows are ORDER BY, the search box is a WHERE '
      + 'and the totals under it are their own query. Nothing is downloaded first. Built with Lattice Grid loaded by '
      + 'script tag: no install, no build step.'));
    header.append(heading);

    const provenance = el('div', 'head-note');
    const pill = el('span', 'pill', 'Saved copy');
    const freshness = el('span', 'freshness');
    provenance.append(pill, freshness);
    header.append(provenance);
    host.append(header);

    /** The one line that says where the numbers came from and how long it took. */
    function drawStatus() {
      pill.textContent = built.isLive ? 'Live' : 'Saved copy';
      const parts = [];
      if (built.isLive) {
        parts.push('Live from opendata.nhsbsa.net');
        if (client.state.lastMs != null) parts.push('last query ' + D.fmt.seconds(client.state.lastMs));
      } else {
        parts.push('Saved copy taken ' + new Date(meta.builtAt).toLocaleString('en-GB'));
      }
      parts.push(D.fmt.int(built.rowsInMonth) + ' rows in ' + D.monthLabel(view.month));
      freshness.textContent = parts.join(' | ');
      freshness.classList.toggle('failed', !built.liveEnabled ? false : !!built.lastError);
      if (!built.liveEnabled) {
        /* Opened with `?live=0`, which is how the offline check reads it. That
           is a choice, not a failure, and it is worded as one. */
        notice.hidden = false;
        notice.textContent = 'The live view is switched off for this visit, so everything below is the saved '
          + 'copy taken ' + new Date(meta.builtAt).toLocaleString('en-GB') + ', and the controls above are off '
          + 'because each of them is a query. Drop the live=0 from the address to query the endpoint.';
      } else if (built.lastError) {
        notice.hidden = false;
        notice.textContent = 'The endpoint did not answer: ' + built.lastError
          + '. Everything below is the last good result, and the controls above are off because each of them '
          + 'is a query. No figure on this page is invented.';
      } else {
        notice.hidden = true;
      }
    }

    const notice = el('p', 'notice');
    notice.hidden = true;
    host.append(notice);

    /* ---------------- the controls ---------------- */

    const controls = el('section', 'actions controls');
    controls.setAttribute('aria-label', 'What the grid asks the endpoint for');

    const monthPicker = el('select', 'action');
    monthPicker.setAttribute('aria-label', 'Which month to query');
    const levelPicker = el('select', 'action');
    levelPicker.setAttribute('aria-label', 'What one row of the grid is');
    const search = el('input', 'action search-input');
    search.type = 'search';
    search.placeholder = 'Search the names';
    search.setAttribute('aria-label', 'Search the names, which becomes a WHERE clause');
    const costFloor = el('input', 'action cost-input');
    costFloor.type = 'number';
    costFloor.min = '0';
    costFloor.step = '1000';
    costFloor.placeholder = 'any';
    costFloor.setAttribute('aria-label', 'Show only rows whose actual cost is at least this many pounds, which becomes a HAVING clause');
    const clearButton = el('button', 'action', 'Clear');
    clearButton.type = 'button';
    /* Made here with the others so the enabling below can reach it; it is
       appended into the trend tab, which is where it belongs on screen. */
    const substancePicker = el('select', 'action');
    substancePicker.setAttribute('aria-label', 'Which substance the trend chart draws');

    controls.append(el('span', 'actions-label', 'Month:'), monthPicker);
    controls.append(el('span', 'actions-label', 'One row is:'), levelPicker);
    controls.append(el('span', 'actions-label', 'Name contains:'), search);
    controls.append(el('span', 'actions-label', 'Actual cost at least, GBP:'), costFloor);
    controls.append(clearButton);
    host.append(controls);

    /**
     * Every control asks the endpoint a question, so none of them is offered
     * until there is an endpoint to ask. On the saved copy they would be
     * searching five hundred rows and calling the answer England, which is the
     * kind of half truth this page exists not to tell.
     *
     * @param {boolean} on whether the endpoint is answering
     */
    function enableControls(on) {
      for (const control of [monthPicker, levelPicker, search, costFloor, clearButton, substancePicker]) {
        control.disabled = !on;
      }
      controls.classList.toggle('waiting', !on);
    }
    enableControls(false);

    for (const level of D.LEVELS) {
      const option = el('option', null, level.label);
      option.value = level.id;
      levelPicker.append(option);
    }
    levelPicker.value = view.level;

    /** Fill the month picker from whatever list of months is known. */
    function drawMonths() {
      monthPicker.textContent = '';
      for (const month of built.months) {
        const option = el('option', null, D.monthLabel(month));
        option.value = month;
        monthPicker.append(option);
      }
      monthPicker.value = view.month;
    }
    drawMonths();

    /* ---------------- the tiles ---------------- */

    const kpiHost = el('div', 'kpi-host');
    const kpiCaption = el('p', 'panel-caption');
    const kpiStrip = el('div', 'kpi-strip');
    kpiHost.append(kpiCaption, kpiStrip);
    host.append(kpiHost);

    /* The tiles read a grid like every other viewer on this page, so the same
       keyed diff that moves a chart moves them. */
    const tileGrid = createGrid(el('div', 'grid-pane hidden-grid'), baseGridConfig('Month totals', {
      rowKey: 'id',
      statusBar: false,
      columns: [
        { id: 'id', field: 'id', title: 'Row' },
        { id: 'period', field: 'period', title: 'Period' },
        { id: 'items', field: 'items', title: 'Items, count', type: 'number' },
        { id: 'cost', field: 'cost', title: 'Actual cost, GBP', type: 'number' },
        { id: 'quantity', field: 'quantity', title: 'Total quantity, count', type: 'number' },
        { id: 'practices', field: 'practices', title: 'Practices, count', type: 'number' },
        { id: 'prescriptions', field: 'prescriptions', title: 'Rows, count', type: 'number' },
      ],
    }));
    built.tileGrid = tileGrid;

    /**
     * Rebuild the tile strip.
     *
     * The movement line compares the month on show with the same month a year
     * earlier, which is a second query rather than an arithmetic trick: a
     * month is not comparable with the one before it, because February is
     * three days shorter than January and prescribing follows the calendar.
     */
    function drawTiles() {
      const ago = built.yearAgoTotals;
      const readingOf = (field) => (rows) => {
        for (const row of rows) if (row.period === 'latest') return Number(row[field]);
        return null;
      };
      const tiles = [
        {
          id: 'items', label: 'Items dispensed', aggregation: 'custom',
          format: { type: 'compact', decimals: 2 },
          compute: readingOf('items'),
          ...(ago && ago.items ? { baseline: Number(ago.items) } : {}),
        },
        {
          id: 'cost', label: 'Actual cost, GBP', aggregation: 'custom',
          format: { type: 'compact', decimals: 2 },
          compute: readingOf('cost'),
          ...(ago && ago.cost ? { baseline: Number(ago.cost) } : {}),
        },
        {
          id: 'practices', label: 'Practices prescribing', aggregation: 'custom',
          format: { type: 'number', decimals: 0 },
          compute: readingOf('practices'),
          ...(ago && ago.practices ? { baseline: Number(ago.practices) } : {}),
        },
        {
          id: 'costPerItem', label: 'Cost per item, GBP', aggregation: 'custom',
          format: { type: 'number', decimals: 2 },
          compute: (rows) => {
            for (const row of rows) {
              if (row.period === 'latest' && row.items) return Number(row.cost) / Number(row.items);
            }
            return null;
          },
          ...(ago && ago.items ? { baseline: Number(ago.cost) / Number(ago.items) } : {}),
        },
      ];
      if (built.kpi && built.kpi.destroy) built.kpi.destroy();
      kpiStrip.textContent = '';
      built.kpi = createKPI(kpiStrip, {
        grid: tileGrid,
        rowKey: 'id',
        fields: ['id', 'period', 'items', 'cost', 'quantity', 'practices', 'prescriptions'],
        columns: 4,
        ariaLabel: 'The month on show, and how it compares with the same month a year earlier',
        tiles,
      });
      const agoLabel = ago ? D.monthLabel(D.yearBefore(view.month)) : null;
      kpiCaption.textContent = 'All of ' + D.monthLabel(view.month)
        + ', counted by the endpoint in one query over every row in the month'
        + (agoLabel ? '. The movement under each figure compares it with ' + agoLabel + '.' : '.');
    }

    /* ---------------- the main grid ---------------- */

    const panel = el('section', 'panel primary-host');
    const gridCaption = el('p', 'panel-caption');
    const gridPane = el('div', 'grid-pane');
    /*
     * The totals, written by the page under the grid rather than pinned inside
     * it. They are one query over everything the filter matched, so they
     * belong beside the grid whatever shape they are drawn in.
     */
    const totalsLine = el('p', 'totals-line');
    panel.append(gridCaption, gridPane, totalsLine);
    host.append(panel);

    /**
     * Build the main grid over one source.
     *
     * The grid is built with the source it is going to read, every time.
     * Handing a live source to a grid that already exists is the other way to
     * do it and it does not paint: the rows arrive, the model holds them, and
     * the windows past the first stay blank. So the grid is made anew when
     * what it reads changes, and the state a reader chose is carried across
     * here rather than hoped for.
     *
     * @param {object} sourceConfig the source to read
     * @returns {object} the grid
     */
    function makeMainGrid(sourceConfig) {
      const grid = createGrid(gridPane, baseGridConfig('What England prescribed', {
        columns: mainColumns(D.levelFor(view.level)),
        source: sourceConfig,
        /*
         * Find is off here on purpose. Over a windowed source it searches the
         * rows that happen to be loaded, and a search box on this page that
         * quietly meant "the hundred rows you can see" beside one that means
         * "every row in the month" would be two boxes that look the same and
         * answer different questions. The one above is the one that queries.
         */
        find: false,
      }));
      /* The order, set through the sort model rather than declared in the
         configuration: `sort` is not a configuration key, and a grid handed
         one says so and ignores it. Here it is also the ORDER BY. */
      grid.sort.set(built.sortModel.slice());
      if (built.appliedQuick) grid.filters.quick(built.appliedQuick);
      if (built.appliedFloor !== null) grid.filters.set({ col: 'cost', op: 'gte', value: built.appliedFloor });
      /* A window the source could not fetch is the grid's own event, not
         something this page has to notice for itself. */
      grid.on('source:error', (event) => {
        fail((event && event.error) || new Error('a window could not be fetched'));
      });
      /* The reader's own sort has to survive the next rebuild too. */
      grid.on('sort:changed', () => { built.sortModel = grid.sort.get(); });
      return grid;
    }

    /**
     * Replace the main grid with one reading `sourceConfig`, keeping what the
     * reader chose.
     *
     * @param {object} sourceConfig the source to read
     * @returns {void}
     */
    function rebuildMainGrid(sourceConfig) {
      built.sortModel = mainGrid.sort.get();
      mainGrid.destroy();
      gridPane.textContent = '';
      mainGrid = makeMainGrid(sourceConfig);
      built.mainGrid = mainGrid;
    }

    built.sortModel = [{ col: 'cost', dir: 'desc' }];
    /* The saved copy is a memory source, so the grid has rows to paint before
       the first query has been sent. */
    let mainGrid = makeMainGrid({ mode: 'memory', rows: snapshot.substances });
    built.mainGrid = mainGrid;

    /** The caption under the grid's title: what a row is, and how many. */
    function drawGridCaption() {
      const level = D.levelFor(view.level);
      gridCaption.textContent = level.caption + ' '
        + (built.isLive
          ? 'Every row you see came back from a query against ' + D.resourceFor(view.month) + '.'
          : 'These rows are the saved copy of the top ' + snapshot.substances.length
            + ' substances by cost. The live view replaces them as soon as the endpoint answers.');
    }

    /* ---------------- the query panel ---------------- */

    const querySection = el('section', 'query-panel');
    querySection.setAttribute('aria-label', 'The statements the grid sent');
    querySection.append(el('h2', 'query-title', 'Query'));
    const queryCaption = el('p', 'panel-caption',
      'The last ' + QUERY_LOG_LENGTH + ' statements the page has sent, newest first, as they were sent. Nothing '
      + 'is rewritten for display. A statement answered from the session memory was sent once and remembered, '
      + 'so scrolling back up costs nothing.');
    querySection.append(queryCaption);
    const queryList = el('ol', 'query-log');
    querySection.append(queryList);
    host.append(querySection);

    /** Redraw the query log. */
    function drawQueryLog() {
      queryList.textContent = '';
      for (const entry of built.queries) {
        const item = el('li', 'query-entry');
        const metaLine = el('div', 'query-meta');
        metaLine.append(el('span', 'query-label', entry.label));
        metaLine.append(el('span', 'query-source', entry.source));
        metaLine.append(el('span', 'query-ms', entry.status === 'sending'
          ? 'sending'
          : (entry.error ? 'failed' : D.fmt.seconds(entry.ms) + ', ' + D.fmt.int(entry.rows) + ' rows')));
        if (entry.status === 'sending') item.classList.add('query-entry--sending');
        item.append(metaLine);
        if (entry.error) item.append(el('p', 'query-error', entry.error));
        item.append(el('pre', 'query-sql', entry.sql));
        queryList.append(item);
      }
      if (!built.queries.length) {
        queryList.append(el('li', 'query-empty', 'No statement has been sent yet.'));
      }
    }
    drawQueryLog();

    /* ---------------- the charts ---------------- */

    const chapterGrid = createGrid(el('div', 'grid-pane hidden-grid'), baseGridConfig('Chapters', {
      rowKey: 'id', statusBar: false,
      columns: [
        { id: 'name', field: 'name', title: 'BNF chapter' },
        { id: 'items', field: 'items', title: 'Items, count', type: 'number' },
        { id: 'cost', field: 'cost', title: 'Actual cost, GBP', type: 'number' },
      ],
    }));
    const icbGrid = createGrid(el('div', 'grid-pane hidden-grid'), baseGridConfig('Care boards', {
      rowKey: 'id', statusBar: false,
      columns: [
        { id: 'name', field: 'name', title: 'Integrated care board' },
        { id: 'items', field: 'items', title: 'Items, count', type: 'number' },
        { id: 'cost', field: 'cost', title: 'Actual cost, GBP', type: 'number' },
      ],
    }));
    const trendGrid = createGrid(el('div', 'grid-pane hidden-grid'), baseGridConfig('One substance over time', {
      rowKey: 'id', statusBar: false,
      columns: [
        { id: 'month', field: 'month', title: 'Month' },
        { id: 'items', field: 'items', title: 'Items, count', type: 'number' },
        { id: 'cost', field: 'cost', title: 'Actual cost, GBP', type: 'number' },
      ],
    }));
    built.chapterGrid = chapterGrid;
    built.icbGrid = icbGrid;
    built.trendGrid = trendGrid;
    /* The order each chart draws in, through the sort model for the same
       reason as above. */
    chapterGrid.sort.set([{ col: 'cost', dir: 'desc' }]);
    icbGrid.sort.set([{ col: 'cost', dir: 'desc' }]);
    trendGrid.sort.set([{ col: 'month', dir: 'asc' }]);

    const chapterBox = el('div', 'chart-box tall');
    const icbBox = el('div', 'chart-box tall');
    const trendBox = el('div', 'chart-box tall');

    const tabsHost = el('section', 'tabs-host');
    host.append(tabsHost);

    const tabs = createTabs(tabsHost, {
      createGrid,
      tabs: [
        {
          id: 'chapters',
          label: 'Cost by chapter',
          view: (element) => {
            const pane = el('div', 'chart-tab');
            pane.append(el('p', 'panel-caption',
              'The ' + CHART_ROWS + ' British National Formulary chapters with the highest actual cost in the '
              + 'month, from one GROUP BY over every row in it. On the axis, m is million and k is '
              + 'thousand.'));
            pane.append(chapterBox);
            element.append(pane);
          },
        },
        {
          id: 'boards',
          label: 'Cost by care board',
          view: (element) => {
            const pane = el('div', 'chart-tab');
            pane.append(el('p', 'panel-caption',
              'The ' + CHART_ROWS + ' integrated care boards with the highest actual cost in the month. Names '
              + 'are shortened on the axis, where m is million and k is thousand; the grid above shows '
              + 'them as published.'));
            pane.append(icbBox);
            element.append(pane);
          },
        },
        {
          id: 'trend',
          label: 'One substance over time',
          view: (element) => {
            const pane = el('div', 'chart-tab');
            const bar = el('div', 'actions');
            bar.append(el('span', 'actions-label', 'Substance:'), substancePicker);
            pane.append(bar);
            pane.append(el('p', 'panel-caption',
              'Two years of one substance, as a single statement: twenty four monthly tables joined with UNION '
              + 'ALL and grouped by month. The publisher renamed several columns partway through the period, so '
              + 'each branch is written for its own month. On the axis, m is million and k is thousand.'));
            pane.append(trendBox);
            element.append(pane);
          },
        },
      ],
    });
    built.tabs = tabs;

    /**
     * Draw one chart into a container that may already hold one.
     *
     * A chart is a drawing in an element, and making a second one does not
     * remove the first: two drawings then sit in a box the height of one, and
     * the one a reader sees is the one that was there first. Which is to say
     * the page looked frozen. The old chart is taken down before the new one
     * goes up.
     *
     * @param {string} id which chart this is
     * @param {HTMLElement} container where it goes
     * @param {object} spec the rest of the chart specification
     * @returns {object} the chart
     */
    function drawChart(id, container, spec) {
      const previous = built.charts[id];
      if (previous && typeof previous.destroy === 'function') {
        try { previous.destroy(); } catch { /* already gone */ }
      }
      container.textContent = '';
      built.charts[id] = createChart(Object.assign({ container }, spec));
      return built.charts[id];
    }

    /** Redraw the three charts from whatever their grids hold. */
    function drawCharts() {
      /* The axis carries its unit and nothing else. The tick labels abbreviate
         a figure in the hundreds of millions, and what the abbreviation means
         is said in the caption above the chart, where there is room for it
         without landing on top of a tick. */
      const moneyAxis = 'Actual cost, GBP';
      drawChart('chapters', chapterBox, {
        grid: chapterGrid,
        type: 'horizontalBar',
        x: 'name',
        y: 'cost',
        title: 'Actual cost by BNF chapter, ' + D.monthLabel(view.month),
        axis: { x: { title: moneyAxis }, y: { title: '' } },
        scheme: 'colourblind',
        legend: false,
        tooltip: true,
      });
      drawChart('boards', icbBox, {
        grid: icbGrid,
        type: 'horizontalBar',
        x: 'name',
        y: 'cost',
        title: 'Actual cost by integrated care board, ' + D.monthLabel(view.month),
        axis: { x: { title: moneyAxis }, y: { title: '' } },
        scheme: 'colourblind',
        legend: false,
        tooltip: true,
      });
      drawChart('trend', trendBox, {
        grid: trendGrid,
        type: 'line',
        x: 'month',
        y: 'cost',
        title: view.substance + ': actual cost by month',
        /*
         * Bands, said out loud. The months come back as the text the publisher
         * writes them in, and the grid rightly points out that text which
         * reads as a date usually wants a continuous axis. Here it does not:
         * there are exactly twenty four of them, one per month, none missing,
         * so evenly spaced bands labelled as published are what a reader
         * wants, and a continuous axis would only add ticks nobody asked for.
         */
        axis: { x: { title: '', scale: 'band' }, y: { title: moneyAxis } },
        scheme: 'colourblind',
        legend: false,
        tooltip: true,
      });
    }

    /* ---------------- the router ---------------- */

    const router = createDataRouter({ key: 'kind', rowKey: 'id', overlap: true });
    built.router = router;
    router.attach(tileGrid, 'total', { label: 'month totals' });
    router.attach(chapterGrid, 'chapter', { label: 'chapters' });
    router.attach(icbGrid, 'icb', { label: 'care boards' });
    router.attach(trendGrid, 'trend', { label: 'trend' });

    /** Push whatever is known into the router, as one keyed difference. */
    function publish() {
      router.load(streamOf({
        totals: built.totals,
        yearAgoTotals: built.yearAgoTotals,
        chapters: built.chapters || snapshot.chapters,
        icbs: built.icbs || snapshot.icbs,
        trend: built.trend || snapshot.trend,
        substance: view.substance,
      }));
    }

    built.chapters = snapshot.chapters;
    built.icbs = snapshot.icbs;
    built.trend = snapshot.trend;
    publish();
    drawTiles();
    drawCharts();
    drawGridCaption();
    drawStatus();

    /**
     * Fill the substance picker.
     *
     * The saved copy is the floor, always, and the grid's own rows are added
     * on top of it when it has any. Reading the grid alone was wrong: a grid
     * that has just been rebuilt has no rows for a second or two, and a picker
     * filled from it in that moment ends up offering one option, or none. A
     * reader who then tries to choose a different substance finds there is no
     * different substance to choose, which looks exactly like a page that has
     * stopped responding.
     *
     * @returns {void}
     */
    function drawSubstancePicker() {
      const names = new Set();
      if (view.substance) names.add(view.substance);
      for (const row of snapshot.substances.slice(0, 60)) if (row.name) names.add(row.name);
      if (view.level === 'substance') {
        for (const row of mainGrid.rows.data().slice(0, 60)) if (row.name) names.add(row.name);
      }
      substancePicker.textContent = '';
      for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
        const option = el('option', null, name);
        option.value = name;
        substancePicker.append(option);
      }
      /* Never leave it showing nothing: a picker with no chosen value is one
         `change` away from asking the endpoint about a substance called "". */
      if (!view.substance || !names.has(view.substance)) {
        view.substance = names.has(meta.defaultSubstance) ? meta.defaultSubstance : [...names][0];
      }
      substancePicker.value = view.substance;
    }
    drawSubstancePicker();

    /* ---------------- the totals ---------------- */

    /**
     * The totals, which are their own query over everything the filter
     * matches rather than a sum of the rows on screen.
     *
     * A windowed grid holds one page. Adding that page up and calling it a
     * total would put a number under the column that changes when the reader
     * scrolls, which is the most confident way to be wrong on a page like
     * this. So it is asked for.
     */
    async function refreshTotalsRow() {
      if (!built.isLive) {
        drawTotalsLine(savedTotals());
        return;
      }
      /*
       * Answers do not come back in the order they were asked for, and the
       * fast ones are the dangerous ones. A statement the page has already
       * seen is answered from memory in the same tick, while the one asked
       * for before it is still crossing the Atlantic: without this, changing
       * what a row is and changing it back again left the earlier answer
       * landing last, and the totals under a grid of substances read
       * "Total of 8,760 practices". Only the newest request may write.
       */
      const seq = ++totalsSeq;
      const asked = { month: view.month, level: view.level };
      const statement = D.matchTotalsSql(queryState());
      try {
        const records = await client.run(statement, { label: 'totals row' });
        /* Two guards, because they answer different questions. The sequence
           says "something newer has been asked for since". The view says
           "this answer does not describe what is on screen", which is the
           thing that actually matters and is true of a stale answer however
           it got here. */
        if (seq !== totalsSeq) return;
        if (asked.month !== view.month || asked.level !== view.level) return;
        const row = records[0] || {};
        built.matched = {
          matched: Number(row.matched), items: Number(row.items), cost: Number(row.cost),
          quantity: Number(row.quantity), costPerItem: Number(row.costPerItem),
        };
        drawTotalsLine({
          label: totalsLabel(built.matched.matched, asked),
          items: built.matched.items,
          cost: built.matched.cost,
          quantity: built.matched.quantity,
          costPerItem: built.matched.costPerItem,
        });
      } catch (error) {
        fail(error);
      }
    }

    /**
     * What the totals are called, given how many rows they cover.
     *
     * Named from the state the question was asked in rather than from the
     * state the page happens to be in when the answer lands, so the label and
     * the figures beside it always describe the same query.
     *
     * @param {number} matched how many rows the filter matched
     * @param {object} asked the month and level the query named
     * @returns {string} the label
     */
    function totalsLabel(matched, asked) {
      const level = D.levelFor(asked.level);
      const noun = level.label.toLowerCase() + (matched === 1 ? '' : 's');
      return 'Total of ' + D.fmt.int(matched) + ' ' + noun + ', ' + D.monthLabel(asked.month);
    }

    /** The totals while the page is still on the saved copy. */
    function savedTotals() {
      const totals = meta.totals;
      return {
        label: 'Total of ' + D.fmt.int(meta.substancesInLatestMonth) + ' chemical substances, '
          + D.monthLabel(meta.latest) + ' (saved copy)',
        items: totals.items,
        cost: totals.cost,
        quantity: totals.quantity,
        costPerItem: totals.cost / totals.items,
      };
    }

    /**
     * Write the totals line.
     *
     * @param {object} totals `{ label, items, cost, quantity, costPerItem }`
     * @returns {void}
     */
    function drawTotalsLine(totals) {
      built.totalsLine = totals;
      totalsLine.textContent = totals.label + ': '
        + D.fmt.int(totals.items) + ' items, '
        + D.fmt.money(totals.cost) + ' actual cost, '
        + D.fmt.int(totals.quantity) + ' total quantity, '
        + D.fmt.money2(totals.costPerItem) + ' per item. '
        + 'Counted over every row the filter matched, not over the rows on screen.';
    }
    drawTotalsLine(savedTotals());

    /** Which totals request is the newest. An older answer is dropped. */
    let totalsSeq = 0;

    /** The state the SQL builder takes, for the queries the page owns. */
    function queryState() {
      return {
        month: view.month,
        level: view.level,
        schemaMap: view.schemaMap,
        filters: mainGrid.filters.get(),
        quick: mainGrid.filters.quickState().text,
        sort: mainGrid.sort.get(),
        start: 0,
        end: PAGE_SIZE,
      };
    }

    /** Record a failure and say so on the page, keeping the last good result. */
    function fail(error) {
      built.lastError = String((error && error.message) || error);
      drawStatus();
    }

    /* ---------------- going live ---------------- */

    /**
     * Replace the saved copy with the endpoint.
     *
     * The main grid's source is swapped for a pushdown source, which is the
     * supported way to change what a grid reads without rebuilding it: the
     * columns, the sort and the filters in force are all kept.
     */
    async function goLive() {
      if (!built.liveEnabled) {
        drawStatus();
        return;
      }
      /*
       * One cheap question first, before anything on screen is disturbed.
       *
       * Replacing the source and then finding out is the wrong order: the grid
       * would have thrown away five hundred rows that are on screen and true
       * in exchange for a source that cannot fill itself, and a reader would
       * be looking at an empty table under a banner that said "live". So the
       * endpoint is asked for the month's totals, and only an answer buys the
       * swap.
       */
      try {
        const now = await client.run(D.totalsSql(view.month), { label: 'month totals' });
        built.totals = numbersOf(now[0]);
        built.rowsInMonth = built.totals.prescriptions;
      } catch (error) {
        fail(error);
        return;
      }
      try {
        await refreshMonths();
      } catch (error) {
        /* A month list that could not be read is not fatal: the saved copy
           carries one, and it is the list the page opened with. */
        fail(error);
      }
      rebuildMainGrid(S.createEpdSource({ view, client, createPushdownSource, pageSize: PAGE_SIZE }));
      built.isLive = true;
      built.lastError = null;
      enableControls(true);
      drawGridCaption();
      drawStatus();
      await refreshEverything();
      drawSubstancePicker();
    }


    /** Read the months the dataset holds now, rather than when it was saved. */
    async function refreshMonths() {
      const response = await fetch(D.API + '/package_show?id=' + D.DATASET, { cache: 'no-store' });
      if (!response.ok) throw new Error('the dataset listing answered HTTP ' + response.status);
      const body = await response.json();
      const names = (body.result.resources || [])
        .map((resource) => resource.name)
        .filter((name) => /^EPD_SNOMED_\d{6}$/.test(name))
        .sort()
        .reverse()
        .slice(0, 24)
        .map((name) => name.slice(-6, -2) + '-' + name.slice(-2));
      if (!names.length) throw new Error('the dataset listed no monthly tables');
      built.months = names;
      if (!names.includes(view.month)) view.month = names[0];
      drawMonths();
    }

    /**
     * The tiles, the charts and the totals, all from the endpoint.
     *
     * On the first pass the month's totals have already been asked for, by the
     * probe that decided the endpoint was answering; asking again costs
     * nothing, because an identical statement is answered from the session's
     * memory and says so in the panel.
     */
    async function refreshEverything() {
      const seq = ++viewSeq;
      await refreshTotals();
      if (seq !== viewSeq) return;
      await refreshChapters();
      if (seq !== viewSeq) return;
      await refreshBoards();
      if (seq !== viewSeq) return;
      await refreshTrend();
      if (seq !== viewSeq) return;
      await refreshTotalsRow();
      if (seq !== viewSeq) return;
      publish();
      drawTiles();
      drawCharts();
    }

    /** Which whole-page refresh is the newest. An older one stops where it is. */
    let viewSeq = 0;

    /** The month's totals, and the same month a year earlier. */
    async function refreshTotals() {
      try {
        const now = await client.run(D.totalsSql(view.month), { label: 'month totals' });
        built.totals = numbersOf(now[0]);
        built.rowsInMonth = built.totals.prescriptions;
      } catch (error) { fail(error); return; }
      const ago = D.yearBefore(view.month);
      if (!built.months.includes(ago) && !meta.months.includes(ago)) { built.yearAgoTotals = null; return; }
      try {
        const before = await client.run(D.totalsSql(ago), { label: 'the same month a year earlier' });
        built.yearAgoTotals = numbersOf(before[0]);
      } catch {
        /* A year earlier that is not published is not a failure of this page:
           the tiles simply show no movement. */
        built.yearAgoTotals = null;
      }
    }

    /** Every value of a totals record, as numbers. */
    function numbersOf(record) {
      const out = {};
      for (const key of ['items', 'cost', 'quantity', 'practices', 'prescriptions']) out[key] = Number(record[key]);
      return out;
    }

    async function refreshChapters() {
      try {
        built.chapters = await client.run(D.chapterSql(view.month, CHART_ROWS), { label: 'cost by chapter' });
      } catch (error) { fail(error); }
    }

    async function refreshBoards() {
      try {
        built.icbs = await client.run(D.icbSql(view.month, view.schemaMap), { label: 'cost by care board' });
      } catch (error) { fail(error); }
    }

    async function refreshTrend() {
      const months = built.months.slice(0, 24);
      const statement = D.trendSql(view.substance, months, view.schemaMap);
      if (!statement) return;
      try {
        built.trend = await client.run(statement, { label: 'two years of one substance' });
      } catch (error) {
        /* The multi month statement is a measured behaviour rather than a
           documented one, so being refused is a case worth handling: the
           chart keeps the last good series and the page says why. */
        fail(error);
      }
    }

    /* ---------------- what the controls do ---------------- */

    monthPicker.addEventListener('change', async () => {
      view.month = monthPicker.value;
      if (!built.isLive) { drawStatus(); return; }
      rebuildMainGrid(S.createEpdSource({ view, client, createPushdownSource, pageSize: PAGE_SIZE }));
      await refreshEverything();
      drawGridCaption();
      drawStatus();
    });

    levelPicker.addEventListener('change', async () => {
      view.level = levelPicker.value;
      rebuildMainGrid(built.isLive
        ? S.createEpdSource({ view, client, createPushdownSource, pageSize: PAGE_SIZE })
        : { mode: 'memory', rows: snapshot.substances });
      drawGridCaption();
      if (built.isLive) await refreshTotalsRow();
      drawSubstancePicker();
    });

    /**
     * Put what the controls say into the grid, if it is not there already.
     *
     * The controls are the truth and the grid is downstream of them, so this
     * is written as "make the grid agree with the boxes" rather than as "do
     * this when a key is pressed". That distinction is the whole point: a
     * keystroke that lands while a statement is in flight used to be applied
     * against a grid that was about to be replaced, and the reader was left
     * looking at the answer to the question before theirs.
     *
     * Idempotent, so it can be called from the debounce, from a change event
     * and from the completion of any statement without looping.
     *
     * @returns {boolean} whether anything actually changed
     */
    function applyControls() {
      const text = search.value.trim();
      const raw = costFloor.value;
      const value = Number(raw);
      const floor = (raw === '' || !Number.isFinite(value)) ? null : value;
      let changed = false;
      if (text !== built.appliedQuick) {
        built.appliedQuick = text;
        mainGrid.filters.quick(text);
        changed = true;
      }
      if (floor !== built.appliedFloor) {
        built.appliedFloor = floor;
        mainGrid.filters.set(floor === null ? null : { col: 'cost', op: 'gte', value: floor });
        changed = true;
      }
      return changed;
    }

    /**
     * Called when any statement lands: if the controls have moved on since the
     * grid was last told, tell it now. Nothing a reader typed is dropped
     * because the page was busy when they typed it.
     *
     * @returns {void}
     */
    function catchUp() {
      if (!built.isLive || searchTimer) return;
      if (applyControls()) refreshTotalsRow();
    }
    built.catchUp = catchUp;
    built.applyControls = applyControls;

    let searchTimer = null;
    /** The debounce, from the last keystroke rather than from the first. */
    const scheduleSearch = () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        searchTimer = null;
        /* Three hundred milliseconds after the last keystroke, not one query
           per letter: somebody else's public endpoint does not need that. */
        if (applyControls() && built.isLive) await refreshTotalsRow();
      }, SEARCH_DEBOUNCE_MS);
    };
    /* `input` covers typing and pasting; `change` covers a value committed by
       a blur, by Enter, or by a tool driving the page. */
    search.addEventListener('input', scheduleSearch);
    search.addEventListener('change', scheduleSearch);

    costFloor.addEventListener('change', async () => {
      if (applyControls() && built.isLive) await refreshTotalsRow();
    });
    costFloor.addEventListener('input', scheduleSearch);

    clearButton.addEventListener('click', async () => {
      search.value = '';
      costFloor.value = '';
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
      built.appliedQuick = '';
      built.appliedFloor = null;
      mainGrid.filters.clear();
      if (built.isLive) await refreshTotalsRow();
    });

    substancePicker.addEventListener('change', async () => {
      /* A select that was handed a value it has no option for reports the
         empty string. There is no such substance, so there is nothing to ask. */
      if (!substancePicker.value) { substancePicker.value = view.substance; return; }
      view.substance = substancePicker.value;
      if (!built.isLive) return;
      await refreshTrend();
      publish();
      drawCharts();
    });

    /* ---------------- the credit ---------------- */

    const foot = el('footer', 'foot');
    const source = el('p', null, 'Source: NHS Business Services Authority, English Prescribing Dataset (EPD). '
      + 'Contains public sector information licensed under the Open Government Licence v3.0. ');
    const ogl = el('a', null, 'Open Government Licence v3.0');
    ogl.href = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';
    ogl.rel = 'noopener';
    source.append(ogl);
    foot.append(source);
    const portal = el('p');
    const portalLink = el('a', null, 'NHSBSA Open Data Portal');
    portalLink.href = 'https://opendata.nhsbsa.net/dataset/' + D.DATASET;
    portalLink.rel = 'noopener';
    portal.append('The dataset: ', portalLink, '. The endpoint is keyless and answers cross-origin requests, '
      + 'which is what lets this page query it from your browser.');
    foot.append(portal);
    foot.append(el('p', null, 'Built with Lattice Grid, loaded from a CDN by script tag.'));
    host.append(foot);

    /* Going live is deliberately not awaited: the page is already drawn and
       usable from the saved copy, and the first query takes a second or two. */
    built.ready = goLive().catch((error) => { fail(error); }).then(() => built);

    /** How many statements are out. Zero means the page is waiting for nothing. */
    built.pending = () => client.state.pending;
    built.goLive = goLive;
    built.refreshEverything = refreshEverything;
    built.refreshTotalsRow = refreshTotalsRow;
    built.drawSubstancePicker = drawSubstancePicker;
    built.controls = { monthPicker, levelPicker, search, costFloor, clearButton, substancePicker };
    return built;
  }

  root.NhsPrescribing = { readSnapshot, buildDashboard, streamOf, shortenBoard, mainColumns };
})(window);
