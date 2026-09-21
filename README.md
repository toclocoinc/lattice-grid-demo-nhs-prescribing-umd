# What England prescribes, live

Every prescription item dispensed in England, around eighteen million rows a month,
queried where it lives. The grid turns its own state into SQL and sends it to the NHS
Business Services Authority open data endpoint: scrolling is `LIMIT` and `OFFSET`, the
sort arrows are `ORDER BY`, the search box is a `WHERE`, a threshold on a measure is a
`HAVING`, and the totals row is its own query. Nothing is downloaded first.

Built with [Lattice Grid](https://latticegrid.dev) loaded from a CDN by plain
`<script>` tags. No npm install, no bundler, no build step, no TypeScript. Open
`index.html` and it runs.

## What makes this one different

The other demos in this family hold their data: a snapshot in the repository, or a
Parquet file the browser reads. This one holds almost none. The saved copy in
`data/snapshot` is 68 KB, and it exists so there is something true on screen in the
first second and something true on screen when the endpoint is down. Everything else
is a query.

That is what a **pushdown source** is for. The grid hands an adapter a structured
request, the adapter writes whatever the engine speaks, and the grid declares what the
adapter can and cannot answer so that the parts it cannot are finished in the browser
rather than quietly skipped. Here the engine is a public SQL endpoint over an eighteen
million row table, and the adapter is 200 lines in `src/epd-source.js`.

```js
const source = LatticeGrid.createPushdownSource({
  adapter: {
    capabilities: { filter: 'tree', operators: [...], sort: 'multi', quick: true, range: true, total: true },
    async execute(query) { /* query -> SQL -> fetch -> { rows, total } */ },
  },
  pageSize: 100,
});
grid.set('source', source);
```

Under the grid is a **Query** panel listing every statement the page has sent this
session, newest first, character for character as it went out. That panel is the demo.

## The data

[English Prescribing Dataset (EPD) with SNOMED code](https://opendata.nhsbsa.net/dataset/english-prescribing-dataset-epd-with-snomed-code),
published monthly by NHS Business Services Authority on a CKAN portal. One row per
practice per presentation per month: who prescribed what, how many items, how much it
cost, where they are.

Sixty nine monthly tables are published, back to November 2020. The page offers the
most recent twenty four.

## The endpoint, as measured

Measured against the live service on 21 September 2026 from a UK connection. Every
number the page relies on is one of these, and the page falls back rather than assumes
when one of them stops being true.

| What | Measured |
| --- | --- |
| Base | `https://opendata.nhsbsa.net/api/3/action/datastore_search_sql` |
| Key | none |
| CORS | `access-control-allow-origin: *` on `datastore_search_sql` and on `package_show` |
| Table name in the SQL | the resource **name** in backticks, e.g. `` `EPD_SNOMED_202607` ``; the same name again as `resource_id`. A resource UUID in `resource_id` is answered 404 |
| Result shape | `{"success":true,"result":{"result":{"records":[...]}}}`, note the nested `result` |
| Rows in July 2026 | 18,601,776 |
| Inline row ceiling | **32,000.** `LIMIT 32000` returns 32,000 rows; `LIMIT 32001` returns HTTP **200** with `records_truncated: "true"` and a `gc_urls` link to a gzipped CSV, and no records at all |
| One grouped page (100 rows of 1,623 groups) | 1.2 to 1.8 s |
| `LIMIT 500 OFFSET n` over a filtered practice | 1.21 s at offset 0, 1.37 s at 500, 1.45 s at 2,000, 1.67 s at 10,000 |
| `SELECT * LIMIT n`, unfiltered | 1.2 s at 500, 2.4 s at 5,000, 3.6 s at 20,000, 4.6 s at 32,000 |
| `COUNT(*)` over the month | 1.7 s |
| `COUNT(*)` over a grouped subquery (what sizes the scrollbar) | 4.4 to 4.9 s |
| Group by chemical substance, whole month | 1.6 s, 1,623 groups |
| Group by BNF chapter | 1.3 s, 19 groups |
| Group by integrated care board | 1.5 to 1.8 s, 37 groups |
| Group by practice | 1.8 to 3.2 s, 8,760 groups |
| Twenty four months in one statement (`UNION ALL`) | 5.2 to 6.0 s cold, 1.6 s when the service has it cached |

Two behaviours worth knowing about, both found by measurement rather than in the
documentation:

**A `UNION ALL` may name months other than `resource_id`.** The endpoint validates that
a table identifier matches the `resource_id` parameter, but it is satisfied when one of
them does. A statement whose first branch names `EPD_SNOMED_202607` may name twenty
three other months in its later branches. That is what makes the two year trend chart
one request rather than twenty four. The page copes with it being refused.

**The monthly tables do not all have the same columns.** From March 2025 the publisher
renamed several. The chemical substance's *name* moved from
`CHEMICAL_SUBSTANCE_BNF_DESCR` to `BNF_CHEMICAL_SUBSTANCE`, which until then held the
*code*; `BNF_DESCRIPTION` became `BNF_PRESENTATION_NAME`; `ADQUSAGE` became
`ADQ_USAGE`; and `YEAR_MONTH` changed from the number `202502` to the text `2025-03`.
Older tables again use `STP_NAME` where newer ones use `ICB_NAME`. A `UNION ALL` whose
first column is text in one branch and a number in another is refused outright, and
`SUM` over a text column is refused too, so every branch is written for its own month's
flavour and every aggregate casts before it sums. `tools/build-snapshot.mjs` reads the
real column list of each saved month and records the flavour, so the page never
guesses for a month it knows about.

## What the grid sends

Three grid states and the statement each one produced, copied from the Query panel:

**Opening state.** One row per chemical substance, most expensive first, first page.

```sql
SELECT BNF_CHEMICAL_SUBSTANCE AS name,
       SUM(SAFE_CAST(ITEMS AS FLOAT64)) AS items,
       SUM(SAFE_CAST(ACTUAL_COST AS FLOAT64)) AS cost,
       SUM(SAFE_CAST(TOTAL_QUANTITY AS FLOAT64)) AS quantity,
       SAFE_DIVIDE(SUM(SAFE_CAST(ACTUAL_COST AS FLOAT64)), SUM(SAFE_CAST(ITEMS AS FLOAT64))) AS costPerItem
FROM `EPD_SNOMED_202607`
GROUP BY name
ORDER BY cost DESC
LIMIT 100 OFFSET 0
```

**Searching for "statin", then asking for at least a million pounds.** The text lands
in the `WHERE`, because a name exists before the grouping. The threshold lands in the
`HAVING`, because a total does not.

```sql
SELECT BNF_CHEMICAL_SUBSTANCE AS name, ...
FROM `EPD_SNOMED_202607`
WHERE LOWER(BNF_CHEMICAL_SUBSTANCE) LIKE '%statin%'
GROUP BY name
HAVING SUM(SAFE_CAST(ACTUAL_COST AS FLOAT64)) >= 1000000
ORDER BY cost DESC
LIMIT 100 OFFSET 0
```

**One row is a practice, scrolled past the fourth page.** Changing what a row is
changes the `GROUP BY` key, and brings the practice's code and care board with it as
aggregates over the group.

```sql
SELECT PRACTICE_NAME AS name,
       ANY_VALUE(PRACTICE_CODE) AS code,
       ANY_VALUE(ICB_NAME) AS icb,
       SUM(SAFE_CAST(ITEMS AS FLOAT64)) AS items, ...
FROM `EPD_SNOMED_202607`
GROUP BY name
ORDER BY cost DESC
LIMIT 100 OFFSET 300
```

## Being a polite guest

The endpoint documents no rate limit. The page behaves as if it did.

- **One statement in flight at a time.** Dragging a scrollbar asks for a dozen windows
  in a second; they queue.
- **An identical statement is answered from the session's memory.** Scrolling back to
  the top, or switching away from a level and back, costs nothing and says so in the
  panel.
- **The search box waits 300 ms after the last keystroke.** Not a query per letter.
- **The scrollbar's count is asked for once per filter,** not once per window. It is
  the most expensive statement the page sends.
- **A truncated answer is treated as a failure.** Past 32,000 rows the endpoint answers
  HTTP 200 with a link to a file instead of records; reading that as an empty result
  would draw an empty grid over a query that worked.

## Honest about what is on screen

- The banner says whether the figures came from the endpoint or from the saved copy,
  and how long the last statement took.
- The totals row under the grid is **its own query** over everything the filter
  matches. It is never the sum of the rows that happen to be loaded, which would be a
  number that changed when you scrolled.
- The tiles are the month's own totals, and their movement line is a second query
  against the same month a year earlier.
- If the endpoint does not answer, the page says so, keeps the last good result, and
  switches its controls off, because every one of them is a query. Nothing is
  substituted and nothing is invented.
- `index.html?live=0` opens the page on the saved copy and leaves it there.

## Running it

```sh
node tools/serve.mjs
```

Serving from a file path works too, but `data/snapshot` is read with `fetch`, so a
browser's file origin rules will block it. Use the server.

## Checking it

```sh
node tools/verify.mjs                 # against the live endpoint
OFFLINE=1 node tools/verify.mjs       # with the endpoint unreachable
node tools/verify.mjs --shots ./shots # and keep screenshots
```

Needs Node 22 or newer (for its built-in `WebSocket`) and a Chrome or Chromium on the
machine. It loads the page in a real browser and asserts, among other things, that
searching, sorting, changing what a row is and changing the month each change the
statement **and** change the rows, which is what "pushed down" means and what a page
that quietly filtered in the browser would fail. The figures on the tiles and in the
totals row are compared with queries the check runs itself, in Node, so a page figure
is never checked against the page.

The statements are compared against what the page's **own** SQL builder writes, loaded
into Node from `src/epd-data.js` rather than copied, so the check is that the browser
sent what the builder wrote.

`OFFLINE=1` asserts the two honest outcomes with the endpoint unreachable: with the
live view switched off the page makes no request at all and shows the saved copy, and
with it on the page tries, fails, says so, and keeps the saved copy. That mode needs no
NHSBSA at all, so a continuous integration run is never red because somebody else's
service is down.

## Rebuilding the saved copy

```sh
node tools/build-snapshot.mjs
```

Reads the dataset listing, the column flavour of each of the last twenty four months,
and seven queries, and writes `data/snapshot`. No key, about 20 s, around 68 KB.

## How it is put together

| File | What it is |
| --- | --- |
| `index.html` | The six pinned CDN tags, and the demo's four scripts |
| `src/epd-data.js` | What the data is, and every line of SQL the page can write. It never fetches |
| `src/epd-source.js` | The endpoint client and the pushdown adapter. It never writes SQL |
| `src/dashboard.js` | The page: controls, grid, tiles, charts, query panel |
| `main.js` | Reads the saved copy, hands it to the dashboard, draws |
| `tools/build-snapshot.mjs` | Rebuilds `data/snapshot` from the live endpoint |
| `tools/epd-module.mjs` | Loads `src/epd-data.js` in Node, so the tools and the page share one SQL builder |
| `tools/verify.mjs` | The browser check |
| `tools/serve.mjs` | A static file server for looking at it locally |

The split between the first two is deliberate: the statements can be read, logged and
shown on the page separately from the requests that carry them, and both tools get the
page's own builder rather than a second copy of it.

## Attribution

Source: NHS Business Services Authority, English Prescribing Dataset (EPD). Contains
public sector information licensed under the
[Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

The demo's own code is MIT licensed; see `LICENSE`.
