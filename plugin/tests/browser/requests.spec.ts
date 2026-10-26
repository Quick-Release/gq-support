import { test, expect, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { forgetLogIn, logIn } from '../performance/test-site.cjs';

// The My requests projection (#26), with the gq-support REST routes stubbed. The service-side
// scope checks are covered by worker/test and plugin/tests/contract.

const site = process.env.GQ_SUPPORT_TEST_URL ?? 'https://gq-support-lifecycle-testsite.ddev.site';
const wp = (args: string[]) => execFileSync('ddev', ['wp', '--path=.test-site', ...args], { encoding: 'utf8' }).trim();
const grantSite = (granted: boolean) => wp(['eval', `get_role('administrator')->${granted ? 'add_cap' : 'remove_cap'}('gq_support_view_site_requests');`]);

test.beforeAll(() => {
  wp(['eval', "GQ_Support_State::update(array('connection' => 'connected')); get_role('administrator')->add_cap('gq_support_submit_requests');"]);
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
  forgetLogIn();
  grantSite(false);
});
test.afterAll(() => {
  grantSite(false);
  wp(['eval', "GQ_Support_State::update(array('connection' => 'not_connected'));"]);
});

type Resource = { id: string; submission_id: string; title: string; summary: string | null; description: string; created_at: string; delivery: string; status: string | null; own: boolean };
let sequence = 0;
const resource = (fields: Partial<Resource> = {}): Resource => {
  sequence++;
  return {
    id: `req_01J8Z6Q4M1ZC7X0000000000${String(sequence).padStart(2, '0')}`,
    submission_id: `3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c${String(sequence).padStart(2, '0')}`,
    title: `Request ${sequence}`, summary: null, description: `Description ${sequence}`,
    created_at: '2026-09-28T10:00:00Z', delivery: 'delivered', status: 'open', own: true, ...fields,
  };
};

type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
/** Stubs list reads, recording each query. Creates get an accepted-pending receipt. */
async function stubReads(page: Page, reply: (call: number, query: URLSearchParams) => Reply) {
  const reads: URLSearchParams[] = [];
  await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async (route: Route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const payload = request.postDataJSON();
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify(resource({
        submission_id: payload.submission_id, title: payload.description, description: payload.description, delivery: 'accepted-pending', status: null,
      })) });
      return;
    }
    const query = new URL(request.url()).searchParams;
    reads.push(query);
    const result = await reply(reads.length, query);
    await route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
  });
  return reads;
}

const page1 = (items: Resource[], next: string | null = null) => ({ status: 200, body: { items, next_cursor: next } });

async function openPanel(page: Page) {
  await page.goto(`${site}/wp-admin/`);
  await page.getByRole('button', { name: /^Support/ }).click();
  await expect(page.getByRole('button', { name: 'Send report' })).toBeEnabled();
}

