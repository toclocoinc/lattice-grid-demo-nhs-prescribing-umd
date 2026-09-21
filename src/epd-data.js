/**
 * What the data is, where it lives, and how a grid state becomes SQL.
 *
 * The English Prescribing Dataset is every prescription item dispensed in
 * England, one row per practice per presentation per month. July 2026 holds
 * 18,601,776 rows. NHS Business Services Authority publish it through a CKAN
 * portal that puts a real SQL endpoint in front of each month, keyless, with
 * `access-control-allow-origin: *`, so a browser can query it directly.
 *
 * Everything in this file is a fact about that endpoint, measured against it
 * rather than assumed. The measurements are in README.md.
 *
 * This file builds SQL text and nothing else. It never fetches: that is
 * `epd-source.js`, so the statements can be read, logged and shown on the page
 * separately from the requests that carry them.
 */
(function (root) {
  'use strict';

  /** The CKAN action API. Keyless, and it answers cross-origin requests. */
  const API = 'https://opendata.nhsbsa.net/api/3/action';

  /** The dataset whose resources are the monthly tables. */
  const DATASET = 'english-prescribing-dataset-epd-with-snomed-code';

  /**
   * The SQL endpoint takes the resource NAME in backticks as the table, and
   * the same name again as `resource_id`. A resource UUID in `resource_id` is
   * answered 404, which is the one thing about this API that is not guessable
   * from the CKAN documentation.
   */
  const SQL_URL = API + '/datastore_search_sql';

  /**
   * The inline row ceiling, measured: 32,000 rows come back, 32,001 do not.
   * Past it the endpoint answers HTTP 200 with `records_truncated: "true"` and
   * a link to a gzipped CSV in cloud storage instead of records, so a reader
   * that only checks the status code sees success and no rows. Every query
   * this page sends is a grouped one well under that, and the source refuses a
   * truncated answer rather than drawing it.
   */
  const ROW_CEILING = 32000;

  /** A month's table name, from its `YYYY-MM`. */
  const resourceFor = (ym) => 'EPD_SNOMED_' + String(ym).replace('-', '');

  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  /** `2026-07` as `July 2026`. */
  function monthLabel(ym) {
    const parts = String(ym).split('-');
    const index = Number(parts[1]) - 1;
    return MONTH_NAMES[index] ? MONTH_NAMES[index] + ' ' + parts[0] : String(ym);
  }

  /** The same month a year earlier, as `YYYY-MM`. */
  const yearBefore = (ym) => (Number(String(ym).slice(0, 4)) - 1) + '-' + String(ym).slice(5, 7);

  /**
   * The monthly tables do not all have the same columns.
   *
   * From March 2025 the publisher renamed several: the chemical substance's
   * name moved from `CHEMICAL_SUBSTANCE_BNF_DESCR` to `BNF_CHEMICAL_SUBSTANCE`
   * (which had held the code), the presentation from `BNF_DESCRIPTION` to
   * `BNF_PRESENTATION_NAME`, and `YEAR_MONTH` changed from the number 202502
   * to the text '2025-03'. Older tables again use `STP_NAME` where newer ones
   * use `ICB_NAME`.
   *
   * `tools/build-snapshot.mjs` reads the real column list of every month it
   * saves and writes the flavour into `data/snapshot/months.json`, so the page
   * never guesses for a month it knows. A month published after the saved copy
   * was built is read as the newest flavour, which is what a new month is.
   */
  const SCHEMAS = {
    current: {
      substance: 'BNF_CHEMICAL_SUBSTANCE', presentation: 'BNF_PRESENTATION_NAME',
      icb: 'ICB_NAME', ymText: true,
    },
    legacy: {
      substance: 'CHEMICAL_SUBSTANCE_BNF_DESCR', presentation: 'BNF_DESCRIPTION',
      icb: 'ICB_NAME', ymText: false,
    },
    early: {
      substance: 'CHEMICAL_SUBSTANCE_BNF_DESCR', presentation: 'BNF_DESCRIPTION',
      icb: 'STP_NAME', ymText: false,
    },
  };

  /**
   * The flavour of a month, from the saved map, defaulting to the newest.
   *
   * @param {string} ym the month, `YYYY-MM`
   * @param {object} [map] month to flavour name, from the saved copy
   * @returns {object} the flavour
   */
  function schemaFor(ym, map) {
    const named = map && map[ym];
    return SCHEMAS[named] || SCHEMAS.current;
  }

  /**
   * What a row of the main grid is.
   *
   * Each level is one `GROUP BY` key. Changing it changes the statement the
   * grid sends and therefore what a row means, which is the point of the
   * control: 1,623 substances, 19 chapters, 37 integrated care boards and
   * 8,760 practices in July 2026, every one of those counts produced by the
   * endpoint rather than by this page.
   */
  const LEVELS = [
    {
      id: 'substance',
      label: 'Chemical substance',
      title: 'Chemical substance',
      width: 290,
      key: (schema) => schema.substance,
      extras: [],
      caption: 'One row per chemical substance, which is the active ingredient rather than the brand or the pack size.',
    },
    {
      id: 'chapter',
      label: 'BNF chapter',
      title: 'BNF chapter',
      width: 320,
      key: () => 'BNF_CHAPTER_PLUS_CODE',
      extras: [],
      caption: 'One row per British National Formulary chapter, the top level of the prescribing classification.',
    },
    {
      id: 'icb',
      label: 'Integrated care board',
      title: 'Integrated care board',
      width: 330,
      key: (schema) => schema.icb,
      extras: [
        { id: 'region', expr: 'ANY_VALUE(REGIONAL_OFFICE_NAME)', title: 'Region', width: 160 },
      ],
      caption: 'One row per integrated care board, the bodies that commission care in England.',
    },
    {
      id: 'practice',
      label: 'Practice',
      title: 'Practice',
      width: 250,
      key: () => 'PRACTICE_NAME',
      extras: [
        { id: 'code', expr: 'ANY_VALUE(PRACTICE_CODE)', title: 'Practice code', width: 122 },
        { id: 'icb', expr: (schema) => 'ANY_VALUE(' + schema.icb + ')', title: 'Integrated care board', width: 230 },
      ],
      caption: 'One row per prescribing practice. Items the publisher could not match to a practice are gathered under an unidentified name of their own.',
    },
  ];

  /** A level by id, falling back to the first. */
  const levelFor = (id) => LEVELS.find((level) => level.id === id) || LEVELS[0];

  /**
   * The measures every level carries, and the aggregate each one is.
   *
   * `cost` is ACTUAL_COST, what the NHS actually paid after the dispensing
   * discount, not the list price in NIC. The two differ by several per cent
   * and the difference matters to anyone reading the figure, so the heading
   * says which it is.
   *
   * Every aggregate casts before it sums. The older monthly tables type
   * `ITEMS` and `ACTUAL_COST` as text in places, and `SUM` over text is
   * refused outright rather than coerced.
   */
  const METRICS = [
    {
      id: 'items', title: 'Items', unit: 'count', width: 118,
      expr: 'SUM(SAFE_CAST(ITEMS AS FLOAT64))',
      format: { type: 'number', decimals: 0, thousandsSeparator: true },
    },
    {
      id: 'cost', title: 'Actual cost', unit: 'GBP', width: 150,
      expr: 'SUM(SAFE_CAST(ACTUAL_COST AS FLOAT64))',
      format: { type: 'number', decimals: 0, thousandsSeparator: true },
    },
    {
      id: 'quantity', title: 'Total quantity', unit: 'count', width: 150,
      expr: 'SUM(SAFE_CAST(TOTAL_QUANTITY AS FLOAT64))',
      format: { type: 'number', decimals: 0, thousandsSeparator: true },
    },
    {
      id: 'costPerItem', title: 'Cost per item', unit: 'GBP', width: 138,
      expr: 'SAFE_DIVIDE(SUM(SAFE_CAST(ACTUAL_COST AS FLOAT64)), SUM(SAFE_CAST(ITEMS AS FLOAT64)))',
      format: { type: 'number', decimals: 2, thousandsSeparator: true },
    },
  ];

  const METRIC_IDS = METRICS.map((metric) => metric.id);
  const metricFor = (id) => METRICS.find((metric) => metric.id === id) || null;

  /* ------------------------------------------------------------------ */
  /* Writing SQL                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * A string literal for the endpoint.
   *
   * The endpoint takes SQL in a query parameter and offers no way to bind a
   * value, so every value this page sends is escaped here and nowhere else.
   * The backslash goes first, because the engine treats a backslash inside a
   * string literal as an escape; control characters are dropped rather than
   * escaped, since none of them belongs in a value a reader typed.
   *
   * @param {unknown} value the value to write
   * @returns {string} the literal, quotes included
   */
  function lit(value) {
    const raw = String(value == null ? '' : value);
    let text = '';
    for (const ch of raw) {
      const code = ch.codePointAt(0);
      /* A control character cannot appear in a value worth sending, and the
         engine has its own opinion about several of them, so they are dropped
         rather than escaped. */
      if (code < 32 || code === 127) continue;
      if (ch === '\\') text += '\\\\';
      else if (ch === "'") text += "\\'";
      else text += ch;
    }
    return "'" + text + "'";
  }

  /** A number literal, or null when the value is not a finite number. */
  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : null;
  }

  /**
   * Escape the characters LIKE treats as special, fit the text into a shape,
   * and quote the result.
   *
   * @param {string} text the reader's text
   * @param {string} shape where the text goes, with `@` standing for it
   * @returns {string} the literal
   */
  function likeLit(text, shape) {
    const escaped = String(text == null ? '' : text).replace(/[\\%_]/g, (c) => '\\' + c);
    return lit(shape.replace('@', escaped));
  }

  /**
   * The comparisons this page genuinely writes.
   *
   * Declaring one the builder below does not emit would return the wrong rows
   * silently, so the list and the switch are written together and the source
   * declares exactly this array and nothing more.
   */
  const OPERATORS = [
    'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between', 'notBetween',
    'in', 'notIn', 'contains', 'notContains', 'startsWith', 'endsWith',
    'blank', 'notBlank',
  ];

  /**
   * One condition as SQL, given the expression the column stands for.
   *
   * Returns null when the condition cannot be written, which the caller turns
   * into "this part stayed with the grid" rather than into a silent pass.
   *
   * @param {string} expr the column's SQL expression
   * @param {object} condition the filter-wire condition
   * @param {boolean} text whether the expression is a text column
   * @returns {string|null} the predicate, or null
   */
  function conditionSql(expr, condition, text) {
    const op = condition.op;
    const value = condition.value;
    const one = () => (text ? lit(value) : num(value));
    if (op === 'blank') return text ? '(' + expr + ' IS NULL OR ' + expr + " = '')" : expr + ' IS NULL';
    if (op === 'notBlank') return text ? '(' + expr + ' IS NOT NULL AND ' + expr + " != '')" : expr + ' IS NOT NULL';
    if (op === 'contains' || op === 'notContains' || op === 'startsWith' || op === 'endsWith') {
      if (!text) return null;
      const shape = op === 'startsWith' ? '@%' : (op === 'endsWith' ? '%@' : '%@%');
      const keyword = op === 'notContains' ? 'NOT LIKE' : 'LIKE';
      return 'LOWER(' + expr + ') ' + keyword + ' ' + likeLit(String(value).toLowerCase(), shape);
    }
    if (op === 'in' || op === 'notIn') {
      const list = Array.isArray(value) ? value : [value];
      const parts = list.map((v) => (text ? lit(v) : num(v))).filter((v) => v !== null);
      if (!parts.length) return null;
      return expr + (op === 'in' ? ' IN (' : ' NOT IN (') + parts.join(', ') + ')';
    }
    if (op === 'between' || op === 'notBetween') {
      const pair = Array.isArray(value) ? value : [];
      const lo = text ? lit(pair[0]) : num(pair[0]);
      const hi = text ? lit(pair[1]) : num(pair[1]);
      if (lo === null || hi === null) return null;
      return expr + (op === 'notBetween' ? ' NOT BETWEEN ' : ' BETWEEN ') + lo + ' AND ' + hi;
    }
    const symbols = { eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' };
    const symbol = symbols[op];
    const written = one();
    if (!symbol || written === null) return null;
    return expr + ' ' + symbol + ' ' + written;
  }

  /**
   * A filter tree as SQL, split into the part that narrows rows before the
   * grouping and the part that narrows the groups after it.
   *
   * A condition on a dimension is a WHERE; a condition on a measure is a
   * HAVING, because a measure does not exist until the rows are grouped. A
   * group mixing the two is written only when every condition in it lands on
   * the same side, and reported as unpushed when it does not: an OR across a
   * WHERE and a HAVING is not two predicates, and writing it as if it were
   * would return more rows than the filter allows.
   *
   * @param {object|null} node the filter set
   * @param {object} context `{ columns }`, the column expressions
   * @returns {{where: string[], having: string[], unpushed: boolean}} the split
   */
  function splitFilter(node, context) {
    const out = { where: [], having: [], unpushed: false };
    if (!node) return out;
    const write = (n) => {
      if (!n) return null;
      if (n.op === 'and' || n.op === 'or' || n.op === 'not') {
        const parts = (n.conditions || []).map(write);
        if (!parts.length || parts.some((part) => part === null)) return null;
        const kinds = new Set(parts.map((part) => part.kind));
        if (kinds.size > 1) return null;
        const kind = [...kinds][0];
        if (n.op === 'not') {
          if (parts.length !== 1) return null;
          return { kind, sql: 'NOT (' + parts[0].sql + ')' };
        }
        return { kind, sql: '(' + parts.map((part) => part.sql).join(n.op === 'and' ? ' AND ' : ' OR ') + ')' };
      }
      const column = context.columns[n.col];
      if (!column) return null;
      const sql = conditionSql(column.expr, n, column.text);
      if (sql === null) return null;
      return { kind: column.grouped ? 'having' : 'where', sql };
    };
    /* A top-level AND is the case worth splitting: the WHERE half narrows
       before the grouping and the HAVING half after it, and the two together
       are exactly the filter the reader asked for. */
    const branches = node.op === 'and' ? (node.conditions || []) : [node];
    for (const branch of branches) {
      const written = write(branch);
      if (!written) { out.unpushed = true; continue; }
      if (written.kind === 'having') out.having.push(written.sql);
      else out.where.push(written.sql);
    }
    return out;
  }

  /**
   * Every SQL expression the grid's columns stand for, at one level.
   *
   * @param {object} level the level
   * @param {object} schema the month's column flavour
   * @returns {{columns: object, key: string}} the map, and the grouping key
   */
  function columnContext(level, schema) {
    const columns = {};
    const key = level.key(schema);
    columns.name = { expr: key, text: true, grouped: false };
    for (const extra of level.extras) {
      const expr = typeof extra.expr === 'function' ? extra.expr(schema) : extra.expr;
      /* An extra is an aggregate over the group, so a filter naming it is a
         HAVING rather than a WHERE. */
      columns[extra.id] = { expr, text: true, grouped: true };
    }
    for (const metric of METRICS) columns[metric.id] = { expr: metric.expr, text: false, grouped: true };
    return { columns, key };
  }

  /** The SELECT list for a level: the key, its extras, and the four measures. */
  function selectList(level, schema) {
    const parts = [level.key(schema) + ' AS name'];
    for (const extra of level.extras) {
      const expr = typeof extra.expr === 'function' ? extra.expr(schema) : extra.expr;
      parts.push(expr + ' AS ' + extra.id);
    }
    for (const metric of METRICS) parts.push(metric.expr + ' AS ' + metric.id);
    return parts.join(', ');
  }

  /** The quick filter as a predicate on the grouping key, or null. */
  function quickPredicate(key, quick) {
    if (!quick) return null;
    return 'LOWER(' + key + ') LIKE ' + likeLit(String(quick).toLowerCase(), '%@%');
  }

  /**
   * The statement one window of the main grid is answered by.
   *
   * @param {object} state `{month, level, schemaMap, filters, quick, sort, start, end}`
   * @returns {{sql: string, resource: string, unpushed: string[]}} the statement
   */
  function rowsSql(state) {
    const level = levelFor(state.level);
    const schema = schemaFor(state.month, state.schemaMap);
    const resource = resourceFor(state.month);
    const context = columnContext(level, schema);
    const split = splitFilter(state.filters, context);
    const unpushed = [];
    if (split.unpushed) unpushed.push('filter');

    const where = split.where.slice();
    const quick = quickPredicate(context.key, state.quick);
    if (quick) where.push(quick);

    const order = [];
    for (const entry of state.sort || []) {
      const column = context.columns[entry.col];
      if (!column) { unpushed.push('sort'); continue; }
      /* A measure is ordered by its output name, which the engine resolves to
         the aggregate; a dimension by the expression itself. */
      order.push((column.grouped ? entry.col : column.expr) + (entry.dir === 'desc' ? ' DESC' : ' ASC'));
    }
    if (!order.length) order.push('cost DESC');

    const start = Math.max(0, Number(state.start) || 0);
    const limit = Math.max(1, (Number(state.end) || (start + 100)) - start);

    const sql = [
      'SELECT ' + selectList(level, schema),
      'FROM `' + resource + '`',
      where.length ? 'WHERE ' + where.join(' AND ') : null,
      'GROUP BY name',
      split.having.length ? 'HAVING ' + split.having.join(' AND ') : null,
      'ORDER BY ' + order.join(', '),
      'LIMIT ' + limit + ' OFFSET ' + start,
    ].filter(Boolean).join(' ');

    return { sql, resource, unpushed };
  }

  /**
   * How many rows the same filter matches, which is what sizes the scrollbar.
   *
   * It counts the groups, not the prescriptions underneath them: the grid's
   * rows are groups, so a count of eighteen million would size the scrollbar
   * for something nobody is looking at. Measured at 4.4 to 4.9 s, three times
   * the cost of a page, so the source asks for it once per distinct filter and
   * remembers the answer for the session.
   *
   * @param {object} state the same state `rowsSql` takes
   * @returns {{sql: string, resource: string}} the statement
   */
  function countSql(state) {
    const level = levelFor(state.level);
    const schema = schemaFor(state.month, state.schemaMap);
    const resource = resourceFor(state.month);
    const context = columnContext(level, schema);
    const split = splitFilter(state.filters, context);
    const where = split.where.slice();
    const quick = quickPredicate(context.key, state.quick);
    if (quick) where.push(quick);
    const inner = [
      'SELECT ' + context.key + ' AS name, ' + METRICS.map((m) => m.expr + ' AS ' + m.id).join(', '),
      'FROM `' + resource + '`',
      where.length ? 'WHERE ' + where.join(' AND ') : null,
      'GROUP BY name',
      split.having.length ? 'HAVING ' + split.having.join(' AND ') : null,
    ].filter(Boolean).join(' ');
    return { sql: 'SELECT COUNT(*) AS n FROM (' + inner + ')', resource };
  }

  /**
   * The totals over every row the grid's filter matches, not over the page.
   *
   * It sums the grouped result rather than the raw one, because the grid's
   * rows are groups and a HAVING has already thrown some of them away: summing
   * the raw rows would add back the groups the reader filtered out. The count
   * it returns is the number of group rows, which is the same number that sizes
   * the scrollbar, so the totals and the scrollbar can never disagree.
   *
   * @param {object} state the same state `rowsSql` takes
   * @returns {{sql: string, resource: string}} the statement
   */
  function matchTotalsSql(state) {
    const level = levelFor(state.level);
    const schema = schemaFor(state.month, state.schemaMap);
    const resource = resourceFor(state.month);
    const context = columnContext(level, schema);
    const split = splitFilter(state.filters, context);
    const where = split.where.slice();
    const quick = quickPredicate(context.key, state.quick);
    if (quick) where.push(quick);
    const inner = [
      'SELECT ' + context.key + ' AS name, ' + METRICS.map((m) => m.expr + ' AS ' + m.id).join(', '),
      'FROM `' + resource + '`',
      where.length ? 'WHERE ' + where.join(' AND ') : null,
      'GROUP BY name',
      split.having.length ? 'HAVING ' + split.having.join(' AND ') : null,
    ].filter(Boolean).join(' ');
    return {
      resource,
      sql: 'SELECT COUNT(*) AS matched, SUM(items) AS items, SUM(cost) AS cost, '
        + 'SUM(quantity) AS quantity, SAFE_DIVIDE(SUM(cost), SUM(items)) AS costPerItem '
        + 'FROM (' + inner + ')',
    };
  }

  /**
   * The month's own totals, which is what the tiles and the totals line show.
   *
   * Every figure here is over the whole month, never over the rows that happen
   * to be on screen.
   *
   * @param {string} month the month, `YYYY-MM`
   * @returns {{sql: string, resource: string}} the statement
   */
  function totalsSql(month) {
    const resource = resourceFor(month);
    return {
      resource,
      sql: 'SELECT SUM(SAFE_CAST(ITEMS AS FLOAT64)) AS items, '
        + 'SUM(SAFE_CAST(ACTUAL_COST AS FLOAT64)) AS cost, '
        + 'SUM(SAFE_CAST(TOTAL_QUANTITY AS FLOAT64)) AS quantity, '
        + 'COUNT(DISTINCT PRACTICE_CODE) AS practices, '
        + 'COUNT(*) AS prescriptions '
        + 'FROM `' + resource + '`',
    };
  }

  /**
   * The chapters with the highest actual cost, for the first chart.
   *
   * @param {string} month the month
   * @param {number} limit how many chapters
   * @returns {{sql: string, resource: string}} the statement
   */
  function chapterSql(month, limit) {
    const resource = resourceFor(month);
    return {
      resource,
      sql: 'SELECT BNF_CHAPTER_PLUS_CODE AS name, '
        + 'SUM(SAFE_CAST(ITEMS AS FLOAT64)) AS items, '
        + 'SUM(SAFE_CAST(ACTUAL_COST AS FLOAT64)) AS cost '
        + 'FROM `' + resource + '` GROUP BY name ORDER BY cost DESC '
        + 'LIMIT ' + Math.max(1, Number(limit) || 15),
    };
  }

  /**
   * Actual cost by integrated care board, for the second chart.
   *
   * @param {string} month the month
   * @param {object} [schemaMap] month to flavour name
   * @returns {{sql: string, resource: string}} the statement
   */
  function icbSql(month, schemaMap) {
    const resource = resourceFor(month);
    const schema = schemaFor(month, schemaMap);
    return {
      resource,
      sql: 'SELECT ' + schema.icb + ' AS name, '
        + 'SUM(SAFE_CAST(ITEMS AS FLOAT64)) AS items, '
        + 'SUM(SAFE_CAST(ACTUAL_COST AS FLOAT64)) AS cost '
        + 'FROM `' + resource + '` WHERE ' + schema.icb + ' IS NOT NULL AND ' + schema.icb + " != '' "
        + 'GROUP BY name ORDER BY cost DESC LIMIT 60',
    };
  }

  /**
   * One substance across many months, as a single statement.
   *
   * The endpoint checks that a table identifier matches `resource_id`, but it
   * insists on only one of them: a UNION ALL whose first branch names the
   * month in `resource_id` may name any other month in its later branches.
   * That is what makes a two year trend one request of around five seconds
   * rather than twenty four requests. It is measured rather than documented,
   * so the caller is expected to cope with it being refused.
   *
   * Each branch is written for its own month's column flavour, and every
   * branch casts `YEAR_MONTH` to the same `YYYY-MM` text, because the older
   * tables hold it as the number 202412 and a UNION whose first column is text
   * in one branch and a number in another is refused outright.
   *
   * @param {string} substance the chemical substance name
   * @param {string[]} months the months, oldest or newest first
   * @param {object} [schemaMap] month to flavour name
   * @returns {{sql: string, resource: string}|null} the statement
   */
  function trendSql(substance, months, schemaMap) {
    const list = (months || []).filter(Boolean);
    if (!list.length || !substance) return null;
    const branch = (ym) => {
      const schema = schemaFor(ym, schemaMap);
      const period = schema.ymText
        ? 'CAST(YEAR_MONTH AS STRING)'
        : "CONCAT(SUBSTR(CAST(YEAR_MONTH AS STRING), 1, 4), '-', SUBSTR(CAST(YEAR_MONTH AS STRING), 5, 2))";
      return 'SELECT ' + period + ' AS month, '
        + 'SUM(SAFE_CAST(ITEMS AS FLOAT64)) AS items, '
        + 'SUM(SAFE_CAST(ACTUAL_COST AS FLOAT64)) AS cost '
        + 'FROM `' + resourceFor(ym) + '` '
        + 'WHERE UPPER(' + schema.substance + ') = ' + lit(String(substance).toUpperCase()) + ' '
        + 'GROUP BY month';
    };
    return {
      resource: resourceFor(list[0]),
      sql: list.map(branch).join(' UNION ALL ') + ' ORDER BY month',
    };
  }

  /* ------------------------------------------------------------------ */
  /* Display                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Formatting for the page's own text.
   *
   * The grid's cells are formatted by the declared FormatSpec objects on the
   * columns above, never by a function; these are for the tiles, the status
   * line and the chart labels, which are the page's own writing.
   */
  const fmt = {
    int: (n) => (n == null || !Number.isFinite(Number(n))
      ? 'no data'
      : Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 })),
    money: (n) => (n == null || !Number.isFinite(Number(n))
      ? 'no data'
      : Number(n).toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 })),
    money2: (n) => (n == null || !Number.isFinite(Number(n))
      ? 'no data'
      : Number(n).toLocaleString('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 })),
    seconds: (ms) => (ms == null || !Number.isFinite(Number(ms)) ? 'not timed' : (Number(ms) / 1000).toFixed(1) + ' s'),
    percent: (n) => (n == null || !Number.isFinite(Number(n))
      ? 'no data'
      : (Number(n) >= 0 ? '+' : '') + Number(n).toFixed(1) + '%'),
  };

  root.EpdData = {
    API, DATASET, SQL_URL, ROW_CEILING, SCHEMAS,
    LEVELS, METRICS, METRIC_IDS, OPERATORS,
    resourceFor, monthLabel, yearBefore, schemaFor, levelFor, metricFor,
    columnContext, splitFilter, conditionSql, quickPredicate, lit, likeLit,
    rowsSql, countSql, matchTotalsSql, totalsSql, chapterSql, icbSql, trendSql,
    fmt,
  };
})(window);
