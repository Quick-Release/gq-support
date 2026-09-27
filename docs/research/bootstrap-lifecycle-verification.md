# Bootstrap/lifecycle verification for #30

Run from the repository root with DDEV and Docker available. The dedicated `.ddev/config.yaml` project uses the ignored `.test-site/` docroot and a test-only `getquick-design` stub; it never touches a production installation. `plugin/tests/integration/run.sh` installs WordPress and a standard theme, rejects activation without the dependency, then exercises activation, silent version migration, cloned-site identity rotation, deactivation/reactivation, an authenticated Editor dashboard and an anonymous public HTTP request. `plugin/tests/integration/multisite.sh` **converts that disposable site to multisite**, then exercises network activation, per-site identity, new-site lazy initialization, site deletion and bounded uninstall. Do not run the conversion on a site whose data you intend to retain. CI runs these scripts in order in the DDEV lifecycle job against WordPress 6.5.0 (the declared minimum) and the current latest release. No plugin-owned WP-CLI commands, WP-Cron events or REST routes are added in this slice.

## Installation identity and clones

An installation's opaque ID is bound to its site `home_url('/')` in a non-autoloaded local marker. After a **subsequent URL change** (such as a production database copied to staging and its home URL replaced), the next relevant admin, REST, or WP-CLI context rotates the ID. The old ID must not be reused for repository mapping; the operator must explicitly reconnect the installation. Public requests do not perform this check. A deliberate domain move also rotates the ID. Cloning without changing the URL cannot be distinguished locally, and a copy of an older schema-1 database that is first upgraded *after* cloning lacks the original URL marker; operators must explicitly rebind those cases. Any future service/REST integration must resolve identity through this lifecycle gate and reject an installation with no approved mapping rather than trusting a browser-supplied ID.

To reproduce the public-request measurement, run `python3 plugin/tests/integration/benchmark.py 100` after either test. The script installs the same disposable mu-plugin probe for both cases, warms each case with five requests, collects 100 sequential public HTTP samples with the plugin inactive and 100 with it active, then restores activation and removes the probe. It enables `SAVEQUERIES` on the **test site only**; remove/reset that test-site setting to compare with another environment. Query time comes from WordPress `SAVEQUERIES`; wall time is PHP request start to shutdown, not client network latency. Asset bytes count GQ assets only; the HTML check in `run.sh` verifies no GQ assets on the public page.

## Local measurement (2026-09-27)

DDEV 1.25.4, PHP 8.2, WordPress 7.1.2, MariaDB 11.8, Twenty Twenty-Five 1.5, multisite main site, macOS arm64 + OrbStack, 100 warm requests each case, sequential inactive then active, unauthenticated homepage:

| Metric | Inactive median / p95 | Active median / p95 |
| --- | ---: | ---: |
| PHP wall time (ms) | 17.01 / 17.56 | 17.09 / 18.04 |
| Peak memory (bytes) | 8,388,608 / 8,388,608 | 8,388,608 / 8,388,608 |
| SQL count | 27 / 27 | 27 / 27 |
| SQL time (ms) | 1.12 / 1.21 | 1.12 / 1.25 |
| HTTP API calls | 0 / 0 | 0 / 0 |
| HTML bytes | 70,730 / 70,730 | 70,730 / 70,730 |
| GQ asset bytes | 0 / 0 | 0 / 0 |

Observed median PHP delta: +0.08 ms (+0.47%); p95 delta: +0.48 ms. A second 100-request run on the same setup yielded 17.64 / 18.70 ms inactive versus 18.21 / 21.40 ms active (median delta +0.57 ms, +3.2%; p95 delta +2.70 ms), with the same query count, memory, HTTP count, HTML size and zero GQ assets. **The second run misses the proposed 1% median target.** DDEV noise and sequential inactive-then-active ordering make this insufficient to establish a production-like budget; rerun with interleaved samples on a production-like installation before treating the targets as release gates. No measurement supports a claim of zero PHP overhead.
