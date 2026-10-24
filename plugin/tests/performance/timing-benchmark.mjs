#!/usr/bin/env node
// Interleaved timing benchmark, report-only (T1–T3 in docs/research/idle-performance-budgets.md).
// Run from the repository root against the DDEV test site that plugin/tests/integration/run.sh leaves:
//   node plugin/tests/performance/timing-benchmark.mjs
// Environment:
//   GQ_BENCH_BASE          A built plugin tree to compare head with, such as `.bench-base/plugin` on a PR.
//   GQ_BENCH_BASE_COMMIT   That tree's commit, for the report.
//   GQ_BENCH_PHP_ROUNDS    PHP rounds (default 50). GQ_BENCH_BROWSER_ROUNDS: browser rounds (default 20).
//   GQ_BENCH_OUT           Output directory (default benchmark-results).
// Every round runs each variant once, in a rotating order: plugin off, base (when given) and head,
// on the same server. Results go to timing.json and the job summary. Only a broken harness or a
// promoted gate (none yet, see timing-stats.mjs) fails this script.
import { chromium, request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpus, release, type } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { adminPassword, logIn, probe, probeSource, repository as root, site, sync, testSite, wp } from './test-site.cjs';
import { buildReport, markdown } from './timing-stats.mjs';

const baseLink = join(testSite, 'wp-content', 'plugins', 'gq-support-base');
const wpConfig = join(testSite, 'wp-config.php');
const base = process.env.GQ_BENCH_BASE ? resolve(root, process.env.GQ_BENCH_BASE) : null;
const phpRounds = Number(process.env.GQ_BENCH_PHP_ROUNDS ?? 50);
const browserRounds = Number(process.env.GQ_BENCH_BROWSER_ROUNDS ?? 20);
const warmup = 5;
const out = resolve(root, process.env.GQ_BENCH_OUT ?? 'benchmark-results');

// The same environment as core's performance workflow (reusable-performance-test-v2.yml).
const FLAGS = { WP_DEBUG: 'false', SCRIPT_DEBUG: 'false', SAVEQUERIES: 'false', DISABLE_WP_CRON: 'true', WP_HTTP_BLOCK_EXTERNAL: 'true' };


const variants = ['off', ...(base ? ['base'] : []), 'head'];
const QUERY = { off: 'gq_off=1', base: 'gq_variant=base', head: '' };
// What each variant's dashboard must contain, so a misconfigured variant cannot pass as a fast one.
const LAUNCHER = { off: null, base: '/plugins/gq-support-base/assets/launcher.js', head: '/plugins/gq-support/assets/launcher.js' };

/** Round r runs the variants rotated by r, so no variant is always first or last. */
const order = (round, list) => list.map((_, i) => list[(i + round) % list.length]);

/** PHP wall time (ms) and peak memory (bytes) from gq-probe.php's Server-Timing header. */
function serverTiming(response) {
  const header = response.headers()['server-timing'] ?? '';
  const metric = (name) => Number(new RegExp(`${name};dur=([0-9.]+)`).exec(header)?.[1] ?? NaN);
  const timing = { ms: metric('wp-total'), memory: metric('wp-memory-usage') };
  if (!response.ok() || !Number.isFinite(timing.ms) || !Number.isFinite(timing.memory)) {
    throw new Error(`${response.url()} returned ${response.status()} without probe timings; is gq-probe.php installed?`);
  }
  return timing;
}

async function setUp() {
  if (base && !existsSync(join(base, 'assets', 'dist', 'index.asset.php'))) throw new Error(`${base} has no built app; run pnpm build:app there first`);
  const config = readFileSync(wpConfig, 'utf8');
  mkdirSync(dirname(probe), { recursive: true });
  copyFileSync(probeSource, probe);
  rmSync(baseLink, { force: true });
  if (base) symlinkSync(relative(dirname(baseLink), base), baseLink);
  sync();
  const state = wp(['eval', "echo wp_json_encode( get_option( 'gq_support_state', null ) );"]);
  const tearDown = () => {
    writeFileSync(wpConfig, config);
    rmSync(probe, { force: true });
    rmSync(baseLink, { force: true });
    sync();
    if (state !== 'null') wp(['option', 'update', 'gq_support_state', state, '--format=json']);
  };
  try {
    for (const [name, value] of Object.entries(FLAGS)) wp(['config', 'set', name, value, '--raw', '--type=constant']);
    wp(['plugin', 'activate', 'gq-support']);
    wp(['eval', "GQ_Support_State::update( array( 'connection' => 'connected' ) );"]);
    wp(['user', 'update', 'admin', `--user_pass=${adminPassword}`]);
  } catch (error) {
    tearDown();
    throw error;
  }
  return tearDown;
}

