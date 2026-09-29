import { test, expect, type Page, type Request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Deterministic counter gate (docs/research/idle-performance-budgets.md, B1, B4, B11, B12).
// Every probe runs with and without its negative control: gq-probe.php injects one violation,
// and the probe must catch it. Timings are out of scope here (#44).

const site = process.env.GQ_SUPPORT_TEST_URL ?? 'https://gq-support-lifecycle-testsite.ddev.site';
const testSite = join(__dirname, '..', '..', '..', '.test-site');
const probe = join(testSite, 'wp-content', 'mu-plugins', 'gq-support-probe.php');
// `ddev exec` hands its arguments to a shell, so quote each one. (`ddev wp` is far slower on macOS.)
const shellQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;
const wp = (args: string[]) => execFileSync('ddev', ['exec', '--dir', '/var/www/html/.test-site', ['wp', ...args].map(shellQuote).join(' ')], { encoding: 'utf8' }).trim();
const sync = () => { if (process.platform === 'darwin') execFileSync('ddev', ['mutagen', 'sync']); };
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
  copyFileSync(join(__dirname, '..', 'performance', 'gq-probe.php'), probe);
  sync();
  wp(['plugin', 'activate', 'gq-support']);
  setConnection('connected');
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
});

test.afterAll(() => {
  rmSync(probe, { force: true });
  sync();
  setConnection('not_connected');
  if (wooInstalled) wp(['plugin', wooWasActive ? 'activate' : 'deactivate', 'woocommerce']);
});

async function logIn(page: Page) {
  await page.goto(`${site}/wp-login.php`);
  await page.locator('#user_login').fill('admin');
  await page.locator('#user_pass').fill('launcher-test-password');
  await page.locator('#wp-submit').click();
  await page.waitForURL(/wp-admin/);
}

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
  const off = await fetchPage('gq_off=1');
  const on = await fetchPage(violationParam(violation));
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

const LAUNCHER = ['/wp-content/plugins/gq-support/assets/launcher.css', '/wp-content/plugins/gq-support/assets/launcher.js'];

for (const woo of wooInstalled ? [false, true] : [false]) {
  test.describe(`WooCommerce ${woo ? 'active' : 'inactive'}`, () => {
    test.beforeAll(() => { if (wooInstalled) wp(['plugin', woo ? 'activate' : 'deactivate', 'woocommerce']); });

    test('B1: a public request costs the plugin no bytes, SQL, HTTP or cron', async ({ page }) => {
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
