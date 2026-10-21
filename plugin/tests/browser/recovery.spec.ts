import { test, expect, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgetLogIn, logIn, sync, testSite } from '../performance/test-site.cjs';

// Outage and draft recovery (docs/research/outage-draft-recovery.md, tests 2-5, 7, 8 and 10), with
// the gq-support REST routes and the session check stubbed, and the page clock controlled.

const site = process.env.GQ_SUPPORT_TEST_URL ?? 'https://gq-support-lifecycle-testsite.ddev.site';
const wp = (args: string[]) => execFileSync('ddev', ['wp', '--path=.test-site', ...args], { encoding: 'utf8' });

// The Operator's independent contact, as wp-config.php would set it.
const constants = join(testSite, 'wp-content', 'mu-plugins', 'gq-support-help-test.php');
const help = 'mailto:help@example.test';

test.beforeAll(() => {
  writeFileSync(constants, `<?php\ndefine( 'GQ_SUPPORT_HELP_URL', '${help}' );\n`);
  sync();
  wp(['eval', "GQ_Support_State::update(array('connection' => 'connected')); get_role('administrator')->add_cap('gq_support_submit_requests');"]);
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
  forgetLogIn();
});
test.afterAll(() => {
  rmSync(constants, { force: true });
  sync();
  wp(['eval', "GQ_Support_State::update(array('connection' => 'not_connected'));"]);
});

type Payload = { submission_id: string; summary?: string; description: string; supersedes_id?: string };
type Reply = { status: number; body?: object; headers?: Record<string, string>; abort?: boolean };

const id = (n: number) => `req_01J8Z6Q4M1ZC7X0000000000${String(n).padStart(2, '0')}`;
const receipt = (payload: Payload, delivery: string, n = 1, status: string | null = null) => ({
  id: id(n), submission_id: payload.submission_id, title: payload.description, summary: null,
  description: payload.description, created_at: '2026-10-21T10:00:00Z', delivery, status, own: true,
});
const unknown: Reply = { status: 504, body: { code: 'gq_support_outcome_unknown', data: { status: 504, retryable: true } } };

/** Stubs creates with `reply`, recording each payload and nonce; list reads get an empty page. */
async function stubCreates(page: Page, reply: (attempt: number, payload: Payload) => Reply | Promise<Reply>) {
  const creates: Payload[] = [];
  const nonces: string[] = [];
  await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], next_cursor: null }) });
      return;
    }
    const payload = request.postDataJSON() as Payload;
    creates.push(payload);
    nonces.push(request.headers()['x-wp-nonce'] ?? '');
    const result = await reply(creates.length, payload);
    if (result.abort) { await route.abort('internetdisconnected'); return; }
    await route.fulfill({ status: result.status, headers: result.headers, contentType: 'application/json', body: JSON.stringify(result.body ?? {}) });
  });
  return { creates, nonces };
}

