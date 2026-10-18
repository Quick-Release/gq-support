import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { forgetLogIn, logIn } from '../performance/test-site.cjs';

const site = process.env.GQ_SUPPORT_TEST_URL ?? 'https://gq-support-lifecycle-testsite.ddev.site';
const wp = (args: string[]) => execFileSync('ddev', ['wp', '--path=.test-site', ...args], { encoding: 'utf8' });

test.beforeAll(() => {
  wp(['eval', "GQ_Support_State::update(array('connection' => 'connected')); get_role('administrator')->add_cap('gq_support_submit_requests');"]);
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
  forgetLogIn();
});
test.afterAll(() => wp(['eval', "GQ_Support_State::update(array('connection' => 'not_connected'));"]));

async function open(page: Page) {
  await logIn(page);
  await page.goto(`${site}/wp-admin/`);
  await page.getByRole('button', { name: /^Support/ }).click();
  await expect(page.getByRole('button', { name: 'Send report' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Description' }).fill('A private report');
}

async function intercept(page: Page, reply: (attempt: number, payload: Record<string, string>) => { status: number; body: object }) {
  const submissions: Record<string, string>[] = [];
  await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async route => {
    const payload = route.request().postDataJSON();
    submissions.push(payload);
    const result = reply(submissions.length, payload);
    await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
  return submissions;
}

const unknown = { status: 504, body: { code: 'gq_support_outcome_unknown', data: { status: 504, retryable: true } } };

test('ambiguous writes reconcile three times with the same key, then require Check again', async ({ page }) => {
  const submissions = await intercept(page, () => unknown);
  await open(page);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Checking');
  await expect.poll(() => submissions.length, { timeout: 15000 }).toBe(4);
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
  expect(new Set(submissions.map(item => item.submission_id)).size).toBe(1);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => submissions.length).toBe(5);
});

for (const outcome of ['conflict', 'failed', 'not accepted']) {
  test(`retry after ${outcome} uses the correct Submission ID`, async ({ page }) => {
    const submissions = await intercept(page, (attempt, payload) => attempt === 1
      ? outcome === 'failed'
        ? { status: 202, body: { id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id: payload.submission_id, delivery: 'failed', status: null } }
        : { status: outcome === 'conflict' ? 409 : 503, body: { code: outcome === 'conflict' ? 'gq_support_idempotency_conflict' : 'gq_support_not_accepted' } }
      : { status: 202, body: { id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id: payload.submission_id, delivery: 'accepted-pending', status: null } });
    await open(page);
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('Not sent');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('Received');
    expect(submissions).toHaveLength(2);
    expect(submissions[1].supersedes_id).toBe(outcome === 'failed' ? 'req_01J8Z6Q4M1ZC7X000000000000' : undefined);
    expect(submissions[0].submission_id === submissions[1].submission_id).toBe(outcome === 'not accepted');
    await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  });
}

test('a rate limit never retries automatically', async ({ page }) => {
  const submissions = await intercept(page, () => ({ status: 429, body: { code: 'gq_support_rate_limited' } }));
  await open(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Too many requests');
  await page.clock.runFor(15000);
  expect(submissions).toHaveLength(1);
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('A private report');
});

test('closing the panel stops reconciliation and preserves its draft', async ({ page }) => {
  const submissions = await intercept(page, () => unknown);
  await open(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Checking');
  await page.getByRole('button', { name: 'Close support' }).click();
  await page.clock.runFor(15000);
  expect(submissions).toHaveLength(1);
  await expect(page.locator('#gq-support-description')).toHaveValue('A private report');
});

test('a delivered report clears the draft, and a new draft gets a new key', async ({ page }) => {
  const submissions = await intercept(page, (_attempt, payload) => ({ status: 201, body: { id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id: payload.submission_id, delivery: 'delivered', status: 'open' } }));
  await open(page);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Open');
  await page.getByRole('textbox', { name: 'Description' }).fill('Another draft');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[0].submission_id).not.toBe(submissions[1].submission_id);
});

test('an expired REST nonce never replays a write after reauthentication', async ({ page }) => {
  const submissions = await intercept(page, () => ({ status: 403, body: { code: 'rest_cookie_invalid_nonce' } }));
  await open(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('session expired');
  await page.clock.runFor(15000);
  expect(submissions).toHaveLength(1);
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('A private report');
});

test('reconciliation honors Retry-After', async ({ page }) => {
  const submissions: string[] = [];
  await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async route => {
    submissions.push(route.request().postDataJSON().submission_id);
    await route.fulfill({ status: 504, headers: { 'Retry-After': '30' }, contentType: 'application/json', body: JSON.stringify(unknown.body) });
  });
  await open(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Checking');
  await page.clock.runFor(29000);
  expect(submissions).toHaveLength(1);
  await page.clock.runFor(1100);
  await expect.poll(() => submissions.length).toBe(2);
  expect(new Set(submissions).size).toBe(1);
});

for (const status of [429, 401, 403]) {
  test(`malformed HTTP ${status} never automatically retries a write`, async ({ page }) => {
    let submissions = 0;
    await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async route => {
      submissions++;
      await route.fulfill({ status, contentType: 'application/json', body: '{malformed' });
    });
    await open(page);
    await page.clock.install();
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText(status === 429 ? 'Too many requests' : 'session expired');
    await page.clock.runFor(15000);
    expect(submissions).toBe(1);
  });
}

test('a failed session check preserves an unresolved intent until explicit reconciliation', async ({ page }) => {
  let currentSession = true;
  const submissions = await intercept(page, (attempt, payload) => {
    if (attempt === 1) { currentSession = false; return unknown; }
    return { status: 202, body: { id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id: payload.submission_id, delivery: 'accepted-pending', status: null } };
  });
  await open(page);
  await page.clock.install();
  await page.route('**/admin-ajax.php?*', async route => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(currentSession ? { state: 'current', nonce: 'test-nonce' } : { state: 'paused' }) });
  });
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Checking');
  await page.clock.runFor(1100);
  await expect(page.getByRole('alert')).toContainText('session');
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('A private report');
  currentSession = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await page.clock.runFor(15000);
  expect(submissions).toHaveLength(1);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Received');
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
});

test('reconciling an already closed request shows its current support status', async ({ page }) => {
  await intercept(page, (_attempt, payload) => ({ status: 201, body: { id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id: payload.submission_id, delivery: 'delivered', status: 'closed' } }));
  await open(page);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Closed');
});

for (const rejection of [429, 403]) {
  test(`HTTP ${rejection} during reconciliation preserves the original unresolved intent`, async ({ page }) => {
    const submissions = await intercept(page, (attempt, payload) => attempt === 1 ? unknown : attempt === 2
      ? { status: rejection, body: { code: rejection === 429 ? 'gq_support_rate_limited' : 'rest_cookie_invalid_nonce' } }
      : { status: 202, body: { id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id: payload.submission_id, delivery: 'accepted-pending', status: null } });
    await open(page);
    await page.clock.install();
    await page.getByRole('button', { name: 'Send report' }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('Checking');
    await page.clock.runFor(1100);
    await expect(page.getByRole('dialog').getByRole('status')).toContainText(rejection === 429 ? 'Too many requests' : 'session expired');
    await expect(page.getByRole('textbox', { name: 'Description' })).toBeDisabled();
    await page.clock.runFor(15000);
    expect(submissions).toHaveLength(2);
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('Received');
    expect(submissions).toHaveLength(3);
    expect(submissions[2]).toEqual(submissions[0]);
  });
}

test('sending preserves the draft until a durable receipt arrives', async ({ page }) => {
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async route => {
    const { submission_id } = route.request().postDataJSON();
    await pending;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({
      id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id, delivery: 'accepted-pending', status: null,
    }) });
  });
  await open(page);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Sending…');
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('A private report');
  await expect(page.getByRole('button', { name: 'Send report' })).toBeDisabled();
  release();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Received');
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('');
});

