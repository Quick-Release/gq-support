import { test, expect } from '@playwright/test';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { forgetLogIn, logIn, probe, probeSource, site, sync, wp } from '../performance/test-site.cjs';

// Native updates at the installed plugin (#142). gq-probe.php counts the plugin's outbound HTTP per
// request and points the service at a fake Worker that answers 503, so nothing can leave the machine.

test.describe.configure({ mode: 'serial' });

const GRANT = 'fixture-grant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SHA256 = 'a'.repeat(64);

test.beforeAll(() => {
  mkdirSync(dirname(probe), { recursive: true });
  copyFileSync(probeSource, probe);
  sync();
  // A provisioned update key, an offer from an earlier maintenance check, and core's filed update.
  wp(['eval', `GQ_Support_Updater::provision( true );
    update_site_option( GQ_Support_Updater::OFFER_OPTION, array( 'checked_at' => time(), 'release_id' => 7, 'version' => '99.0.0',
      'sha256' => '${SHA256}', 'grant' => '${GRANT}', 'grant_expires' => time() + 900, 'auto_update' => true ) );
    $updates = new stdClass();
    $updates->last_checked = time() - 2 * HOUR_IN_SECONDS;
    $updates->checked = array( 'gq-support/gq-support.php' => GQ_SUPPORT_VERSION );
    $updates->response = array( 'gq-support/gq-support.php' => (object) GQ_Support_Updater::offer( false, get_plugin_data( GQ_SUPPORT_PLUGIN_FILE, false, false ), 'gq-support/gq-support.php' ) );
    $updates->no_update = array();
    $updates->translations = array();
    set_site_transient( 'update_plugins', $updates );`]);
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
  forgetLogIn();
});

test.afterAll(() => {
  rmSync(probe, { force: true });
  sync();
  wp(['eval', 'delete_site_option( GQ_Support_Updater::KEY_OPTION ); delete_site_option( GQ_Support_Updater::OFFER_OPTION ); delete_site_transient( "update_plugins" );']);
});

/** The plugin's outbound HTTP during one request, from gq-probe.php. */
const outbound = (headers: Record<string, string>) => JSON.parse(headers['x-gq-probe'] ?? 'null')?.http;

test('the Plugins and Updates screens show the approved release from cache, without asking the service', async ({ page }) => {
  await logIn(page);
  const plugins = await page.goto(`${site}/wp-admin/plugins.php?gq_probe=1`);
  expect(outbound(plugins!.headers())).toBe(0);
  const row = page.locator('tr.plugin-update-tr[data-plugin="gq-support/gq-support.php"]');
  await expect(row).toContainText('There is a new version of GETQUICK Support available.');
  await expect(row.getByRole('link', { name: 'Update GETQUICK Support now' })).toHaveAttribute('href', /action=upgrade-plugin&plugin=gq-support%2Fgq-support\.php/);
  // GETQUICK's authorization turns automatic updates on; the Client cannot be asked per update.
  await expect(page.locator('tr:not(.plugin-update-tr)[data-plugin="gq-support/gq-support.php"] .column-auto-updates')).toContainText('Auto-updates enabled');
  // The download grant never reaches a page.
  expect(await page.content()).not.toContain(GRANT);

  const updates = await page.goto(`${site}/wp-admin/update-core.php?gq_probe=1`);
  expect(outbound(updates!.headers())).toBe(0);
  await expect(page.locator('#update-plugins-table')).toContainText('GETQUICK Support');
});

test('"Check again" is a manual check: it asks the service, and an outage keeps the cached release', async ({ page }) => {
  // The Updates screen only re-checks plugins it has not checked within the last minute.
  wp(['eval', '$updates = get_site_transient( "update_plugins" ); $updates->last_checked = time() - 2 * HOUR_IN_SECONDS; set_site_transient( "update_plugins", $updates ); $offer = get_site_option( GQ_Support_Updater::OFFER_OPTION ); $offer["checked_at"] = time() - 2 * HOUR_IN_SECONDS; update_site_option( GQ_Support_Updater::OFFER_OPTION, $offer );']);
  await logIn(page);
  const checked = await page.goto(`${site}/wp-admin/update-core.php?force-check=1&gq_probe=1`);
  expect(outbound(checked!.headers())).toBe(1);
  await expect(page.locator('#update-plugins-table')).toContainText('GETQUICK Support');
  expect(JSON.parse(wp(['gq-support', 'update-status', '--format=json']))[0]).toMatchObject({ approved: '99.0.0', error: 'unavailable' });
});
