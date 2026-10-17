import { test, expect, type Page, type Request } from '@playwright/test';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { adminPassword, logIn, probe, probeSource, site, sync, wp } from '../performance/test-site.cjs';

// Deterministic counter gate (docs/research/idle-performance-budgets.md, B1, B4, B8, B10–B13).
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

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(dirname(probe), { recursive: true });
  copyFileSync(probeSource, probe);
  sync();
  wp(['plugin', 'activate', 'gq-support']);
  setConnection('connected');
  wp(['user', 'update', 'admin', `--user_pass=${adminPassword}`]);
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

/** B1: what one anonymous public request costs the plugin: HTML that differs from a plugin-off request, and its SQL, HTTP and cron. */
async function publicCost(page: Page, violation?: string) {
  const fetchPage = async (flags: string) => {
    const response = await page.request.get(`${site}/?gq_probe=1&${flags}`);
    expect(response.ok()).toBe(true);
    const counters = JSON.parse(response.headers()['x-gq-probe'] ?? 'null');
    expect(counters, 'the probe reported no counters').not.toBeNull();
    return { html: await response.text(), counters };
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

/** B8 and B10 (and B7's request count): plugin REST calls and file requests on first open, on My requests, and on reopen. */
async function openCosts(page: Page, violation?: string) {
  await page.goto(`${site}/wp-admin/index.php?${violationParam(violation)}`);
  const launcher = page.getByRole('button', { name: /^Support/ });
  const dialog = page.getByRole('dialog', { name: 'Support' });
  await expect(launcher).toBeVisible();
  await page.waitForLoadState('networkidle');
  const costs = { open: { rest: 0, files: 0 }, requests: { rest: 0, files: 0 }, reopen: { rest: 0, files: 0 } };
  let phase: keyof typeof costs | null = null;
  page.on('request', (request) => {
    if (!phase) return;
    if (REST.test(request.url())) costs[phase].rest++;
    else if (PLUGIN_FILE.test(request.url())) costs[phase].files++;
  });
  // Requests start on the click itself; give late ones a moment to appear.
  const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(500); };
  phase = 'open';
  await launcher.click();
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeFocused();
  await settle();
  phase = 'requests';
  await page.getByRole('tab', { name: 'My requests' }).click();
  await settle();
  phase = null;
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await settle();
  phase = 'reopen';
  await launcher.click();
  await expect(dialog).toBeVisible();
  await settle();
  phase = null;
  return costs;
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

const LAUNCHER = ['/wp-content/plugins/gq-support/assets/launcher.css', '/wp-content/plugins/gq-support/assets/launcher.js'];

for (const woo of wooInstalled ? [false, true] : [false]) {
  test.describe(`WooCommerce ${woo ? 'active' : 'inactive'}`, () => {
    test.beforeAll(() => { if (wooInstalled) wp(['plugin', woo ? 'activate' : 'deactivate', 'woocommerce']); });

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

    const screens = woo ? ['index.php', 'admin.php?page=wc-settings'] : ['index.php'];
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
      // B7: at most the app's two files. B8: New report makes no REST call.
      expect(costs.open.rest).toBe(0);
      expect(costs.open.files).toBeLessThanOrEqual(2);
      // B8: at most one list call when My requests is shown.
      expect(costs.requests.rest).toBeLessThanOrEqual(1);
      // B10: nothing is fetched again without an explicit refresh.
      expect(costs.reopen).toEqual({ rest: 0, files: 0 });
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