/** Return to the tab once the five seconds within which a return does not recheck the session have passed. */
async function returnToTab(page: Page) {
  await page.clock.install();
  await page.clock.runFor(5_100);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

const requestsPanel = (page: Page) => page.getByRole('tabpanel', { name: 'My requests' });
const showRequests = (page: Page) => page.getByRole('tab', { name: 'My requests' }).click();

test('one report moves from a pending receipt to readable text, close and reopen through explicit refresh', async ({ page }) => {
  const description = 'Checkout <b>fails</b>\nPlease keep this as plain text.';
  const summary = 'Checkout needs help';
  let item = { ...resource({ title: summary, summary, description, delivery: 'accepted-pending', status: null }),
    status_change: null as { change_id: string; status: string; delivery: string } | null };
  let accepted = false;
  let providerStatus = 'open';
  const writes: Record<string, string>[] = [];
  await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const sent = request.postDataJSON();
      writes.push(sent);
      if (decodeURIComponent(request.url()).includes('/status')) {
        providerStatus = sent.status;
        item = { ...item, status_change: { change_id: sent.change_id, status: sent.status, delivery: 'accepted-pending' } };
      } else {
        accepted = true;
        item = { ...item, submission_id: sent.submission_id, summary: sent.summary, title: sent.summary, description: sent.description };
      }
      await route.fulfill({ status: 202, json: item });
    } else {
      await route.fulfill({ json: { items: accepted ? [item] : [], next_cursor: null } });
    }
  });
  await logIn(page);
  await openPanel(page);
  await page.getByRole('textbox', { name: 'Summary' }).fill(summary);
  await page.getByRole('textbox', { name: 'Description' }).fill(description);
  await page.getByRole('button', { name: 'Send report' }).click();
  const panel = requestsPanel(page);
  await expect(page.getByRole('tab', { name: 'My requests' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('status').filter({ hasText: 'Received' })).toBeVisible();
  const toggle = panel.getByRole('button', { name: new RegExp(summary) });
  await expect(toggle).toContainText('Received');
  await toggle.click();
  await expect(panel.getByText(description, { exact: true })).toBeVisible();
  await expect(panel.locator('.gq-support-item-text b')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^(Close|Reopen) request$/ })).toHaveCount(0);

  // The controlled provider completes delivery. Nothing changes until Refresh.
  const refresh = async () => {
    item = { ...item, delivery: 'delivered', status: providerStatus,
      status_change: item.status_change ? { ...item.status_change, delivery: 'delivered' } : null };
    await panel.getByRole('button', { name: 'Refresh' }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Requests updated' })).toBeVisible();
  };
  await expect(toggle).toContainText('Received');
  await refresh();
  await expect(toggle).toContainText('Open');
  for (const [action, pending, status] of [
    ['Close request', 'Close requested. Delivery is pending.', 'Closed'],
    ['Reopen request', 'Reopen requested. Delivery is pending.', 'Open'],
  ]) {
    await panel.getByRole('button', { name: action }).click();
    await expect(panel).toContainText(pending);
    await refresh();
    await expect(toggle).toContainText(status);
    await expect(panel.getByText(description, { exact: true })).toBeVisible();
  }
  expect(writes).toHaveLength(3);
  expect(writes[0]).toMatchObject({ summary, description, submission_id: expect.any(String) });
  expect(writes.slice(1).map(write => write.status)).toEqual(['closed', 'open']);
  await expect(panel.getByRole('textbox')).toHaveCount(0); // No client comment composer.
});

test('Submitted text keeps HTML, script and malicious Markdown inert', async ({ page }) => {
  const title = '<img src=x onerror="window.supportInjected=true">';
  const description = '<script>window.supportInjected=true</script> [open](javascript:alert(1)) ![image](https://attacker.example/track)';
  const unexpected: string[] = [];
  page.on('request', request => {
    if (request.url().includes('attacker.example')) unexpected.push(request.url());
  });
  await stubReads(page, () => page1([resource({ title, summary: title, description })]));
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  const panel = requestsPanel(page);
  await panel.getByRole('button', { name: new RegExp('window.supportInjected=true') }).click();
  await expect(panel.getByText(description, { exact: true })).toBeVisible();
  await expect(panel.locator('script, img, a')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'supportInjected'))).toBeUndefined();
  expect(unexpected).toEqual([]);
});

test('New report makes no read; My requests lists own requests that expand in place', async ({ page }) => {
  const reads = await stubReads(page, () => page1([
    resource({ title: 'Checkout button does nothing', summary: 'Checkout button does nothing', description: 'Clicking <b>Checkout</b> does nothing.' }),
    resource({ title: 'Pending one', delivery: 'accepted-pending', status: null }),
    resource({ title: 'Closed one', status: 'closed' }),
    resource({ title: 'Failed one', delivery: 'failed', status: null }),
    resource({ title: 'Unknown one', delivery: 'outcome-unknown', status: null }),
  ]));
  await logIn(page);
  await openPanel(page);
  expect(reads).toHaveLength(0);
  await showRequests(page);
  const panel = requestsPanel(page);
  const first = panel.getByRole('button', { name: /Checkout button does nothing/ });
  await expect(first).toContainText('Open');
  await expect(panel.getByRole('button', { name: /Pending one/ })).toContainText('Received');
  await expect(panel.getByRole('button', { name: /Closed one/ })).toContainText('Closed');
  await expect(panel.getByRole('button', { name: /Failed one/ })).toContainText('Not sent');
  await expect(panel.getByRole('button', { name: /Unknown one/ })).toContainText('Delivery needs review');
  expect(reads).toHaveLength(1);
  expect(Object.fromEntries(reads[0])).toMatchObject({ scope: 'mine', per_page: '20' });

  // Expands in place, as plain text; no separate detail view or read.
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.getByText('Clicking <b>Checkout</b> does nothing.')).toBeHidden();
  const url = page.url();
  await first.click();
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.getByText('Clicking <b>Checkout</b> does nothing.')).toBeVisible();
  await panel.getByRole('button', { name: /Pending one/ }).click();
  await expect(panel.getByText('Delivery is pending')).toBeVisible();
  expect(page.url()).toBe(url);
  expect(reads).toHaveLength(1);
});