async function open(page: Page, draft = 'A private report') {
  await logIn(page);
  await page.goto(`${site}/wp-admin/`);
  await page.getByRole('button', { name: /^Support/ }).click();
  await expect(page.getByRole('button', { name: 'Send report' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Description' }).fill(draft);
}

/** The outcome shown in whichever tab is visible. */
const message = (page: Page) => page.locator('#gq-support-panel .gq-support-message:visible');
const send = (page: Page) => page.getByRole('button', { name: 'Send report' }).click();

test('a valid outcome-unknown receipt needs review and ends intake checks', async ({ page }) => {
  const { creates } = await stubCreates(page, (attempt, payload) => attempt === 1 ? unknown : { status: 202, body: receipt(payload, 'outcome-unknown') });
  await open(page);
  await page.clock.install();
  await send(page);
  await expect(message(page)).toHaveText('Checking…');
  await page.clock.runFor(1100);
  await expect(message(page)).toHaveText('Delivery needs review');
  await expect(page.getByRole('tab', { name: 'My requests' })).toHaveAttribute('aria-selected', 'true');
  await page.clock.runFor(60_000);
  expect(creates).toHaveLength(2);
  expect(creates[1]).toEqual(creates[0]);
  // Accepted intake: no new creation intent is offered for it.
  await page.getByRole('tab', { name: 'New report' }).click();
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Check again' })).toHaveCount(0);
});

test('an accepted receipt switches to My requests with the new request on top', async ({ page }) => {
  await stubCreates(page, (_attempt, payload) => ({ status: 202, body: receipt(payload, 'accepted-pending') }));
  await open(page);
  await send(page);
  await expect(message(page)).toHaveText('Received');
  const requests = page.getByRole('tabpanel', { name: 'My requests' });
  await expect(page.getByRole('tab', { name: 'My requests' })).toBeFocused();
  await expect(requests.getByRole('button', { name: /A private report/ })).toContainText('Received');
  await expect(requests).not.toContainText('No requests yet');
});

/** Answers session checks with `reply`, counting them. */
async function stubSession(page: Page, reply: (call: number) => object | 'abort') {
  let calls = 0;
  await page.route('**/admin-ajax.php?*', async (route) => {
    const result = reply(++calls);
    if (result === 'abort') await route.abort('internetdisconnected');
    else await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  return () => calls;
}

const contact = (page: Page) => page.locator('#gq-support-panel').getByRole('link', { name: 'help@example.test' });

test('a delivered outcome needs a valid acknowledged resource', async ({ page }) => {
  const { creates } = await stubCreates(page, (attempt, payload) => attempt === 1
    ? { status: 201, body: receipt(payload, 'delivered', 1, null) }
    : { status: 201, body: receipt(payload, 'delivered', 1, 'open') });
  await open(page);
  await page.clock.install();
  await send(page);
  await expect(message(page)).toHaveText('Checking…');
  await page.clock.runFor(1100);
  await expect(message(page)).toHaveText('Open');
  expect(creates[1]).toEqual(creates[0]);
});

test('a pending receipt ends intake checks and never ages into a failure', async ({ page }) => {
  const { creates } = await stubCreates(page, (_attempt, payload) => ({ status: 202, body: receipt(payload, 'accepted-pending') }));
  await open(page);
  await page.clock.install();
  await send(page);
  await expect(message(page)).toHaveText('Received');
  await expect(page.locator('#gq-support-panel')).toContainText('Delivery is pending');
  // Over a day with the tab open. runFor would call every page timer on the way, and on a slow runner
  // WooCommerce's 250 ms chart resize poll reschedules itself after install, onto this clock: 360,000
  // calls. Fast-forwarding still fires each due timer once and moves Date past a day.
  await page.clock.fastForward(25 * 60 * 60 * 1000);
  await expect(message(page)).toHaveText('Received');
  expect(creates).toHaveLength(1);
});

test('offline before dispatch keeps a copyable draft and sends nothing', async ({ page }) => {
  const { creates } = await stubCreates(page, () => unknown);
  await open(page);
  await stubSession(page, () => 'abort');
  await page.evaluate(() => {
    // A denied clipboard: the Reporter selects the text instead.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) } });
  });
  await send(page);
  // Unreachable is not an expired session: no reload advice, and Send stays available.
  await expect(message(page)).toContainText("Couldn't reach this site");
  await expect(page.locator('#gq-support-panel')).not.toContainText('Reload');
  await expect(page.getByRole('button', { name: 'Send report' })).toBeEnabled();
  expect(creates).toHaveLength(0);
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('A private report');
  await page.getByRole('button', { name: 'Copy draft' }).click();
  const manual = page.getByRole('textbox', { name: /Select this text and copy it/ });
  await expect(manual).toHaveValue('A private report');
  await expect(manual).toHaveAttribute('readonly', '');
  expect(await manual.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe('A private report');
});

test('going offline after Send keeps checking the same intent, then offers Check again', async ({ page }) => {
  let online = true;
  const { creates } = await stubCreates(page, (attempt, payload) => {
    if (attempt === 1) { online = false; return { status: 0, abort: true }; }
    return { status: 202, body: receipt(payload, 'accepted-pending') };
  });
  await open(page);
  const checks = await stubSession(page, (call) => online ? { state: 'current', nonce: `n${call}`, site: false } : 'abort');
  await page.clock.install();
  await send(page);
  await expect(message(page)).toHaveText('Checking…');
  // Each automatic check is charged even though its session precheck cannot reach the site.
  await page.clock.runFor(1_100);
  await page.clock.runFor(2_100);
  await page.clock.runFor(4_100);
  await expect.poll(checks).toBe(4);
  await page.clock.runFor(60_000);
  expect(checks()).toBe(4);
  expect(creates).toHaveLength(1);
  await expect(message(page)).toHaveText('Checking…');
  await expect(page.locator('#gq-support-panel')).not.toContainText('Reload');
  online = true;
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(message(page)).toHaveText('Received');
  expect(creates).toHaveLength(2);
  expect(creates[1]).toEqual(creates[0]);
});

test('a non-delivered receipt needs HTTP 202', async ({ page }) => {
  const { creates } = await stubCreates(page, (attempt, payload) => ({ status: attempt === 1 ? 200 : 202, body: receipt(payload, 'accepted-pending') }));
  await open(page);
  await page.clock.install();
  await send(page);
  await expect(message(page)).toHaveText('Checking…');
  await page.clock.runFor(1_100);
  await expect(message(page)).toHaveText('Received');
  expect(creates[1]).toEqual(creates[0]);
});

test('a send lost offline, or acknowledged and lost, reconciles under one key', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  const { creates } = await stubCreates(page, (attempt, payload) => attempt < 3 ? { status: 0, abort: true } : { status: 202, body: receipt(payload, 'accepted-pending') });
  // Non-hex letters, so a random hex token in a URL (the session hash, a nonce) can never match it.
  const marker = 'qzx4821';
  await open(page, `Report text ${marker}`);
  await page.getByRole('textbox', { name: 'Summary (optional)' }).fill(`Summary ${marker}`);
  await page.clock.install();
  await send(page);
  await expect(message(page)).toHaveText('Checking…');
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeDisabled();
  await page.clock.runFor(1100);
  await expect.poll(() => creates.length).toBe(2);
  await page.clock.runFor(2100);
  await expect(message(page)).toHaveText('Received');
  expect(creates).toHaveLength(3);
  expect(creates[1]).toEqual(creates[0]);
  expect(creates[2]).toEqual(creates[0]);
  // The frozen intent: the text, and the Report context reviewed for its Submission ID.
  expect(creates[0]).toEqual({ summary: `Summary ${marker}`, description: `Report text ${marker}`, submission_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    context: { schema: 1, default: expect.objectContaining({ originating_screen: 'dashboard' }) }, context_review: expect.stringMatching(/^v1\./) });
  // Report text travels only in request bodies, and nothing is kept in browser storage.
  expect(urls.filter((url) => decodeURIComponent(url).includes(marker))).toEqual([]);
  expect(await page.evaluate(() => [Object.values(localStorage), Object.values(sessionStorage), document.cookie].flat().join(' '))).not.toContain(marker);
});

test('a conflict after an uncertain send never recreates the report under a new key', async ({ page }) => {
  const { creates } = await stubCreates(page, (attempt, payload) => attempt === 1 ? unknown
    : attempt === 2 ? { status: 409, body: { code: 'gq_support_idempotency_conflict' } }
      : { status: 202, body: receipt(payload, 'accepted-pending') });
  await open(page);
  await page.clock.install();
  await send(page);
  await page.clock.runFor(1100);
  await expect(message(page)).toContainText("couldn't confirm");
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send report' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Copy draft' })).toBeVisible();
  await expect(contact(page)).toHaveAttribute('href', help);
  await page.clock.runFor(60_000);
  expect(creates).toHaveLength(2);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(message(page)).toHaveText('Received');
  expect(creates).toHaveLength(3);
  expect(creates[1]).toEqual(creates[0]);
  expect(creates[2]).toEqual(creates[0]);
});

test('Retry-After holds back a manual retry without a timer that sends', async ({ page }) => {
  const { creates } = await stubCreates(page, (attempt, payload) => attempt === 1
    ? { status: 429, headers: { 'Retry-After': '30' }, body: { code: 'gq_support_rate_limited' } }
    : { status: 202, body: receipt(payload, 'accepted-pending') });
  await open(page);
  await page.clock.install();
  await send(page);
  await expect(message(page)).toContainText('Too many requests');
  await page.clock.runFor(10_000);
  await send(page);
  await expect(message(page)).toHaveText('Try again in 20 seconds.');
  await page.clock.runFor(21_000);
  expect(creates).toHaveLength(1);
  await send(page);
  await expect(message(page)).toHaveText('Received');
  expect(creates).toHaveLength(2);
  expect(creates[1]).toEqual(creates[0]);
});

test('repeated clicks send one request', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { creates } = await stubCreates(page, async (_attempt, payload) => { await held; return { status: 202, body: receipt(payload, 'accepted-pending') }; });
  await open(page);
  await page.getByRole('button', { name: 'Send report' }).dblclick();
  await page.getByRole('button', { name: 'Send report' }).click({ force: true }).catch(() => {});
  await expect.poll(() => creates.length).toBe(1);
  release();
  await expect(message(page)).toHaveText('Received');
  expect(creates).toHaveLength(1);
});

test('an expired nonce in the same session needs an explicit retry with a fresh nonce', async ({ page }) => {
  const { creates, nonces } = await stubCreates(page, (attempt, payload) => attempt === 1
    ? { status: 403, body: { code: 'rest_cookie_invalid_nonce' } }
    : { status: 202, body: receipt(payload, 'accepted-pending') });
  await open(page);
  await stubSession(page, (call) => ({ state: 'current', nonce: `fresh-${call}`, site: false }));
  await page.clock.install();
  await send(page);
  await expect(message(page)).toContainText('session expired');
  await page.clock.runFor(15_000);
  expect(creates).toHaveLength(1);
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('A private report');
  await send(page);
  await expect(message(page)).toHaveText('Received');
  expect(creates).toHaveLength(2);
  expect(nonces[1]).toMatch(/^fresh-/);
  expect(nonces[1]).not.toBe(nonces[0]);
});

test('a changed session clears an uncertain draft and stops its checks', async ({ page }) => {
  let changed = false;
  const { creates } = await stubCreates(page, () => { changed = true; return unknown; });
  await open(page);
  await stubSession(page, () => changed ? { state: 'changed' } : { state: 'current', nonce: 'current', site: false });
  await page.clock.install();
  await send(page);
  await expect(message(page)).toHaveText('Checking…');
  await page.clock.runFor(1100);
  await expect(page.getByRole('alert')).toContainText('session');
  await expect(page.locator('#gq-support-description')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Copy draft' })).toHaveCount(0);
  await page.clock.runFor(60_000);
  expect(creates).toHaveLength(1);
});

test('support unavailable in an open tab offers the independent contact and no automatic retry', async ({ page }) => {
  const { creates } = await stubCreates(page, () => ({ status: 503, body: { code: 'gq_support_disabled', data: { status: 503, retryable: false } } }));
  await open(page);
  await page.clock.install();
  await send(page);
  await expect(message(page)).toHaveText('Support is temporarily disabled.');
  await expect(contact(page)).toHaveAttribute('href', help);
  await page.clock.runFor(60_000);
  expect(creates).toHaveLength(1);
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('A private report');
});

for (const panel of ['closed', 'open']) {
  test(`a back/forward cache return with the panel ${panel} shows no earlier draft`, async ({ page }) => {
    await stubCreates(page, () => unknown);
    await open(page);
    if (panel === 'closed') await page.getByRole('button', { name: 'Close support' }).click();
    // Leaving clears private memory before the page is frozen; nothing waits for a later task.
    const leftOver = await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      const fields = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea, input')).map((field) => field.value);
      return [document.body.innerText, ...fields].filter((text) => text.includes('A private report'));
    });
    expect(leftOver).toEqual([]);
    // Another account signed in from this tab's history before it returned.
    await stubSession(page, () => ({ state: 'changed' }));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.getByRole('button', { name: /^Support/ }).click();
    await expect(page.getByRole('dialog', { name: 'Support' })).toBeVisible();
    await expect(page.locator('#gq-support-description')).toHaveValue('');
    await expect(page.getByRole('alert')).toContainText('session');
    await expect(page.getByRole('dialog', { name: 'Support' })).toHaveCount(1);
  });
}

