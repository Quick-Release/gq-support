import { test, expect, type Page } from '@playwright/test';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { forgetLogIn, logIn, probe, probeSource, site, sync, wp } from '../performance/test-site.cjs';

// The cached release policy at the installed plugin (#141, ADR 0021). gq-probe.php counts the plugin's
// outbound HTTP per request and points the service at a fake Worker, so nothing can leave the machine.

test.describe.configure({ mode: 'serial' });

/** Caches the service's policy for this plugin version, as an explicit connection test would. */
const cache = (intake: 'open' | 'closed', reason: string, compatibleUntil: string | null = null) => wp(['eval',
  `GQ_Support_Release::learn(array('enforcement' => 'enforced', 'intake' => '${intake}', 'reason' => '${reason}', 'plugin_version' => GQ_SUPPORT_VERSION, 'approved_version' => '9.9.9', 'compatible_until' => ${compatibleUntil === null ? 'null' : `'${compatibleUntil}'`}));`]);

test.beforeAll(() => {
  mkdirSync(dirname(probe), { recursive: true });
  copyFileSync(probeSource, probe);
  sync();
  wp(['eval', "GQ_Support_State::update(array('connection' => 'connected')); get_role('administrator')->add_cap('gq_support_submit_requests');"]);
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
  forgetLogIn();
});

test.afterAll(() => {
  rmSync(probe, { force: true });
  sync();
  wp(['eval', "GQ_Support_State::update(array('connection' => 'not_connected', 'release' => null));"]);
});

/** The plugin's outbound HTTP during one request, from gq-probe.php. */
const outbound = (headers: Record<string, string>) => JSON.parse(headers['x-gq-probe'] ?? 'null')?.http;

async function open(page: Page) {
  const reads: string[] = [];
  // My requests reads an empty list; any create would be recorded.
  await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async (route) => {
    reads.push(route.request().method());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], next_cursor: null }) });
  });
  await logIn(page);
  const response = await page.goto(`${site}/wp-admin/?gq_probe=1`);
  // The policy comes from the cache: rendering never asks the service.
  expect(outbound(response!.headers())).toBe(0);
  await page.getByRole('button', { name: /^Support/ }).click();
  return reads;
}

test('an outdated plugin pauses new reports from its cached policy, and keeps My requests', async ({ page }) => {
  // The previous release's window ended while nobody asked the service.
  cache('open', 'previous', new Date(Date.now() - 1000).toISOString());
  const reads = await open(page);
  const panel = page.locator('#gq-support-new');
  await expect(panel.locator('.gq-support-outdated').getByRole('status')).toContainText('Support needs a plugin update.');
  await expect(page.getByRole('button', { name: 'Send report' })).toBeDisabled();
  await page.getByRole('tab', { name: 'My requests' }).click();
  await expect(page.locator('#gq-support-requests')).toBeVisible();
  await expect.poll(() => reads).toEqual(['GET']);
});

test('the approved release, or a policy not yet learned, takes new reports', async ({ page }) => {
  for (const learned of [() => cache('open', 'current'), () => wp(['eval', "GQ_Support_State::update(array('release' => null));"])]) {
    learned();
    await open(page);
    await page.getByRole('textbox', { name: 'Description' }).fill('A private report');
    await expect(page.getByRole('button', { name: 'Send report' })).toBeEnabled();
    await expect(page.locator('#gq-support-new')).not.toContainText('Support needs a plugin update.');
  }
});