test('loading, then the empty state links to New report', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await stubReads(page, async () => { await held; return page1([]); });
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  await expect(requestsPanel(page).getByRole('status')).toContainText('Loading');
  release();
  await expect(requestsPanel(page)).toContainText('No requests yet');
  await requestsPanel(page).getByRole('button', { name: 'New report' }).click();
  await expect(page.getByRole('tab', { name: 'New report' })).toHaveAttribute('aria-selected', 'true');
});

test('a read failure is never an empty list, and Refresh recovers', async ({ page }) => {
  const reads = await stubReads(page, call => call === 1
    ? { status: 503, body: { code: 'gq_support_unavailable', data: { status: 503 } } }
    : page1([resource({ title: 'Recovered' })]));
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  await expect(requestsPanel(page).getByRole('alert')).toContainText("Couldn't load. Refresh to try again.");
  await expect(requestsPanel(page)).not.toContainText('No requests yet');
  await requestsPanel(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(requestsPanel(page).getByRole('button', { name: /Recovered/ })).toBeVisible();
  await expect(requestsPanel(page).getByRole('alert')).toHaveCount(0);
  expect(reads).toHaveLength(2);
});

test('a failed refresh keeps the last-known list and says it could not load', async ({ page }) => {
  await stubReads(page, call => call === 1 ? page1([resource({ title: 'Known' })]) : { status: 504, body: '{malformed' });
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  await expect(requestsPanel(page).getByRole('button', { name: /Known/ })).toContainText('Open');
  await requestsPanel(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(requestsPanel(page).getByRole('alert')).toContainText("Couldn't load");
  await expect(requestsPanel(page).getByRole('button', { name: /Known/ })).toBeVisible();
});

test('a direct GitHub state change appears on manual refresh, never by polling', async ({ page }) => {
  const id = resource().id;
  const reads = await stubReads(page, call => page1([resource({ id, title: 'Status changes', status: call === 1 ? 'open' : 'closed' })]));
  await page.clock.install();
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  const item = requestsPanel(page).getByRole('button', { name: /Status changes/ });
  await expect(item).toContainText('Open');
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(15 * 60_000);
  // Closing and reopening the panel does not refetch either.
  await page.getByRole('button', { name: 'Close support' }).click();
  await page.getByRole('button', { name: /^Support/ }).click();
  await showRequests(page);
  await page.clock.runFor(60_000);
  expect(reads).toHaveLength(1);
  await expect(item).toContainText('Open');
  await requestsPanel(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(item).toContainText('Closed');
  await expect(requestsPanel(page).getByRole('status')).toContainText('Requests updated');
  expect(reads).toHaveLength(2);
});

for (const [status, code, message] of [
  [403, 'gq_support_forbidden', 'session expired'],
  [401, 'rest_not_logged_in', 'session expired'],
  [429, 'gq_support_rate_limited', 'Too many requests'],
  [503, 'gq_support_not_configured', 'Support is unavailable'],
] as const) {
  test(`a denied read (${status} ${code}) shows no requests and no empty state`, async ({ page }) => {
    await stubReads(page, () => ({ status, body: { code, data: { status } } }));
    await logIn(page);
    await openPanel(page);
    await showRequests(page);
    await expect(requestsPanel(page).getByRole('alert')).toContainText(message);
    await expect(requestsPanel(page)).not.toContainText('No requests yet');
    await expect(requestsPanel(page).getByRole('listitem')).toHaveCount(0);
  });
}

test('a malformed list response is an error, not an empty list', async ({ page }) => {
  await stubReads(page, () => ({ status: 200, body: { items: 'nope' } }));
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  await expect(requestsPanel(page).getByRole('alert')).toContainText("Couldn't load");
  await expect(requestsPanel(page)).not.toContainText('No requests yet');
});

test('Show more follows the opaque cursor and appends the next page', async ({ page }) => {
  const reads = await stubReads(page, call => call === 1
    ? page1([resource({ title: 'Newest' })], 'opaque-cursor')
    : page1([resource({ title: 'Older' })]));
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  await requestsPanel(page).getByRole('button', { name: 'Show more' }).click();
  await expect(requestsPanel(page).getByRole('button', { name: /Older/ })).toBeVisible();
  await expect(requestsPanel(page).getByRole('button', { name: /Newest/ })).toBeVisible();
  await expect(requestsPanel(page).getByRole('button', { name: 'Show more' })).toHaveCount(0);
  expect(Object.fromEntries(reads[1])).toMatchObject({ scope: 'mine', cursor: 'opaque-cursor' });
});

test('an accepted report joins a loaded list from its receipt, without another read', async ({ page }) => {
  const reads = await stubReads(page, () => page1([resource({ title: 'Earlier report' })]));
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  await expect(requestsPanel(page).getByRole('button', { name: /Earlier report/ })).toBeVisible();
  await page.getByRole('tab', { name: 'New report' }).click();
  await page.getByRole('textbox', { name: 'Description' }).fill('A brand new report');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status').first()).toContainText('Received');
  await showRequests(page);
  const items = requestsPanel(page).getByRole('listitem');
  await expect(items.first()).toContainText('A brand new report');
  await expect(items.first()).toContainText('Received');
  await expect(items).toHaveCount(2);
  expect(reads).toHaveLength(1);
});

test('a receipt accepted while the first page loads is not lost when that page arrives', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const reads = await stubReads(page, async () => { await held; return page1([resource({ title: 'Earlier report' })]); });
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  await expect(requestsPanel(page).getByRole('status')).toContainText('Loading');
  await page.getByRole('tab', { name: 'New report' }).click();
  await page.getByRole('textbox', { name: 'Description' }).fill('Sent during the load');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('dialog').getByRole('status').first()).toContainText('Received');
  release();
  await showRequests(page);
  const items = requestsPanel(page).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('Sent during the load');
  expect(reads).toHaveLength(1);
});

test('without an explicit grant there is no site scope', async ({ page }) => {
  const reads = await stubReads(page, () => page1([resource()]));
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  await expect(requestsPanel(page).getByRole('listitem')).toHaveCount(1);
  await expect(requestsPanel(page).getByRole('combobox', { name: 'Show' })).toHaveCount(0);
  expect(reads.map(query => query.get('scope'))).toEqual(['mine']);
});

test('a Support manager reads the installation scope only while explicitly granted', async ({ page }) => {
  grantSite(true);
  try {
    const reads = await stubReads(page, (_call, query) => page1(query.get('scope') === 'site'
      ? [resource({ title: 'Another Reporter request', own: false }), resource({ title: 'My own request' })]
      : [resource({ title: 'My own request' })]));
    await logIn(page);
    await openPanel(page);
    await showRequests(page);
    await expect(requestsPanel(page).getByRole('listitem')).toHaveCount(1);
    // Every item in My requests is the Reporter's own, so nothing marks it.
    await expect(requestsPanel(page).getByText('Yours', { exact: true })).toHaveCount(0);
    await requestsPanel(page).getByRole('combobox', { name: 'Show' }).selectOption({ label: 'All requests on this site' });
    await expect(requestsPanel(page).getByRole('button', { name: /Another Reporter request/ })).toBeVisible();
    await expect(requestsPanel(page).getByRole('button', { name: /My own request/ })).toContainText('Yours');
    await expect(requestsPanel(page).getByRole('button', { name: /Another Reporter request/ })).not.toContainText('Yours');
    expect(reads.map(query => query.get('scope'))).toEqual(['mine', 'site']);

    // A revoked grant drops the installation-wide projection at the next session check.
    grantSite(false);
    await returnToTab(page);
    await expect(requestsPanel(page).getByRole('combobox', { name: 'Show' })).toHaveCount(0);
    await expect(requestsPanel(page).getByText('Another Reporter request')).toHaveCount(0);
    expect(reads.slice(2).map(query => query.get('scope'))).not.toContain('site');
  } finally {
    grantSite(false);
  }
});

test('a changed session clears the last-known projection', async ({ page }) => {
  await stubReads(page, () => page1([resource({ title: 'Private request' })]));
  await logIn(page);
  await openPanel(page);
  await showRequests(page);
  await expect(requestsPanel(page).getByRole('button', { name: /Private request/ })).toBeVisible();
  await page.context().clearCookies();
  await page.request.post(`${site}/wp-login.php`, { form: { log: 'editor', pwd: 'editor' } });
  await returnToTab(page);
  await expect(requestsPanel(page).getByText('Private request')).toHaveCount(0);
  await expect(requestsPanel(page).getByRole('button', { name: 'Refresh' })).toBeDisabled();
});