test('an uncertain replacement keeps its predecessor and frozen draft on reconciliation', async ({ page }) => {
  const submissions = await intercept(page, (attempt, payload) => attempt === 1
    ? { status: 202, body: { id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id: payload.submission_id, delivery: 'failed', status: null } }
    : attempt === 2 ? unknown
      : { status: 202, body: { id: 'req_01J8Z6Q4M1ZC7X000000000001', submission_id: payload.submission_id, delivery: 'accepted-pending', status: null } });
  await open(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Not sent');
  await page.getByRole('textbox', { name: 'Description' }).fill('A corrected report <plain text>');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Checking…');
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('A corrected report <plain text>');
  await page.clock.runFor(1100);
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Received');
  expect(submissions[1].supersedes_id).toBe('req_01J8Z6Q4M1ZC7X000000000000');
  expect(submissions[1].submission_id).not.toBe(submissions[0].submission_id);
  expect(submissions[2]).toEqual(submissions[1]);
});

test('a failed reconciliation does not turn an unknown original send into Not sent', async ({ page }) => {
  const submissions = await intercept(page, (attempt, payload) => attempt === 1 ? unknown : attempt === 2
    ? { status: 503, body: { code: 'gq_support_not_accepted' } }
    : { status: 202, body: { id: 'req_01J8Z6Q4M1ZC7X000000000000', submission_id: payload.submission_id, delivery: 'accepted-pending', status: null } });
  await open(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Checking…');
  await page.clock.runFor(1100);
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Checking…');
  await expect(page.getByRole('textbox', { name: 'Description' })).toBeDisabled();
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Received');
  expect(submissions[2]).toEqual(submissions[0]);
});
