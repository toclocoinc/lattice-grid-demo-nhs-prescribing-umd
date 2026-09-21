/**
 * The endpoint, and the adapter that lets the grid drive it.
 *
 * The grid hands a pushdown adapter a structured request: the window it wants,
 * the sort in force, the filter tree, the quick search text. This file turns
 * that into one SQL statement, sends it to the NHSBSA endpoint, and hands the
 * rows back. Nothing here decides what the statement says: that is
 * `epd-data.js`, so the text can be shown on the page exactly as it was sent.
 *
 * Three rules about being a polite guest on somebody else's public endpoint,
 * and all three are enforced here rather than hoped for:
 *
 *   one statement in flight at a time, per client. Dragging a scrollbar
 *   asks for a dozen windows in a second, and a dozen parallel queries against
 *   a shared analytics service is how a demo gets an open dataset rate
 *   limited. They queue.
 *
 *   an identical statement is answered from the session's memory. Scrolling
 *   back to the top, or switching away from a level and back, is free.
 *
 *   a truncated answer is a failure, not a short page. Past 32,000 rows the
 *   endpoint answers HTTP 200 with `records_truncated` and a link to a file
 *   instead of records. Reading that as an empty result would draw an empty
 *   grid over a query that worked.
 */
(function (root) {
  'use strict';

  const { SQL_URL, ROW_CEILING } = root.EpdData;

  /**
   * A client for the endpoint: one in flight, a session cache, and a log.
   *
   * @param {object} options `{ onQuery }`, called for every statement run
   * @returns {object} the client
   */
  function createClient(options) {
    const onQuery = (options && options.onQuery) || (() => {});
    const cache = new Map();
    const inFlight = new Map();
    /** The tail of the queue. Every request waits for the one before it. */
    let queue = Promise.resolve();
    const state = { lastMs: null, lastAt: null, failures: 0, ok: 0 };

    /**
     * Run one statement.
     *
     * @param {object} statement `{ sql, resource }` from `EpdData`
     * @param {object} [opts] `{ label, signal }`
     * @returns {Promise<object[]>} the records
     */
    function run(statement, opts) {
      const label = (opts && opts.label) || 'query';
      const signal = opts && opts.signal;
      const key = statement.resource + '\n' + statement.sql;

      if (cache.has(key)) {
        const rows = cache.get(key);
        onQuery({
          label, sql: statement.sql, resource: statement.resource,
          ms: 0, rows: rows.length, source: 'session memory', at: Date.now(),
        });
        return Promise.resolve(rows);
      }
      if (inFlight.has(key)) return inFlight.get(key);

      const work = queue.then(async () => {
        if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
        const url = SQL_URL
          + '?resource_id=' + encodeURIComponent(statement.resource)
          + '&sql=' + encodeURIComponent(statement.sql);
        const started = Date.now();
        let response;
        try {
          response = await fetch(url, { headers: { accept: 'application/json' }, signal });
        } catch (error) {
          /* The request never completed: no DNS, no route, an extension or a
             policy in the way. The browser's own message for all of those is
             "Failed to fetch", which on its own tells a reader nothing about
             where the page was trying to go. */
          if (signal && signal.aborted) throw error;
          state.failures += 1;
          const ms = Date.now() - started;
          state.lastMs = ms;
          state.lastAt = started;
          const reason = 'the request to opendata.nhsbsa.net did not complete ('
            + String((error && error.message) || error) + ')';
          onQuery({
            label, sql: statement.sql, resource: statement.resource,
            ms, rows: 0, source: 'endpoint', error: reason, at: started,
          });
          throw new Error(reason);
        }
        const body = await response.json().catch(() => null);
        const ms = Date.now() - started;
        state.lastMs = ms;
        state.lastAt = started;

        const inner = body && body.result && body.result.result;
        const records = inner && inner.records;
        const truncated = inner && String(inner.records_truncated) === 'true';

        if (!response.ok || !records || truncated) {
          state.failures += 1;
          const reason = truncated
            ? 'the endpoint returned more than ' + ROW_CEILING.toLocaleString('en-GB')
              + ' rows and sent a file instead of records'
            : ((body && body.error && body.error.message)
              || ('the endpoint answered HTTP ' + response.status));
          onQuery({
            label, sql: statement.sql, resource: statement.resource,
            ms, rows: 0, source: 'endpoint', error: reason, at: started,
          });
          throw new Error(reason);
        }

        state.ok += 1;
        cache.set(key, records);
        onQuery({
          label, sql: statement.sql, resource: statement.resource,
          ms, rows: records.length, source: 'endpoint', at: started,
        });
        return records;
      });

      inFlight.set(key, work);
      /* The queue must advance whether this one worked or not, and it must not
         inherit the rejection: a failed query is the caller's to handle, not a
         reason for every later query to fail too. */
      queue = work.then(() => {}, () => {});
      work.then(() => inFlight.delete(key), () => inFlight.delete(key));
      return work;
    }

    return {
      run,
      state,
      /** Forget every remembered answer, so the next read goes to the endpoint. */
      clear() { cache.clear(); },
      get cached() { return cache.size; },
    };
  }

  /**
   * The adapter the grid's pushdown source drives.
   *
   * It declares exactly what `EpdData` writes and nothing more. A capability
   * declared here that the SQL builder does not honour would not slow the page
   * down: it would draw the wrong rows and say nothing, because the grid would
   * believe the window it was handed was the whole filtered set.
   *
   * @param {object} view the mutable view state: `{ month, level, schemaMap }`
   * @param {object} client the endpoint client
   * @returns {object} a pushdown adapter
   */
  function createAdapter(view, client) {
    const counts = new Map();
    const plan = { unpushed: [], sql: null, countSql: null };

    /** The query state the SQL builder takes, from one grid request. */
    const stateOf = (query) => ({
      month: view.month,
      level: view.level,
      schemaMap: view.schemaMap,
      filters: query.filters || null,
      quick: query.quick || '',
      sort: query.sort || [],
      start: query.range ? query.range.start : 0,
      end: query.range ? query.range.end : 100,
    });

    return {
      name: 'NHSBSA English Prescribing Dataset',
      capabilities: {
        filter: 'tree',
        operators: root.EpdData.OPERATORS,
        sort: 'multi',
        quick: true,
        range: true,
        total: true,
      },
      /** What the last request was written as, for the panel under the grid. */
      plan,
      async execute(query) {
        const state = stateOf(query);
        const statement = root.EpdData.rowsSql(state);
        plan.unpushed = statement.unpushed;
        plan.sql = statement.sql;

        const rows = await client.run(statement, { label: 'grid rows', signal: query.signal });

        /* The count is the same filter asked a different question, so it is
           remembered against the filter rather than against the window: it
           does not change as the reader scrolls. */
        const count = root.EpdData.countSql(state);
        plan.countSql = count.sql;
        let total = counts.get(count.sql);
        if (total === undefined) {
          try {
            const answer = await client.run(count, { label: 'matching rows', signal: query.signal });
            total = Number(answer && answer[0] && answer[0].n);
            if (!Number.isFinite(total)) total = undefined;
            else counts.set(count.sql, total);
          } catch {
            /* A count that failed is a count the grid does not get. The rows
               are already in hand and are the right rows; the scrollbar just
               has nothing to size itself against, which the grid handles. */
            total = undefined;
          }
        }

        return { rows: rows.map(normalise), total };
      },
    };
  }

  /**
   * One record, as the grid should hold it.
   *
   * The endpoint returns every number as a JSON number already, but a NULL
   * comes back as null and a substance with no name comes back as the empty
   * string. A row needs a key, and an empty key is not one, so an unnamed
   * group is given the publisher's own wording rather than a blank line.
   *
   * @param {object} record one record from the endpoint
   * @returns {object} the row
   */
  function normalise(record) {
    const row = Object.assign({}, record);
    if (row.name == null || row.name === '') row.name = 'Not stated by the publisher';
    return row;
  }

  /**
   * Build the source configuration the main grid reads from.
   *
   * @param {object} options `{ view, client, createPushdownSource, pageSize }`
   * @returns {object} the source configuration, carrying its adapter
   */
  function createEpdSource(options) {
    const adapter = createAdapter(options.view, options.client);
    const source = options.createPushdownSource({
      adapter,
      pageSize: options.pageSize || 100,
    });
    source.adapter = adapter;
    return source;
  }

  root.EpdSource = { createClient, createAdapter, createEpdSource, normalise };
})(window);