function metadata(browser) {
  const evaluate = (code) => wp(['eval', code]);
  return {
    commit: process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    baseCommit: base ? (process.env.GQ_BENCH_BASE_COMMIT ?? 'unknown') : null,
    wordpress: wp(['core', 'version']),
    php: evaluate('echo PHP_VERSION;'),
    database: evaluate('global $wpdb; echo $wpdb->db_server_info();'),
    browser: `chromium ${browser.version()}`,
    runner: {
      name: process.env.RUNNER_NAME ?? 'local',
      image: process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion}` : null,
      os: `${type()} ${release()}`,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
    },
    ddev: execFileSync('ddev', ['--version'], { encoding: 'utf8' }).trim(),
    objectCache: evaluate('echo wp_using_ext_object_cache() ? "persistent" : "none";'),
    pageCache: 'none: ?gq_probe=1 requests always run PHP',
    browserCache: 'cold: a new browser context per sample',
    activePlugins: JSON.parse(wp(['plugin', 'list', '--fields=name,status', '--format=json']))
      .filter(({ status }) => status.startsWith('active')).map(({ name }) => name),
    flags: FLAGS,
    variants,
    samples: { warmup, phpRounds, browserRounds },
  };
}

/** T1/M1 and T2/M2: one anonymous public request and one dashboard request per variant per round. */
async function samplePhp(anonymous, admin, samples) {
  const fetchBoth = async (variant) => {
    const flags = `gq_probe=1&${QUERY[variant]}`;
    const publicPage = await anonymous.get(`${site}/?${flags}`);
    const dashboard = await admin.get(`${site}/wp-admin/index.php?${flags}`);
    return { publicPage, dashboard };
  };
  for (const variant of variants) {
    for (let i = 0; i < warmup; i++) {
      const { publicPage, dashboard } = await fetchBoth(variant);
      serverTiming(publicPage);
      serverTiming(dashboard);
      const html = await dashboard.text();
      if (!html.includes('wpadminbar')) throw new Error(`The ${variant} dashboard request was not logged in`);
      if (LAUNCHER[variant] ? !html.includes(LAUNCHER[variant]) : html.includes('gq-support-root')) {
        throw new Error(`The ${variant} dashboard did not load the expected plugin tree`);
      }
    }
  }
  for (let round = 0; round < phpRounds; round++) {
    for (const variant of order(round, variants)) {
      const { publicPage, dashboard } = await fetchBoth(variant);
      const anonymousTiming = serverTiming(publicPage);
      const adminTiming = serverTiming(dashboard);
      samples.T1[variant].push(anonymousTiming.ms);
      samples.M1[variant].push(anonymousTiming.memory);
      samples.T2[variant].push(adminTiming.ms);
      samples.M2[variant].push(adminTiming.memory);
    }
  }
}

/** T3: click the closed launcher on a freshly loaded dashboard and time until the Description field has focus. */
async function sampleOpen(browser, storageState, variant) {
  const context = await browser.newContext({ storageState, ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(`${site}/wp-admin/index.php?${QUERY[variant]}`);
    await page.locator('.gq-support-launcher').waitFor();
    await page.waitForLoadState('networkidle');
    return await page.evaluate(() => new Promise((done, fail) => {
      const timeout = setTimeout(() => fail(new Error('The Description field never received focus')), 15000);
      const start = performance.now();
      document.addEventListener('focusin', (event) => {
        if (event.target instanceof HTMLElement && event.target.id === 'gq-support-description') {
          clearTimeout(timeout);
          done(performance.now() - start);
        }
      });
      document.querySelector('.gq-support-launcher').click();
    }));
  } finally {
    await context.close();
  }
}

async function main() {
  const tearDown = await setUp();
  const browser = await chromium.launch();
  try {
    const samples = Object.fromEntries(['T1', 'M1', 'T2', 'M2'].map((id) => [id, Object.fromEntries(variants.map((variant) => [variant, []]))]));
    const opened = variants.filter((variant) => variant !== 'off');
    samples.T3 = Object.fromEntries(opened.map((variant) => [variant, []]));

    const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const loginPage = await adminContext.newPage();
    await logIn(loginPage);
    await loginPage.close();
    const storageState = await adminContext.storageState();
    const anonymous = await request.newContext({ ignoreHTTPSErrors: true });
    await samplePhp(anonymous, adminContext.request, samples);
    await anonymous.dispose();

    for (const variant of opened) for (let i = 0; i < warmup; i++) await sampleOpen(browser, storageState, variant);
    for (let round = 0; round < browserRounds; round++) {
      for (const variant of order(round, opened)) samples.T3[variant].push(await sampleOpen(browser, storageState, variant));
    }
    await adminContext.close();

    const report = buildReport({ metadata: { ...metadata(browser), finishedAt: new Date().toISOString() }, samples });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'timing.json'), `${JSON.stringify({ ...report, samples }, null, 2)}\n`);
    const summary = markdown(report);
    process.stdout.write(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    if (report.failing.length) {
      console.error(`Promoted timing gates failed: ${report.failing.join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    tearDown();
  }
}

await main();