test('focus and visibility checks are coalesced, and a closed panel checks nothing', async ({ page }) => {
  await open(page);
  const checks = await stubSession(page, (call) => ({ state: 'current', nonce: `n${call}`, site: false }));
  await page.clock.install();
  // Opening checked moments ago: returning to the tab now adds nothing.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(5_100);
  expect(checks()).toBe(0);
  for (let i = 0; i < 5; i++) await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(checks).toBe(1);
  await page.clock.runFor(5_100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(checks).toBe(2);
  await page.getByRole('button', { name: 'Close support' }).click();
  await page.clock.runFor(10_000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(60_000);
  expect(checks()).toBe(2);
});

test('a hung app load stops after 10 seconds, offers the contact, and a late load mounts nothing', async ({ page }) => {
  await logIn(page);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let loads = 0;
  await page.route(/gq-support\/assets\/dist\/index\.js/, async (route) => {
    loads++;
    await held;
    await route.continue();
  });
  await page.clock.install();
  await page.goto(`${site}/wp-admin/`);
  // An installed clock keeps real time, so time spent between the click and runFor would count toward
  // the 10 seconds. Paused (a second ahead, so never in the past), only runFor moves it.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  const launcher = page.getByRole('button', { name: /^Support/ });
  await launcher.click();
  await expect.poll(() => loads).toBe(1);
  await page.clock.runFor(9_900);
  await expect(page.locator('.gq-support-launcher-status')).not.toContainText('Press to retry');
  await page.clock.runFor(200);
  await expect(page.locator('.gq-support-launcher-status')).toContainText('Press to retry');
  await expect(page.locator('#gq-support-root').getByRole('link', { name: 'help@example.test' })).toHaveAttribute('href', help);
  // The abandoned attempt completes late: it neither mounts nor reports success.
  const late = page.waitForResponse(/gq-support\/assets\/dist\/index\.js/);
  release();
  await late;
  await page.clock.runFor(1_000);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.gq-support-launcher-status')).toContainText('Press to retry');
  // An explicit retry reuses the loaded script and mounts once.
  await launcher.click();
  await expect(page.getByRole('dialog', { name: 'Support' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.locator('script[src*="gq-support/assets/dist/index.js"]')).toHaveCount(1);
  expect(loads).toBe(1);
});
