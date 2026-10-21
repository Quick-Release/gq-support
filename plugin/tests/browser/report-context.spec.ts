import { test, expect, type Page, type Request } from '@playwright/test';
import { forgetLogIn, logIn, site, wp } from '../performance/test-site.cjs';

// Report context in the panel (docs/support-context-design.md, acceptance cases 1, 2, 6, 7 and 9).
// The WordPress preview is real; only the support REST routes are stubbed.

const PLUGIN_VERSION = wp(['eval', 'echo GQ_SUPPORT_VERSION;']);
const WP_VERSION = wp(['eval', 'echo get_bloginfo( "version" );']);

test.beforeAll(() => {
  wp(['eval', "GQ_Support_State::update(array('connection' => 'connected')); get_role('administrator')->add_cap('gq_support_submit_requests');"]);
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
  // The block editor's welcome guide is a core modal that correctly covers the launcher; keep it closed.
  wp(['eval', "update_user_option(get_user_by('login', 'admin')->ID, 'persisted_preferences', array('core/edit-post' => array('welcomeGuide' => false), '_modified' => gmdate('c')));"]);
  forgetLogIn();
});
test.afterAll(() => wp(['eval', "GQ_Support_State::update(array('connection' => 'not_connected'));"]));

type Payload = { submission_id: string; context?: { schema: number; default: Record<string, string> }; context_review?: string };
const accepted = (payload: Payload) => ({ status: 202, body: { id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id: payload.submission_id, delivery: 'accepted-pending', status: null } });

/** Stubs creates and records each payload; lists read empty. */
async function intercept(page: Page, reply: (attempt: number, payload: Payload) => { status: number; body: object } = (_, payload) => accepted(payload)) {
  const submissions: Payload[] = [];
  await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async route => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], next_cursor: null }) });
      return;
    }
    const payload = route.request().postDataJSON() as Payload;
    submissions.push(payload);
    const result = reply(submissions.length, payload);
    await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
  return submissions;
}

const isPreview = (request: Request) => /admin-ajax\.php/.test(request.url()) && /action=gq_support_context/.test(request.postData() ?? '');

/** Every context preview the page asks for, as its form fields. */
function previews(page: Page) {
  const asked: URLSearchParams[] = [];
  page.on('request', request => { if (isPreview(request)) asked.push(new URLSearchParams(request.postData() ?? '')); });
  return asked;
}

async function open(page: Page, path = 'index.php') {
  await logIn(page);
  await page.goto(`${site}/wp-admin/${path}`);
  await page.getByRole('button', { name: /^Support/ }).click();
  await page.getByRole('textbox', { name: 'Description' }).fill('A private report');
}

const message = (page: Page) => page.locator('#gq-support-panel .gq-support-message:visible');

test('a launcher on a nonce-bearing editor URL keeps only the coarse screen, which is previewed and sent exactly', async ({ page }) => {
  const post = wp(['post', 'create', '--post_title=Context', '--post_status=draft', '--porcelain']);
  // Support traffic: its REST routes and AJAX actions. (The test site's own hostname contains "gq-support".)
  const traffic: string[] = [];
  page.on('request', request => {
    const line = `${request.url()} ${request.postData() ?? ''}`;
    if (/gq-support\/v1|rest_route=%2Fgq-support|action=gq_support/.test(line)) traffic.push(line);
  });
  const asked = previews(page);
  const submissions = await intercept(page);
  await logIn(page);
  await page.goto(`${site}/wp-admin/post.php?post=${post}&action=edit&_wpnonce=secret&token=secret#customer`);
  const bootstrap = await page.evaluate(() => JSON.stringify(window.gqSupportLauncher));
  expect(JSON.parse(bootstrap).screen).toBe('post-editor');
  expect(bootstrap).not.toMatch(/secret|customer|post\.php|_wpnonce/);
  // Nothing is collected while the panel is closed.
  expect(asked).toHaveLength(0);
  await page.getByRole('button', { name: /^Support/ }).click();
  await page.getByRole('textbox', { name: 'Description' }).fill('A private report');
  await expect(page.getByRole('checkbox', { name: `Screen you opened support from: post-editor` })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: `WordPress version: ${WP_VERSION}` })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: `Support plugin version: ${PLUGIN_VERSION}` })).toBeChecked();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText('Received');
  // The sent draft's preview; the next draft has its own Submission ID.
  expect(asked[0]!.get('screen')).toBe('post-editor');
  expect(asked[0]!.get('submission_id')).toBe(submissions[0]!.submission_id);
  expect(submissions[0]!.context).toEqual({ schema: 1, default: { wp_version: WP_VERSION, support_plugin_version: PLUGIN_VERSION, originating_screen: 'post-editor' } });
  expect(submissions[0]!.context_review).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  // The URL's credentials, query, path and fragment never left the browser in support traffic.
  expect(traffic.length).toBeGreaterThanOrEqual(2);
  for (const line of traffic) expect(line).not.toMatch(/secret|customer|token=|post\.php/);
  wp(['post', 'delete', post, '--force']);
});

