import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { submitLogIn } from '../performance/test-site.cjs';

const site = process.env.GQ_SUPPORT_TEST_URL ?? 'https://gq-support-lifecycle-testsite.ddev.site';
const wp = (args: string[]) => execFileSync('ddev', ['wp', '--path=.test-site', ...args], { encoding: 'utf8' }).trim();

test.beforeAll(() => {
  wp(['eval', "GQ_Support_State::update(array('connection' => 'connected')); get_role('administrator')->add_cap('gq_support_submit_requests');"]);
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
});
test.afterAll(() => wp(['eval', "GQ_Support_State::update(array('connection' => 'not_connected'));"]));

for (const change of ['different account', 'new login session', 'revoked grant']) {
  test(`draft is protected after ${change}`, async ({ page }) => {
    await submitLogIn(page, 'admin', 'launcher-test-password');
    await page.goto(`${site}/wp-admin/`);
    await page.getByRole('button', { name: /^Support/ }).click();
    const description = page.getByRole('textbox', { name: 'Description' });
    await description.fill('<script>A private draft</script>');
    if (change === 'revoked grant') {
      wp(['eval', "get_role('administrator')->remove_cap('gq_support_submit_requests');"]);
    } else {
      await page.context().clearCookies();
      await page.request.post(`${site}/wp-login.php`, { form: {
        log: change === 'different account' ? 'editor' : 'admin',
        pwd: change === 'different account' ? 'editor' : 'launcher-test-password',
      } });
    }
    try {
      // Simulates returning to the draft tab after authentication changed elsewhere, after the
      // five seconds within which a return does not check the session again.
      await page.clock.install();
      await page.clock.runFor(5_100);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('alert')).toContainText('session');
      await expect(page.getByRole('button', { name: 'Send report' })).toBeDisabled();
      await expect(description).toHaveValue(change === 'revoked grant' ? '<script>A private draft</script>' : '');
      expect(await page.evaluate(() => [Object.values(localStorage), Object.values(sessionStorage)].flat().join(' '))).not.toContain('A private draft');
    } finally {
      wp(['eval', "get_role('administrator')->add_cap('gq_support_submit_requests');"]);
    }
  });
}

test('REST requires cookie plus nonce and sends private no-store errors', async ({ page }) => {
  await submitLogIn(page, 'admin', 'launcher-test-password');
  await page.goto(`${site}/wp-admin/`);
  const binding = await page.evaluate(() => window.gqSupportLauncher);
  const refreshed = await page.request.get(`${binding.ajaxUrl}?action=gq_support_session&session=${binding.session}`);
  const session = await refreshed.json();
  expect(session.state).toBe('current');
  expect(session.nonce).toBeTruthy();
  // No Support manager scope without an explicit view-site grant.
  expect(session.site).toBe(false);
  const endpoint = `${site}/?rest_route=/gq-support/v1/requests`;
  for (const headers of [{}, { 'X-WP-Nonce': 'expired' }]) {
    const response = await page.request.get(endpoint, { headers });
    expect([401, 403]).toContain(response.status());
    expect(response.headers()['cache-control']).toContain('private');
    expect(response.headers()['cache-control']).toContain('no-store');
  }
  wp(['eval', "GQ_Support_State::update(array('connection' => 'not_connected'));"]);
  try {
    const response = await page.request.get(endpoint, { headers: { 'X-WP-Nonce': session.nonce } });
    expect(response.status()).toBe(503);
    expect((await response.json()).code).toBe('gq_support_not_configured');
    expect(response.headers()['cache-control']).toContain('private');
    expect(response.headers()['cache-control']).toContain('no-store');
    const mismatch = await page.request.get(`${binding.ajaxUrl}?action=gq_support_session&session=another-session`);
    expect(await mismatch.json()).toEqual({ state: 'changed' });
  } finally {
    wp(['eval', "GQ_Support_State::update(array('connection' => 'connected'));"]);
  }
});
