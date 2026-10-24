import { test, expect, type APIResponse, type Page, type Request } from '@playwright/test';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { adminPassword, forgetLogIn, logIn, probe, probeSource, site, sync, wp } from '../performance/test-site.cjs';

// Deterministic counter gate (docs/research/idle-performance-budgets.md, B1–B4, B6, B8 and B10–B13).
// Every probe runs with and without its negative control: gq-probe.php injects one violation,
// and the probe must catch it. Timings are report-only, in plugin/tests/performance/timing-benchmark.mjs.

const setConnection = (connection: string) => wp(['eval', `GQ_Support_State::update( array( 'connection' => '${connection}' ) );`]);

// Requests the plugin owns: its files, its REST routes, AJAX actions and the Worker.
const PLUGIN_OWNED = /\/plugins\/gq-support\/|gq-support\/v1|rest_route=%2Fgq-support|fake-worker\.gq-support\.test/;
const pluginOwned = (request: Request) => PLUGIN_OWNED.test(request.url())
  || (/admin-ajax\.php/.test(request.url()) && /action=gq_support/.test(`${request.url()} ${request.postData() ?? ''}`));

const wooInstalled = (() => {
  try {
    wp(['plugin', 'is-installed', 'woocommerce']);
    return true;
  } catch {
    return false;
  }
})();
const wooWasActive = wooInstalled && wp(['plugin', 'list', '--name=woocommerce', '--field=status']) === 'active';

/** A test-site login. */
type Account = { login: string; password: string };

/** B3's users: logged in, without `gq_support_submit_requests`. A shop manager reaches WooCommerce screens. */
const EDITOR: Account = { login: 'editor', password: 'editor' };
const SHOP_MANAGER: Account = { login: 'shopmanager', password: 'shopmanager' };

/** Creates the user if needed, resets its password, and takes away any direct Support grant. */
function ensureUser({ login, password }: Account, role: string) {
  if (!wp(['user', 'list', `--login=${login}`, '--field=ID'])) {
    wp(['user', 'create', login, `${login}@example.test`, `--role=${role}`]);
  }
  wp(['user', 'update', login, `--user_pass=${password}`]);
  const userExpr = `get_user_by( 'login', '${login}' )`;
  wp(['eval', `( new WP_User( ${userExpr} ) )->remove_cap( 'gq_support_submit_requests' );`]);
  // B3 measures nothing if the role still grants the capability.
  expect(wp(['eval', `echo user_can( ${userExpr}, 'gq_support_submit_requests' ) ? 'yes' : 'no';`]), `${login} can submit requests`).toBe('no');
}

// Deactivating a plugin (here WooCommerce itself) resets Action Scheduler's store migration, which runs
// again a minute later. Until it does, the dashboard peaks up to 40 KB higher with Support on. Finish it,
// to measure the steady state.
const settleWooCommerce = () => wp(['eval', 'if ( ! ActionScheduler_DataController::is_migration_complete() ) { WP_CLI::runcommand( "action-scheduler migrate" ); }']);

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(dirname(probe), { recursive: true });
  copyFileSync(probeSource, probe);
  sync();
  wp(['plugin', 'activate', 'gq-support']);
  setConnection('connected');
  wp(['user', 'update', 'admin', `--user_pass=${adminPassword}`]);
  ensureUser(EDITOR, 'editor');
  forgetLogIn();
});

test.afterAll(() => {
  rmSync(probe, { force: true });
  sync();
  setConnection('not_connected');
  if (wooInstalled) wp(['plugin', wooWasActive ? 'activate' : 'deactivate', 'woocommerce']);
});

/** The query flag that makes gq-probe.php inject one violation. */
function violationParam(violation?: string) {
  return violation ? `gq_violate=${violation}` : '';
}