test('the Reporter removes values one at a time or all at once, and exactly the selected set is sent', async ({ page }) => {
  const submissions = await intercept(page);
  await open(page);
  const version = page.getByRole('checkbox', { name: `WordPress version: ${WP_VERSION}` });
  await version.uncheck();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText('Received');
  expect(submissions[0]!.context).toEqual({ schema: 1, default: { support_plugin_version: PLUGIN_VERSION, originating_screen: 'dashboard' } });

  // A new report starts with every value included; Remove all sends none, and no envelope.
  await page.getByRole('tab', { name: 'New report' }).click();
  await page.getByRole('textbox', { name: 'Description' }).fill('A second report');
  await expect(version).toBeChecked();
  await page.getByRole('button', { name: 'Remove all' }).click();
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText('Received');
  expect(submissions[1]).not.toHaveProperty('context');
  expect(submissions[1]).not.toHaveProperty('context_review');
  expect(submissions[1]!.submission_id).not.toBe(submissions[0]!.submission_id);
});

test('a failed collection offers to send without optional information', async ({ page }) => {
  await page.route('**/admin-ajax.php', async route => {
    if (isPreview(route.request())) await route.fulfill({ status: 500, body: 'Private server error' });
    else await route.fallback();
  });
  const submissions = await intercept(page);
  await open(page);
  await expect(page.getByRole('status').filter({ hasText: 'Some information could not be collected.' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send without optional information' }).click();
  await expect(message(page)).toContainText('Received');
  expect(submissions[0]).not.toHaveProperty('context');
});

test('retries resend the frozen context and envelope, without collecting again', async ({ page }) => {
  const asked = previews(page);
  const submissions = await intercept(page, (attempt, payload) => attempt < 3
    ? { status: 504, body: { code: 'gq_support_outcome_unknown', data: { status: 504, retryable: true } } }
    : accepted(payload));
  await open(page);
  await page.getByRole('checkbox', { name: /^Screen you opened support from/ }).uncheck();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText('Received', { timeout: 15000 });
  expect(submissions).toHaveLength(3);
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[2]).toEqual(submissions[0]);
  expect(submissions[0]!.context!.default).not.toHaveProperty('originating_screen');
  // One preview for the sent draft, one for the next draft's new Submission ID.
  expect(asked.map(fields => fields.get('submission_id'))).toEqual([submissions[0]!.submission_id, expect.not.stringMatching(submissions[0]!.submission_id)]);
});

test('a late preview for a new Submission ID cannot restore a removed value', async ({ page }) => {
  const submissions = await intercept(page, (attempt, payload) => attempt === 1
    ? { status: 409, body: { code: 'gq_support_idempotency_conflict' } }
    : accepted(payload));
  await open(page);
  await page.getByRole('checkbox', { name: /^Screen you opened support from/ }).uncheck();
  // The conflict spends the key; delay the new key's preview.
  await page.route('**/admin-ajax.php', async route => {
    if (isPreview(route.request())) await new Promise(resolve => setTimeout(resolve, 1000));
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText('Not sent');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(message(page)).toContainText('Received');
  expect(submissions[1]!.submission_id).not.toBe(submissions[0]!.submission_id);
  expect(submissions[1]!.context!.default).toEqual({ wp_version: WP_VERSION, support_plugin_version: PLUGIN_VERSION });
  expect(submissions[1]!.context_review).not.toBe(submissions[0]!.context_review);
});

test('changing the selection after a send that was not accepted sends a new intent with exactly the new selection', async ({ page }) => {
  const asked = previews(page);
  const submissions = await intercept(page, (attempt, payload) => attempt === 1
    ? { status: 503, body: { code: 'gq_support_not_accepted', data: { status: 503, retryable: true } } }
    : accepted(payload));
  await open(page);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText('Not sent');
  await page.getByRole('checkbox', { name: /^WordPress version/ }).uncheck();
  await expect.poll(() => asked.length).toBe(2);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText('Received');
  expect(submissions[1]!.submission_id).not.toBe(submissions[0]!.submission_id);
  expect(asked[1]!.get('submission_id')).toBe(submissions[1]!.submission_id);
  expect(submissions[1]!.context!.default).toEqual({ support_plugin_version: PLUGIN_VERSION, originating_screen: 'dashboard' });
});

test('a frozen intent sent without optional information shows no values on reopening', async ({ page }) => {
  const asked = previews(page);
  const failing = async (route: import('@playwright/test').Route) => {
    if (isPreview(route.request())) await route.fulfill({ status: 500, body: '' });
    else await route.fallback();
  };
  await page.route('**/admin-ajax.php', failing);
  const submissions = await intercept(page, (attempt, payload) => attempt === 1
    ? { status: 503, body: { code: 'gq_support_not_accepted', data: { status: 503, retryable: true } } }
    : accepted(payload));
  await open(page);
  await page.getByRole('button', { name: 'Send without optional information' }).click();
  await expect(message(page)).toContainText('Not sent');
  // Collection would work now, but the frozen intent carries no context.
  await page.unroute('**/admin-ajax.php', failing);
  await page.getByRole('button', { name: 'Close support' }).click();
  await page.getByRole('button', { name: /^Support/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Some information could not be collected.' })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(message(page)).toContainText('Received');
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[1]).not.toHaveProperty('context');
  // No preview for the frozen Submission ID after the failed one; the next draft has its own.
  expect(asked.filter(fields => fields.get('submission_id') === submissions[0]!.submission_id)).toHaveLength(1);
});

test('an uncertain send whose review then expires keeps its frozen intent and asks the Reporter to check', async ({ page }) => {
  const asked = previews(page);
  const submissions = await intercept(page, attempt => attempt === 1
    ? { status: 504, body: { code: 'gq_support_outcome_unknown', data: { status: 504, retryable: true } } }
    : { status: 412, body: { code: 'gq_support_context_expired', data: { status: 412, retryable: false } } });
  await open(page);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText("couldn't confirm", { timeout: 5000 });
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /^WordPress version/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => submissions.length).toBe(3);
  // Never a new Submission ID, a new review or changed context for an intent that may have arrived.
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[2]).toEqual(submissions[0]);
  expect(asked).toHaveLength(1);
});

test('an expired review is collected again for the same Submission ID before the report is sent', async ({ page }) => {
  const asked = previews(page);
  const submissions = await intercept(page, (attempt, payload) => attempt === 1
    ? { status: 412, body: { code: 'gq_support_context_expired', data: { status: 412, retryable: false } } }
    : accepted(payload));
  await open(page);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText('needs checking again');
  await expect.poll(() => asked.length).toBe(2);
  expect(asked[1]!.get('submission_id')).toBe(submissions[0]!.submission_id);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(message(page)).toContainText('Received');
  expect(submissions[1]!.submission_id).toBe(submissions[0]!.submission_id);
  expect(submissions[1]!.context).toEqual(submissions[0]!.context);
});

test('the preview is private and no-store, and tells an unauthenticated caller nothing', async ({ page }) => {
  await logIn(page);
  await page.goto(`${site}/wp-admin/index.php`);
  const binding = await page.evaluate(() => window.gqSupportLauncher);
  const { nonce } = await (await page.request.get(`${binding.ajaxUrl}?action=gq_support_session&session=${binding.session}`)).json();
  const form = { action: 'gq_support_context', session: binding.session, nonce, submission_id: '3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11', screen: 'dashboard' };
  const current = await page.request.post(binding.ajaxUrl, { form });
  expect(current.headers()['cache-control']).toMatch(/private/);
  expect(current.headers()['cache-control']).toMatch(/no-store/);
  expect(await current.json()).toMatchObject({ state: 'current', context: { schema: 1, default: { originating_screen: 'dashboard' } } });
  for (const forged of [{ session: 'another-session' }, { nonce: 'forged' }]) {
    const refused = await page.request.post(binding.ajaxUrl, { form: { ...form, ...forged } });
    expect(refused.headers()['cache-control']).toMatch(/no-store/);
    expect(JSON.stringify(await refused.json())).not.toMatch(/version|dashboard|v1\./);
  }
  await page.context().clearCookies();
  const anonymous = await page.request.post(binding.ajaxUrl, { form });
  expect(await anonymous.text()).not.toMatch(/version|dashboard|v1\./);
});

test('a closed panel asks for no context, and reopening asks again only after a failure', async ({ page }) => {
  const asked = previews(page);
  await logIn(page);
  await page.goto(`${site}/wp-admin/index.php`);
  await page.waitForLoadState('networkidle');
  expect(asked).toHaveLength(0);
  const launcher = page.getByRole('button', { name: /^Support/ });
  await launcher.click();
  await expect(page.getByRole('checkbox', { name: /^WordPress version/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await launcher.click();
  await expect(page.getByRole('checkbox', { name: /^WordPress version/ })).toBeVisible();
  expect(asked).toHaveLength(1);
});
