import { test, expect, type Request } from '@playwright/test';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { forgetLogIn, logIn, probe, probeSource, site, sync, testSite, wp } from '../performance/test-site.cjs';

// The local support fail-safe (docs/research/outage-draft-recovery.md, test 11). An mu-plugin sets the
// Operator's wp-config.php constants; gq-probe.php counts the plugin's outbound HTTP per request and
// points the service at a fake Worker, so nothing can leave the machine.

const constants = join(testSite, 'wp-content', 'mu-plugins', 'gq-support-fail-safe-test.php');
const help = 'https://help.example.test/support';
const helpLabel = 'GETQUICK help desk';
const pluginOwned = (request: Request) => /\/plugins\/gq-support\/|gq-support\/v1|rest_route=%2Fgq-support|fake-worker\.gq-support\.test|action=gq_support/.test(request.url());

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  mkdirSync(dirname(probe), { recursive: true });
  copyFileSync(probeSource, probe);
  writeFileSync(constants, `<?php\ndefine( 'GQ_SUPPORT_DISABLED', true );\ndefine( 'GQ_SUPPORT_HELP_URL', '${help}' );\ndefine( 'GQ_SUPPORT_HELP_LABEL', '${helpLabel}' );\n`);
  sync();
  wp(['eval', "GQ_Support_State::update(array('connection' => 'connected')); get_role('administrator')->add_cap('gq_support_submit_requests'); get_role('administrator')->add_cap('gq_support_manage_settings');"]);
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
  forgetLogIn();
});

test.afterAll(() => {
  rmSync(constants, { force: true });
  rmSync(probe, { force: true });
  sync();
  wp(['eval', "GQ_Support_State::update(array('connection' => 'not_connected'));"]);
});

/** The plugin's outbound HTTP during one request, from gq-probe.php. */
const outbound = (headers: Record<string, string>) => JSON.parse(headers['x-gq-probe'] ?? 'null')?.http;

test('a disabled installation sends no support assets and shows the independent contact', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (pluginOwned(request)) requests.push(request.url()); });
  await logIn(page);
  const response = await page.goto(`${site}/wp-admin/?gq_probe=1`);
  expect(outbound(response!.headers())).toBe(0);
  await expect(page.locator('#wpadminbar')).toBeVisible();
  await expect(page.locator('#gq-support-root, #gq-support-app-assets')).toHaveCount(0);
  const notice = page.locator('.gq-support-disabled');
  await expect(notice).toContainText('Support is temporarily disabled');
  // Exactly the configured contact: no report text, identity or prefill is added.
  await expect(notice.getByRole('link', { name: helpLabel })).toHaveAttribute('href', help);
  expect(requests).toEqual([]);

  // Ordinary admin and public pages keep working.
  await page.goto(`${site}/wp-admin/edit.php`);
  await expect(page.locator('#wpadminbar')).toBeVisible();
  const home = await page.request.get(`${site}/?gq_probe=1`);
  expect(home.ok()).toBe(true);
  expect(outbound(home.headers())).toBe(0);
  expect(requests).toEqual([]);
});

test('the setup page explains the fail-safe and offers no service action', async ({ page }) => {
  await logIn(page);
  const response = await page.goto(`${site}/wp-admin/options-general.php?page=gq-support&gq_probe=1`);
  expect(outbound(response!.headers())).toBe(0);
  const wrap = page.locator('.wrap');
  await expect(wrap).toContainText('Temporarily disabled');
  await expect(wrap).toContainText('GQ_SUPPORT_DISABLED');
  await expect(wrap.getByRole('link', { name: helpLabel })).toHaveAttribute('href', help);
  for (const action of ['Connect', 'Test connection', 'Disconnect', 'Refresh erasure status']) {
    await expect(wrap.getByRole('button', { name: action })).toHaveCount(0);
  }
  expect(wp(['option', 'pluck', 'gq_support_state', 'connection'])).toBe('connected');
});