// WooCommerce stamps the Store API nonce with the current second, URL-encoded in the
// mini-cart's dependency data. Two requests a second apart differ there with or without Support.
const withoutClock = (html: string) => html.replace(/(wcStoreApiNonceTimestamp(?:%3A%20%27|:\s*'))\d+/g, '$1<time>');

/** Sends one request with gq-probe.php's query flags. */
type Send = (flags: string) => Promise<APIResponse>;

const getPath = (page: Page, path: string): Send => (flags) => page.request.get(`${site}${path}${path.includes('?') ? '&' : '?'}${flags}`);

/** One probed request: its body, the plugin's SQL, HTTP and cron counts, and the request's PHP peak memory. */
async function probed(send: Send, flags: string) {
  const response = await send(`gq_probe=1&${flags}`);
  expect(response.ok(), `${response.url()} answered ${response.status()}`).toBe(true);
  const counters = JSON.parse(response.headers()['x-gq-probe'] ?? 'null');
  expect(counters, 'the probe reported no counters').not.toBeNull();
  const memory = Number(/wp-memory-usage;dur=(\d+)/.exec(response.headers()['server-timing'] ?? '')?.[1]);
  expect(memory, 'the probe reported no peak memory').toBeGreaterThan(0);
  const body = await response.text();
  expect(body, 'the probe lost the response').not.toBe('');
  return { body, counters: counters as { sql: number; http: number; cron: number }, memory };
}

/** B1: what one anonymous public request costs the plugin: HTML that differs from a plugin-off request, and its SQL, HTTP and cron. */
async function publicCost(page: Page, violation?: string) {
  const fetchPage = async (flags: string) => {
    const { body, counters } = await probed(getPath(page, '/'), flags);
    return { html: withoutClock(body), counters };
  };
  // Finish third-party first-request setup (WooCommerce's Jetpack cron registration)
  // with Support disabled. The comparison still measures Support's first enabled request.
  await fetchPage('gq_off=1');
  const off = await fetchPage('gq_off=1');
  const on = await fetchPage(violationParam(violation));
  if (!violation && on.html !== off.html) {
    for (const [name, html] of [['public-off.html', off.html], ['public-on.html', on.html]]) {
      const path = test.info().outputPath(name);
      writeFileSync(path, html);
      await test.info().attach(name, { path, contentType: 'text/html' });
    }
  }
  return { htmlDiffers: on.html !== off.html, ...on.counters };
}

/** B12: autoloaded bytes in options and transients the plugin owns. */
function autoloadedBytes(): number {
  return Number(wp(['eval', `
    global $wpdb;
    $values = function_exists( 'wp_autoload_values_to_autoload' ) ? wp_autoload_values_to_autoload() : array( 'yes' );
    $in = implode( ',', array_fill( 0, count( $values ), '%s' ) );
    echo (int) $wpdb->get_var( $wpdb->prepare( "SELECT COALESCE( SUM( LENGTH( option_value ) ), 0 ) FROM {$wpdb->options} WHERE ( option_name LIKE 'gq\\\\_support\\\\_%' OR option_name LIKE '\\\\_%transient%\\\\_gq\\\\_support\\\\_%' ) AND autoload IN ( $in )", ...$values ) );
  `]));
}

/** B4: plugin-owned requests while the launcher is closed. */
async function closedLauncherRequests(page: Page, screen: string, violation?: string) {
  const requests: string[] = [];
  page.on('request', (request) => { if (pluginOwned(request)) requests.push(new URL(request.url()).pathname); });
  await page.goto(`${site}/wp-admin/${screen}${screen.includes('?') ? '&' : '?'}${violationParam(violation)}`);
  await expect(page.getByRole('button', { name: /^Support/ })).toBeVisible();
  await page.waitForLoadState('networkidle');
  return requests.sort();
}

/** B11: plugin-owned requests in 60 s of idle, after focus, online and visibility events, before and after one use. */
async function idleRequests(page: Page, violation?: string) {
  await page.clock.install();
  await page.goto(`${site}/wp-admin/index.php?${violationParam(violation)}`);
  const launcher = page.getByRole('button', { name: /^Support/ });
  await expect(launcher).toBeVisible();
  await page.waitForLoadState('networkidle');
  const requests: string[] = [];
  let idling = false;
  page.on('request', (request) => { if (idling && pluginOwned(request)) requests.push(request.url()); });
  const idle = async () => {
    idling = true;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(60_000);
    await page.waitForLoadState('networkidle');
    idling = false;
  };
  await idle();
  // One use: the first open loads the app, which is not idle traffic.
  await launcher.click();
  await expect(page.getByRole('dialog', { name: 'Support' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForLoadState('networkidle');
  await idle();
  return requests;
}

/** B11: interval timers the plugin's scripts register, before and after one use. */
async function pluginTimers(page: Page, violation?: string) {
  await page.addInitScript(() => {
    const original = window.setInterval;
    (window as unknown as { gqTimers: string[] }).gqTimers = [];
    window.setInterval = function (this: unknown, ...args: Parameters<typeof setInterval>) {
      const script = document.currentScript as HTMLScriptElement | null;
      // A plugin file in the stack, or an inline script the plugin printed (id gq-support-…).
      // The bare string is not enough: the test site's hostname contains it.
      const source = `${script?.src ?? ''}\n${new Error().stack ?? ''}`;
      if (/\/plugins\/gq-support\//.test(source) || /^gq-support-/.test(script?.id ?? '')) {
        (window as unknown as { gqTimers: string[] }).gqTimers.push(`${script?.id ?? ''} ${source}`.slice(0, 200));
      }
      return original.apply(this, args);
    } as typeof setInterval;
  });
  await page.goto(`${site}/wp-admin/index.php?${violationParam(violation)}`);
  const launcher = page.getByRole('button', { name: /^Support/ });
  await launcher.click();
  await expect(page.getByRole('dialog', { name: 'Support' })).toBeVisible();
  await page.keyboard.press('Escape');
  return page.evaluate(() => (window as unknown as { gqTimers: string[] }).gqTimers);
}

const REST = /gq-support\/v1|rest_route=%2Fgq-support/;
const PLUGIN_FILE = /\/plugins\/gq-support\//;

const isPreview = (request: Request) => /admin-ajax\.php/.test(request.url()) && /action=gq_support_context/.test(request.postData() ?? '');

/**
 * B8 and B10 (and B7's request count): plugin REST calls, Report context previews and file requests
 * on first open, on My requests, and on reopen.
 */
async function openCosts(page: Page, violation?: string) {
  await page.goto(`${site}/wp-admin/index.php?${violationParam(violation)}`);
  const launcher = page.getByRole('button', { name: /^Support/ });
  const dialog = page.getByRole('dialog', { name: 'Support' });
  await expect(launcher).toBeVisible();
  await page.waitForLoadState('networkidle');
  const costs = { open: { rest: 0, preview: 0, files: 0 }, requests: { rest: 0, preview: 0, files: 0 }, reopen: { rest: 0, preview: 0, files: 0 } };
  const lists: URL[] = [];
  let phase: keyof typeof costs | null = null;
  page.on('request', (request) => {
    if (!phase) return;
    if (REST.test(request.url())) {
      costs[phase].rest++;
      if (request.method() === 'GET') lists.push(new URL(request.url()));
    } else if (isPreview(request)) costs[phase].preview++;
    else if (PLUGIN_FILE.test(request.url())) costs[phase].files++;
  });
  // Requests start on the click itself; give late ones a moment to appear.
  const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500); };
  const myRequests = page.getByRole('tab', { name: 'My requests' });
  phase = 'open';
  await launcher.click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeFocused();
  await settle();
  phase = 'requests';
  await myRequests.click();
  await settle();
  phase = null;
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await settle();
  // Reopen lands on New report; showing My requests again reuses the first load.
  phase = 'reopen';
  await launcher.click();
  await expect(dialog).toBeVisible();
  await myRequests.click();
  await settle();
  phase = null;
  return { ...costs, perPage: lists.map((url) => Number(url.searchParams.get('per_page') ?? 20)) };
}

/** Adapter timeouts in docs/support-api-contract.md. */
const ADAPTER_TIMEOUT_S = { GET: 5, POST: 8 };

/** B13: one plugin route against the fake Worker in an outage mode: its status, code and duration. */
async function routeDuringOutage(page: Page, method: 'GET' | 'POST') {
  await page.goto(`${site}/wp-admin/index.php`);
  const binding = await page.evaluate(() => (window as unknown as { gqSupportLauncher: { session: string; ajaxUrl: string } }).gqSupportLauncher);
  const { nonce } = await (await page.request.get(`${binding.ajaxUrl}?action=gq_support_session&session=${binding.session}`)).json();
  const url = `${site}/?rest_route=/gq-support/v1/requests`;
  const options = { headers: { 'X-WP-Nonce': nonce }, timeout: 60_000 };
  const started = performance.now();
  const response = method === 'GET'
    ? await page.request.get(url, options)
    : await page.request.post(url, { ...options, data: { submission_id: randomUUID(), description: 'Provider outage probe' } });
  return { status: response.status(), code: (await response.json()).code, seconds: (performance.now() - started) / 1000 };
}

/** An active signing key, so plugin routes reach the fake Worker. Returns a function that restores the previous key and state. */
function withSigningKey() {
  const read = (option: string) => wp(['eval', `echo wp_json_encode( get_option( '${option}', null ) );`]);
  const saved = { key: read('gq_support_signing_key'), state: read('gq_support_state') };
  wp(['eval', `GQ_Support_Signing_Key::pending_for( 'GQ-OUTAGE-PROBE' ); GQ_Support_Signing_Key::promote(); GQ_Support_State::update( array( 'connection' => 'connected', 'key_id' => 'key_outage_probe' ) );`]);
  return () => {
    if (saved.key === 'null') wp(['option', 'delete', 'gq_support_signing_key']);
    else wp(['option', 'update', 'gq_support_signing_key', saved.key, '--format=json']);
    if (saved.state !== 'null') wp(['option', 'update', 'gq_support_state', saved.state, '--format=json']);
  };
}

const KB = 1024;
/** Ceilings from docs/research/idle-performance-budgets.md; memory is bytes of `memory_get_peak_usage()`. */
const BUDGET = { B2: { memory: 32 * KB }, B3: { sql: 2 }, B6: { sql: 4, memory: 64 * KB } };

// A plugin file, or an element the plugin prints, also inside JSON with escaped slashes.
const PLUGIN_ASSET = /plugins\\?\/gq-support\\?\/|id=\\?["']gq-support-/;

/** Interleaved pairs after the warm-up pair. Peak memory repeats to within bytes on one site. */
const PAIRS = 3;

/**
 * B2, B3 and B6: what one request costs the plugin in PHP. SQL and HTTP are the worst plugin-on
 * sample. Memory is the plugin-on peak over the plugin-off peak, each the smallest of its samples:
 * one-off core work (a cron spawn, a transient refresh) only ever adds to a sample.
 */
async function phpCost(send: Send, violation?: string) {
  // Warm both paths: the opcode cache, and third-party first-request setup.
  await probed(send, 'gq_off=1');
  await probed(send, violationParam(violation));
  const off: number[] = [];
  const on: Awaited<ReturnType<typeof probed>>[] = [];
  for (let pair = 0; pair < PAIRS; pair++) {
    off.push((await probed(send, 'gq_off=1')).memory);
    on.push(await probed(send, violationParam(violation)));
  }
  return {
    assets: on.some(({ body }) => PLUGIN_ASSET.test(body)),
    sql: Math.max(...on.map(({ counters }) => counters.sql)),
    http: Math.max(...on.map(({ counters }) => counters.http)),
    memory: Math.min(...on.map(({ memory }) => memory)) - Math.min(...off),
  };
}

/** Records a measured cost on the test, for ratcheting the budgets later. */
function report(name: string, cost: object) {
  test.info().annotations.push({ type: name, description: JSON.stringify(cost) });
}

/** B2: an anonymous public request costs at most 32 KB of peak memory. */
async function assertB2(page: Page) {
  const cost = await phpCost(getPath(page, '/'));
  report('B2 /', cost);
  expect(cost.memory, 'B2: memory delta').toBeLessThanOrEqual(BUDGET.B2.memory);
  expect((await phpCost(getPath(page, '/'), 'memory')).memory, 'negative control: memory').toBeGreaterThan(BUDGET.B2.memory);
}

/** B3's requests: admin screens, core AJAX (Heartbeat) and core REST, as the logged-in page's user. */
async function requestsWithoutCapability(page: Page, screens: string[]): Promise<[string, Send][]> {
  const nonce = await (await page.request.get(`${site}/wp-admin/admin-ajax.php?action=rest-nonce`)).text();
  return [
    ...screens.map((screen): [string, Send] => [screen, getPath(page, `/wp-admin/${screen}`)]),
    ['admin-ajax.php heartbeat', (flags) => page.request.post(`${site}/wp-admin/admin-ajax.php?${flags}`, { form: { action: 'heartbeat' } })],
    ['REST /wp/v2/users/me', (flags) => page.request.get(`${site}/?rest_route=/wp/v2/users/me&${flags}`, { headers: { 'X-WP-Nonce': nonce } })],
  ];
}

/** B3: a user without the Reporter capability gets no plugin assets, at most 2 plugin queries and no HTTP. */
async function assertB3(page: Page, account: Account, screens: string[]) {
  await logIn(page, account.login, account.password);
  const requests = await requestsWithoutCapability(page, screens);
  for (const [name, send] of requests) {
    const cost = await phpCost(send);
    report(`B3 ${account.login} ${name}`, cost);
    expect(cost.assets, `B3 ${name}: plugin assets`).toBe(false);
    expect(cost.sql, `B3 ${name}: plugin SQL`).toBeLessThanOrEqual(BUDGET.B3.sql);
    expect(cost.http, `B3 ${name}: HTTP API`).toBe(0);
  }
  const [, screen] = requests[0];
  expect((await phpCost(screen, 'bytes')).assets, 'negative control: assets').toBe(true);
  expect((await phpCost(screen, 'sql')).sql, 'negative control: sql').toBeGreaterThan(BUDGET.B3.sql);
  expect((await phpCost(screen, 'http')).http, 'negative control: http').toBeGreaterThan(0);
}

/** B6: an eligible screen with the launcher closed costs at most 4 plugin queries, no HTTP and 64 KB of peak memory. */
async function assertB6(page: Page, screens: string[]) {
  await logIn(page);
  for (const screen of screens) {
    const cost = await phpCost(getPath(page, `/wp-admin/${screen}`));
    report(`B6 ${screen}`, cost);
    // The launcher rendered, so this measured the eligible path.
    expect(cost.assets, `B6 ${screen}: launcher`).toBe(true);
    expect(cost.sql, `B6 ${screen}: plugin SQL`).toBeLessThanOrEqual(BUDGET.B6.sql);
    expect(cost.http, `B6 ${screen}: HTTP API`).toBe(0);
    expect(cost.memory, `B6 ${screen}: memory delta`).toBeLessThanOrEqual(BUDGET.B6.memory);
  }
  const screen = getPath(page, `/wp-admin/${screens[0]}`);
  expect((await phpCost(screen, 'sql')).sql, 'negative control: sql').toBeGreaterThan(BUDGET.B6.sql);
  expect((await phpCost(screen, 'http')).http, 'negative control: http').toBeGreaterThan(0);
  expect((await phpCost(screen, 'memory')).memory, 'negative control: memory').toBeGreaterThan(BUDGET.B6.memory);
}

const LAUNCHER = ['/wp-content/plugins/gq-support/assets/launcher.css', '/wp-content/plugins/gq-support/assets/launcher.js'];

for (const woo of wooInstalled ? [false, true] : [false]) {
  test.describe(`WooCommerce ${woo ? 'active' : 'inactive'}`, () => {
    test.beforeAll(() => {
      if (wooInstalled) wp(['plugin', woo ? 'activate' : 'deactivate', 'woocommerce']);
      if (woo) {
        settleWooCommerce();
        ensureUser(SHOP_MANAGER, 'shop_manager');
      }
    });

    test('B1: a public request costs the plugin no bytes, SQL, HTTP or cron', async ({ page }) => {
      // Reproduce the release fixture's cold Jetpack state without booting WooCommerce in CLI.
      if (woo) wp(['cron', 'event', 'delete', 'jetpack_clean_nonces', '--skip-plugins=woocommerce']);
      expect(await publicCost(page)).toEqual({ htmlDiffers: false, sql: 0, http: 0, cron: 0 });
      expect((await publicCost(page, 'bytes')).htmlDiffers, 'negative control: bytes').toBe(true);
      for (const counter of ['sql', 'http', 'cron']) {
        expect((await publicCost(page, counter))[counter], `negative control: ${counter}`).toBeGreaterThan(0);
      }
    });

    test('B12: the plugin autoloads no bytes', () => {
      // A CLI request runs ensure_site(), so the state option exists.
      wp(['eval', 'GQ_Support_State::get();']);
      expect(autoloadedBytes()).toBe(0);
      wp(['option', 'add', 'gq_support_probe', 'autoloaded', '--autoload=yes']);
      try {
        expect(autoloadedBytes(), 'negative control: an autoloaded option').toBeGreaterThan(0);
      } finally {
        wp(['option', 'delete', 'gq_support_probe']);
      }
    });

    test('B2: a public request costs at most 32 KB of PHP memory', async ({ page }) => {
      await assertB2(page);
    });

    test('B3: without the Reporter capability, admin, AJAX and REST requests get no assets, ≤ 2 plugin queries and no HTTP', async ({ page }) => {
      await assertB3(page, EDITOR, ['index.php', 'edit.php', 'profile.php']);
      if (woo) await assertB3(page, SHOP_MANAGER, ['admin.php?page=wc-settings']);
    });

    const screens = woo ? ['index.php', 'admin.php?page=wc-settings'] : ['index.php'];

    test('B6: a closed launcher costs ≤ 4 plugin queries, no HTTP and ≤ 64 KB of PHP memory', async ({ page }) => {
      await assertB6(page, screens);
    });

    for (const screen of screens) {
      test(`B4: a closed launcher on ${screen} makes exactly two plugin requests`, async ({ page }) => {
        await logIn(page);
        expect(await closedLauncherRequests(page, screen)).toEqual(LAUNCHER);
      });
    }

    test('B4: negative control, a third plugin request', async ({ page }) => {
      await logIn(page);
      expect((await closedLauncherRequests(page, 'index.php', 'request')).length).toBe(3);
    });

    test('B8 and B10: first open and reopen stay within their REST and file budgets', async ({ page }) => {
      await logIn(page);
      const costs = await openCosts(page);
      // B7: at most the app's two files. B8: New report makes no REST call and one Report context preview.
      expect(costs.open.rest).toBe(0);
      expect(costs.open.preview).toBe(1);
      expect(costs.open.files).toBeLessThanOrEqual(2);
      expect(costs.requests.preview).toBe(0);
      // B8: exactly one list call when My requests is shown, at the default page size or less.
      expect(costs.requests.rest).toBe(1);
      expect(costs.perPage).toHaveLength(1);
      expect(costs.perPage[0]).toBeLessThanOrEqual(20);
      // B10: nothing is fetched again without an explicit refresh, even when My requests is shown again.
      expect(costs.reopen).toEqual({ rest: 0, preview: 0, files: 0 });
    });

    test('B8: negative control, two list calls when My requests is shown', async ({ page }) => {
      await logIn(page);
      const costs = await openCosts(page, 'list');
      expect(costs.requests.rest, 'negative control: a second list call').toBeGreaterThan(1);
    });

    test('B8 and B10: negative control, a Report context preview on every open', async ({ page }) => {
      await logIn(page);
      const costs = await openCosts(page, 'preview');
      expect(costs.open.preview, 'negative control: a second preview on first open').toBeGreaterThan(1);
      expect(costs.reopen.preview, 'negative control: a preview on reopen').toBeGreaterThan(0);
    });

    test('B8 and B10: negative control, a REST call on every open', async ({ page }) => {
      await logIn(page);
      const costs = await openCosts(page, 'rest');
      expect(costs.open.rest, 'negative control: REST on first open').toBeGreaterThan(0);
      expect(costs.reopen.rest, 'negative control: REST on reopen').toBeGreaterThan(0);
    });

    test('B11: no plugin traffic while idle, before or after use', async ({ page }) => {
      await logIn(page);
      expect(await idleRequests(page)).toEqual([]);
    });

    test('B11: negative control, traffic on focus', async ({ page }) => {
      await logIn(page);
      expect((await idleRequests(page, 'idle')).length).toBeGreaterThan(0);
    });

    test('B11: no plugin interval timers, before or after use', async ({ page }) => {
      await logIn(page);
      expect(await pluginTimers(page)).toEqual([]);
      expect((await pluginTimers(page, 'timer')).length, 'negative control: an interval timer').toBeGreaterThan(0);
    });
  });
}

test.describe('B13: provider outage', () => {
  let restore: () => void;
  test.beforeAll(() => {
    if (wooInstalled) wp(['plugin', 'deactivate', 'woocommerce']);
    restore = withSigningKey();
  });
  test.afterAll(() => restore());

  for (const outage of ['down', 'hang']) {
    test(`with the Worker ${outage}, public and closed-launcher budgets still hold`, async ({ page, context }) => {
      await context.addCookies([{ name: 'gq_worker', value: outage, url: site }]);
      expect(await publicCost(page)).toEqual({ htmlDiffers: false, sql: 0, http: 0, cron: 0 });
      await logIn(page);
      expect(await closedLauncherRequests(page, 'index.php')).toEqual(LAUNCHER);
    });

    test(`with the Worker ${outage}, PHP memory, SQL and HTTP budgets still hold`, async ({ page, context }) => {
      test.setTimeout(60_000);
      await context.addCookies([{ name: 'gq_worker', value: outage, url: site }]);
      await assertB2(page);
      await assertB3(page, EDITOR, ['index.php']);
      await assertB6(page, ['index.php']);
    });

    test(`with the Worker ${outage}, plugin routes return within the adapter timeout + 1 s`, async ({ page, context }) => {
      test.setTimeout(60_000);
      await logIn(page);
      await context.addCookies([{ name: 'gq_worker', value: outage, url: site }]);
      // The codes come from the service client's failure, so each route reached the fake Worker.
      const list = await routeDuringOutage(page, 'GET');
      expect(list).toMatchObject({ status: 503, code: 'gq_support_unavailable' });
      expect(list.seconds).toBeLessThanOrEqual(ADAPTER_TIMEOUT_S.GET + 1);
      const create = await routeDuringOutage(page, 'POST');
      expect(create).toMatchObject({ status: 504, code: 'gq_support_outcome_unknown' });
      expect(create.seconds).toBeLessThanOrEqual(ADAPTER_TIMEOUT_S.POST + 1);
    });
  }

  test('negative control: a Worker that overruns the adapter timeout breaks the bound', async ({ page, context }) => {
    test.setTimeout(60_000);
    await logIn(page);
    await context.addCookies([{ name: 'gq_worker', value: 'stall', url: site }]);
    expect((await routeDuringOutage(page, 'GET')).seconds).toBeGreaterThan(ADAPTER_TIMEOUT_S.GET + 1);
  });
});
