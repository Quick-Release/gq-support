# Idle-performance budgets and regression benchmarks

Research for [issue #18](https://github.com/Quick-Release/gq-support/issues/18), part of map #1 (decision 4: performance is measured, not described as zero). It builds on the public-request measurement in [bootstrap-lifecycle-verification.md](bootstrap-lifecycle-verification.md) and the loading model in [ADR 0011](../adr/0011-wordpress-native-react-runtime.md). The raw results and the throwaway harness are in [`idle-performance-budgets/`](idle-performance-budgets/).

## Decision

The regression gate is built mainly on **deterministic counters, not timings**. Counters include plugin-owned asset bytes, requests, SQL queries, HTTP API calls, autoloaded bytes, timers and PHP memory. Each is fixed for a given commit and fixture, so CI can fail hard on it with no noise model. Timings (PHP wall time, time to usable input) are collected in the same run with interleaved plugin-on/plugin-off samples. They are **report-only** until ten `main` runs give their variance. After that they gate on a confidence-interval rule, never on a single Lighthouse score or a single run.

The numbers are **budgets**: ceilings set from the measured baseline plus a stated headroom. They are not claims that the plugin is free.

## Measured baseline (commit `b3beb76`, 2026-09-28)

**Environment**
- WordPress Playground CLI 3.1.56 running WordPress 7.1.2 on PHP 8.5.10 (WebAssembly), with SQLite and no persistent object cache.
- Chromium 153 through Playwright 1.63, on an Apple M5 running macOS.
- Fixture: [`blueprint.json`](idle-performance-budgets/blueprint.json) activates a GETQUICK Design stub and the plugin, then stores a `connected` record.
- The app was built from this commit with `pnpm build:app` (`@wordpress/scripts` 36).

**Samples**
- Browser: 20 fresh page loads per screen, for `index.php` and `edit.php`.
- PHP: 30 interleaved on/off pairs per URL.

**Earlier DDEV numbers** (MariaDB, PHP 8.2, 100 sequential requests each) are in [bootstrap-lifecycle-verification.md](bootstrap-lifecycle-verification.md).

**Timing caveat.** PHP-WASM and SQLite make Playground wall times about 15× slower than DDEV (roughly 290 ms against 17 ms for the homepage). Treat every Playground timing below as relative. **The counters and byte sizes are exact.**

### Bytes (measured)

| Asset | Raw | gzip -9 | brotli | Loaded when |
|---|---:|---:|---:|---|
| `assets/launcher.js` | 2,691 | 1,089 | 852 | Eligible screen, closed |
| `assets/launcher.css` | 1,321 | 675 | 527 | Eligible screen, closed |
| Inline HTML: root + `<template>` + bootstrap `<script>` | 946 | — | — | Eligible screen, closed |
| `assets/dist/index.js` | 3,818 | 1,326 | 1,111 | First open |
| `assets/dist/index.css` (or `-rtl`) | 1,812 | 703 | 523 | First open |

The app's dependency manifest lists `wp-a11y`, `wp-element` and `wp-i18n`. On both the dashboard and the posts list, WordPress 7.1 had already printed `wp-element` and React (probably for the admin command palette, added in 6.3; not verified on 6.5.0 here). So the template contained no core scripts, and the first open fetched **only the plugin's two files (5,630 B)**. The existing browser test already asserts that the template never carries a second React.

### Browser, Reporter on an eligible screen (measured, n = 20)

| Metric | `index.php` median / p95 | `edit.php` median / p95 |
|---|---:|---:|
| Plugin-owned requests while closed | 2 / 2 (4,012 B) | 2 / 2 (4,012 B) |
| All page requests | 91 / 91 | 67 / 67 |
| First open: requests / bytes | 2 / 5,630 | 2 / 5,630 |
| First open: CDP `ScriptDuration` | 3.4 / 4.1 ms | 3.4 / 4.6 ms |
| First open: CDP `TaskDuration` | 44.6 / 52.8 ms | 45.9 / 50.2 ms |
| First open: long tasks (> 50 ms) | 0 / 0 | 0 / 0 |
| Click to focused Description field | 123 / 127 ms | 130 / 139 ms |
| Plugin requests in 60 s idle, closed | 0 | 0 |
| Plugin requests in 60 s idle after open → close, with synthetic `focus`, `online` and `visibilitychange` | 0 | 0 |
| Requests during 50 open/close cycles | 0 | 0 |
| JS heap growth after 50 cycles, after forced GC | +0.62 MB | +0.55 MB |

**Heartbeat.** The only background traffic was core Heartbeat (`admin-ajax.php`): one request per 60 s on the dashboard, and six on `edit.php`. Core's default `mainInterval` is 60 s, and it slows to 120 s when the window loses focus ([heartbeat.js](https://github.com/WordPress/wordpress-develop/blob/trunk/src/js/_enqueues/wp/heartbeat.js)). A benchmark must attribute requests by URL or initiator and must not count total page traffic.

**Click-to-input time.** This is dominated by Playground serving two static files through PHP-WASM. It is not the plugin's own cost.

**Heap growth.** The half-megabyte after 50 cycles is one sample per screen. It is a signal worth re-measuring, not proof of a leak.

### PHP, interleaved on/off on the same process (measured, n = 30 pairs)

[`gq-probe.php`](idle-performance-budgets/gq-probe.php) is an mu-plugin. It removes `gq-support` from `active_plugins` for each request when `gq_off` is present, which gives A/B pairs from one server with no reactivation between them. It counts queries through the `query` filter, attributes any SQL naming `gq_support`, counts `http_api_debug`, and reads `memory_get_peak_usage()` (not `true`, which rounds to 2 MB chunks and hid every difference in the DDEV run).

| Request | Plugin SQL / request | Total SQL off → on | Peak memory delta | HTTP API | Wall median off → on (WASM) |
|---|---:|---:|---:|---:|---:|
| Anonymous `/` | **0** | 32 → 32 | +8.6 KB | 0 | 290.0 → 289.5 ms |
| `admin-ajax.php` | **0** | 9 → 9 | +8.6 KB | 0 | 276.5 → 276.5 ms |
| `plugins.php` (ineligible screen) | **2** | 29 → 31 | +9.0 KB | 0 | 871 → 866 ms |
| `index.php` (eligible, launcher enqueued) | **4** | 42 → 46 | +13.9 KB | 0 | 324 → 328 ms |

The two queries on every site-admin screen come from `GQ_Support_Lifecycle::ensure_site()` on `admin_init`. It reads `gq_support_schema_version` and `gq_support_installation_origin`, and both are stored `autoload=false`. Eligible screens add `gq_support_connection` and `gq_support_installation_id` in `eligible()`. With a persistent object cache these become cache hits. Without one they are uncached single-row primary-key reads (see [`get_option()`](https://developer.wordpress.org/reference/functions/get_option/) and [autoload guidance](https://make.wordpress.org/core/2024/06/18/options-api-disabling-autoload-for-large-options/)). The cost is small, but it is not zero, and it is exactly the kind of count a budget can ratchet down.

**Estimated, not measured:** WooCommerce admin screens, a real MySQL host with an object cache, WordPress 6.5.0, and the future REST list/create paths (#34). Those routes do not exist yet.

## Budgets

"Hard" means deterministic: CI fails when the budget is exceeded. "Ratchet" means the budget is lowered, never raised, when a change makes it cheaper. Raising a budget needs a PR that says why.

| # | Scenario | Budget | Baseline | Type |
|---|---|---|---|---|
| B1 | Anonymous public page | 0 GQ tags or bytes in HTML; 0 plugin SQL; 0 HTTP API; 0 plugin cron events; HTML byte-identical on/off | 0 / 0 / 0 / 0 / identical | Hard |
| B2 | Anonymous public page, PHP peak memory delta | ≤ 32 KB | +8.6 KB | Hard |
| B3 | Logged-in user without `gq_support_submit_requests`, any admin screen, AJAX, or non-plugin REST | 0 GQ assets; plugin SQL ≤ 2 (target ≤ 1 once the state is one record, see Q1); 0 HTTP API | 0 / 2 / 0 | Hard + ratchet |
| B4 | Eligible screen, closed: plugin-owned requests | Exactly 2 (`launcher.js` and `launcher.css`); no plugin REST, AJAX or `fetch` | 2 | Hard |
| B5 | Eligible screen, closed: launcher bytes | JS ≤ 1.5 KB gz; CSS ≤ 1.0 KB gz; inline HTML ≤ 2 KB | 1,089 B / 675 B / 946 B | Hard |
| B6 | Eligible screen, closed: PHP | Plugin SQL ≤ 4 (ratchet to ≤ 2); HTTP API 0; memory delta ≤ 64 KB | 4 / 0 / +13.9 KB | Hard + ratchet |
| B7 | First open: plugin-owned code | App JS ≤ 10 KB gz; app CSS ≤ 4 KB gz; plugin asset requests ≤ 2; no second copy of a core script (React, element, i18n, api-fetch) | 1,326 B / 703 B / 2 / none | Hard |
| B8 | First open: data | At most 1 REST list call, and only when My requests is shown (`per_page` ≤ 20 by default, ≤ 50 maximum per the [contract](../support-api-contract.md)); New report makes 0 calls | 0 (no routes yet) | Hard once #34 lands |
| B9 | First open: main thread | 0 long tasks (> 50 ms, [W3C Long Tasks](https://w3c.github.io/longtasks/)) attributable to the open, on the CI desktop profile | 0 | Hard |
| B10 | Reopen after mount | 0 asset requests; 0 REST unless the Reporter presses refresh or switches to My requests | 0 | Hard |
| B11 | Closed, before and after use | 0 plugin-owned requests in a 60 s idle window after `focus`, `online` and `visibilitychange` events; no plugin interval timers; no WP-Cron events | 0 | Hard |
| B12 | Options | 0 autoloaded bytes owned by the plugin (every `gq_support_*` option has `autoload` `off`/`no`), unless an allowlisted record ≤ 1 KB is chosen under Q1 | 0 | Hard |
| B13 | Submit, list or read (after #34) | WordPress route time is reported separately from the Worker round-trip. Adapter timeouts are 8 s for create and 5 s for read, per the contract. An unavailable provider never affects non-plugin requests (B1–B6 still hold with the Worker down) | n/a | Hard for isolation; timings are report-only |
| T1 | Anonymous page, PHP wall time | Report the median paired delta with a 95% bootstrap CI. After ten `main` runs, **fail** if the CI's lower bound exceeds max(1 ms, 3 × the observed `main` MAD); warn above 0.5 ms | DDEV: +0.08 ms and +0.57 ms across two runs | Statistical |
| T2 | Eligible screen, PHP wall time | Same rule as T1 | not yet on a real stack | Statistical |
| T3 | First open, click to focused field | Report the median and p95. Fail on a regression over 25% with a CI excluding 0, against the base in the same job | 123 ms (Playground) | Statistical |
| T4 | 50 open/close cycles, heap after GC | Warn above 1 MB; investigate, do not fail | +0.55 to +0.62 MB | Report |

**Why these numbers:**
- **Byte budgets (B5, B7).** The launcher budgets leave about 40% headroom over the measured size. size-limit's own advice is to set limits at about the current value plus 25% ([size-limit](https://github.com/ai/size-limit)). The launcher is deliberately tiny and vanilla (ADR 0011), so its headroom is kept tight. The app budget is generous on purpose: #34 and #13 add the list, delivery states and `@wordpress/api-fetch`, and a hard ceiling is enough to catch an accidental bundled React or TanStack Query. That alone would be roughly 45 KB gz.
- **For scale.** Plugin Check flags *front-end* scripts totalling more than 300,000 bytes ([`Enqueued_Scripts_Size_Check`](https://github.com/WordPress/plugin-check/tree/trunk/includes/Checker/Checks/Performance)). It does not test wp-admin, so it cannot stand in for B4–B7.
- **Memory (B2, B6).** Ceilings of 2 to 4 times the measured delta absorb PHP-version differences in class loading while still catching any new eager `require` or data load.
- **Timing thresholds (T1, T2).** These start from the DDEV run-to-run spread. Two runs of the same code differed by about 0.5 ms in median delta, so 1 ms is roughly twice the observed noise. This is a starting rule, not a proven budget. It becomes binding only after `main` history exists.

## Gate design

Three layers keep noise out of the pass/fail signal.

1. **Static checks, every PR, in seconds.**
   - Build the app. Then run [preactjs/compressed-size-action](https://github.com/preactjs/compressed-size-action), or a tiny script, over `plugin/assets/{launcher.js,launcher.css}` and `plugin/assets/dist/*.{js,css}` with gzip. Fail on B5 or B7 and comment the diff against the base.
   - Assert that `index.asset.php` contains no `react` or `react-dom` inlined bundle. Its dependencies must be `wp-*` handles only.
   - Grep the built JS for `setInterval` and `refetchInterval`.
2. **Counter benchmark, every PR, in the existing DDEV job.**
   - Use the probe pattern from [`gq-probe.php`](idle-performance-budgets/gq-probe.php): a per-request `gq_off` toggle through the `option_active_plugins` filter, plugin SQL attributed through the `query` filter, `http_api_debug`, `memory_get_peak_usage()`, and `wp cron event list`.
   - Add `wp option list --search='gq_support_*' --fields=option_name,autoload,size_bytes` for B12.
   - Add a Playwright spec modelled on [`measure.cjs`](idle-performance-budgets/measure.cjs):
     - count requests by URL or initiator;
     - read CDP `Performance.getMetrics` through `newCDPSession`, because Playwright has no `page.metrics()`;
     - install a `longtask` `PerformanceObserver` with an init script;
     - wrap `setInterval` in an init script to record plugin-initiated timers, checking the stack for `gq-support`.
   - Run it for the scenarios in B1–B12, on WordPress 6.5.0 and latest (matching the current matrix), with and without WooCommerce. Counters need about 3 samples, not 100.
3. **Timing benchmark, on `main` and on PRs labelled `perf`, report-only at first.**
   - Interleave within one job: rounds on the outside, plugin on/off (and base/head for PRs) on the inside. This is the Gutenberg pattern: "each shard measuring all branches on the same runner", using "medians from all rounds" ([Gutenberg performance docs](https://github.com/WordPress/gutenberg/blob/trunk/docs/explanations/architecture/performance.md)).
   - Take 50 or more PHP pairs and 20 browser rounds. Set `SAVEQUERIES`, `WP_DEBUG` and `SCRIPT_DEBUG` off, and `DISABLE_WP_CRON` and `WP_HTTP_BLOCK_EXTERNAL` on, as core's performance workflow does ([reusable-performance-test-v2.yml](https://github.com/WordPress/wordpress-develop/blob/trunk/.github/workflows/reusable-performance-test-v2.yml)).
   - Report the median, p95, standard deviation and MAD like core's `compare-results.js`. Publish the JSON as a workflow artifact.
   - Promote T1–T3 to failing only after ten `main` runs give the MAD. The rule is tachometer-style: fail only when the 95% CI of the difference excludes the threshold ([tachometer](https://github.com/google/tachometer)).
   - Use the existing `blacksmith-2vcpu` or standard runners. Do not rely on absolute times across runs: GitHub documents no performance guarantee for hosted runners, and core's own workflow notes that "some variance in the results is expected".

**Measuring PHP on screen.** Use a test-only Server-Timing mu-plugin like core's `tests/performance/wp-content/mu-plugins/server-timing.php` (`wp-total`, `wp-db-queries`, `wp-memory-usage`), plus plugin-specific metrics such as `gq-sql`. Read it with `Metrics.getServerTiming()` from `@wordpress/e2e-test-utils-playwright` ([source](https://github.com/WordPress/gutenberg/blob/trunk/packages/e2e-test-utils-playwright/src/metrics/index.ts)). Do not ship Server-Timing in the plugin: it is not in core, and Performance Lab's API is a plugin dependency ([Trac #49509](https://core.trac.wordpress.org/ticket/49509)).

**Keeping provider latency out of the site gate.** CI points `GQ_SUPPORT_SERVICE_URL` at a local fake Worker with fixed latency, or stubs it with `pre_http_request`, so B13 measures only WordPress work. Worker acknowledgement, queue delay and GitHub delivery latency are production telemetry owned by #20. They never feed the site gate. A separate outage test sets the fake to hang or refuse and checks that B1–B6 are unchanged and that plugin routes return within the adapter timeout plus 1 s.

## Alternatives considered

- **Lighthouse or LHCI scores as the gate.** Rejected. A score blends everything on the page, and the plugin's share of a wp-admin page is a few kilobytes. Lighthouse's own guidance is that the median of 5 runs is only about twice as stable as one run, and it recommends dedicated hardware ([variability.md](https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md)). Lighthouse 12 also removed `budgets.json`. LHCI `resource-summary` assertions would work, but they duplicate the byte check at a higher cost.
- **Absolute wall-time budgets such as "under 1 ms".** Rejected as a hard gate. Two DDEV runs of the same code gave +0.08 ms and +0.57 ms, so the noise is the same size as the signal. Deterministic counters catch the regressions that matter: an extra query, eager loading, an HTTP call on render.
- **Instruction-count benchmarking (CodSpeed, cachegrind).** Stable, but it models CPU only, excludes syscalls, and so excludes the database and I/O costs that dominate here ([CodSpeed](https://codspeed.io/docs/instruments/cpu)). The benefit does not justify a new service.
- **Autoloading the plugin's state to save 2–4 admin queries.** This is a trade-off, not a default. Autoloading moves the bytes onto every request, public ones included, which B1 and B12 forbid unless the record is tiny and allowlisted. It is left open as Q1.
- **`wp profile` and `wp doctor`.** Both are useful for manual investigation: `wp doctor`'s autoload check fails above 900 KB site-wide. But `wp profile` profiles front-end bootstrap stages, and neither isolates one plugin's admin cost. Not used as the gate.

## Noise and failure cases

- **Other plugins and Heartbeat.** Attribute by URL, initiator or SQL text. Never gate on total page requests, total SQL or TBT.
- **Object cache on or off.** Option reads cost queries only without a persistent cache. Run counters with no object cache, the worst case, and record the cache mode in the report.
- **Full-page or CDN cache.** A cached public hit runs no PHP. B1–B2 must run uncached (`?gq_probe=1` busts caches, and the harness disables page caching) so they measure the plugin rather than the cache.
- **Core already printing React.** On a future screen or WordPress version without the command palette, first open would add core `react`, `react-dom` and `wp-element`. These are core bytes, not plugin bytes. B7 counts plugin-owned bytes and separately asserts no duplicates, and T3 reports the case.
- **Sequential ordering drift.** The DDEV harness ran all inactive samples, then all active. Thermal and cache drift then shows up as plugin cost. Interleave every sample, as the Playground probe does.
- **`memory_get_peak_usage(true)`.** This measures in 2 MB allocator chunks, so it showed no difference in DDEV. Use the default `false`.
- **Idle window.** A 60 s window catches 60 s intervals but not a 5-minute timer. The timer-registration hook (B11) covers longer ones without waiting.
- **Heap sampling.** Heap growth after GC is noisy and depends on the React version. It is report-only (T4).

## Acceptance criteria for implementation

1. A CI step fails when a built launcher or app file exceeds B5 or B7 (gzip), and comments the size diff against the base branch on each PR.
2. A DDEV-backed spec, run on WordPress 6.5.0 and latest, asserts B1–B4, B6 and B9–B12 with deterministic counters. Each assertion has a negative control that proves the probe detects a violation (for example, a test mu-plugin that adds a query, an HTTP call, a `setInterval` or an autoloaded option makes the gate fail).
3. Once #34 lands, the spec asserts B8, B10 and B13, using a fake Worker. With the Worker unreachable, B1–B6 still pass and plugin routes return within adapter timeout + 1 s.
4. The benchmark job interleaves plugin-on/plugin-off (and base/head on PRs) samples in one job. It uploads JSON with the WordPress, PHP, database, browser and runner versions, the commit, the object-cache mode and the sample counts. It reports median, p95, standard deviation, MAD and the paired-delta CI.
5. T1–T3 become failing gates after ten `main` runs, and the resulting thresholds are written back into this document.
6. `ensure_site()` and `eligible()` together issue at most one uncached option query on an ineligible admin screen and at most two on an eligible one, or the Q1 decision records why not. B3 and B6 are then ratcheted.
7. Release packaging (#19 and #20) runs the counter gate against the packaged zip, not the source tree.

## Open questions for the map

- **Q1 (for #3 and #7).** Should the four small `gq_support_*` records be consolidated into one state record? The choice is between non-autoloaded (1 admin query) and autoloaded with a size cap under 1 KB (0 queries everywhere, but bytes on public requests). The measurements show the current layout costs 2 queries on every site-admin screen and 4 on eligible ones.
- **Q2 (for #13).** When the panel reopens on My requests, does it refetch automatically or show the last list until refresh is pressed? The domain design says the list "loads when My requests is shown", which is ambiguous for reopen. B10 assumes no automatic refetch on reopen.
- **Q3 (for #19).** Should the counter benchmark run in the existing DDEV job or in a Playground job? Playground is faster to boot and gives exact counters, but it is not a production-like database or PHP runtime.
- **Q4.** The T4 heap growth of about 0.6 MB over 50 cycles should be re-measured on the real app once #34 and #13 add state, to confirm there is no retained-tree leak.

## Reproducing

Build the app first with `pnpm build:app`. Then start a disposable Playground site. Replace `<dir>` in the command below with the directory that holds a copy of `gq-probe.php` in `mu/` and a `getquick-design/getquick-design.php` stub defining `GETQUICK_DESIGN_VERSION`:

```sh
npx @wp-playground/cli@3.1.56 server --port=9471 \
  --mount=./plugin:/wordpress/wp-content/plugins/gq-support \
  --mount=<dir>/getquick-design:/wordpress/wp-content/plugins/getquick-design \
  --mount=<dir>/mu:/wordpress/wp-content/mu-plugins \
  --blueprint=docs/research/idle-performance-budgets/blueprint.json --login
WT=$PWD RUNS=20 IDLE_MS=60000 SCREEN=index.php node docs/research/idle-performance-budgets/measure.cjs
WT=$PWD N=30 node docs/research/idle-performance-budgets/php-ab.cjs
python3 docs/research/idle-performance-budgets/php-summ.py <dir>/mu/probe.jsonl
```

Results from these runs are committed in `dashboard.json`, `edit.json` and `php-ab.jsonl`. The scripts are throwaway research tools. The CI implementation should reimplement them as a Playwright spec and a test mu-plugin, not import them.
