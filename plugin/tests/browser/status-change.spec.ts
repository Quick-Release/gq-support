import { test, expect, type Page, type Route } from '@playwright/test';
import { wp, forgetLogIn, logIn } from '../performance/test-site.cjs';

// Reporter close and reopen (#28, ADR 0020), with the gq-support REST routes stubbed. Ordering,
// idempotency and provider delivery are covered by worker/test/status-changes.test.ts; the
// WordPress route, scope and error mapping by plugin/tests/contract.

const site = process.env.GQ_SUPPORT_TEST_URL ?? 'https://gq-support-lifecycle-testsite.ddev.site';
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

type Change = { change_id: string; status: 'open' | 'closed'; delivery: string };
type Resource = { id: string; submission_id: string; title: string; summary: string | null; description: string; created_at: string;
  delivery: string; status: string | null; status_change: Change | null; own: boolean };
let sequence = 0;
const resource = (fields: Partial<Resource> = {}): Resource => {
  sequence++;
  return {
    id: `req_01J8Z6Q4M1ZC7X0000000001${String(sequence).padStart(2, '0')}`,
    submission_id: `3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c${String(sequence).padStart(2, '0')}`,
    title: `Request ${sequence}`, summary: null, description: `Description ${sequence}`,
    created_at: '2026-09-28T10:00:00Z', delivery: 'delivered', status: 'open', status_change: null, own: true, ...fields,
  };
};

type Reply = { status: number; body: unknown };
type Sent = { id: string; change_id: string; status: 'open' | 'closed' };
/**
 * Stubs list reads and status changes. By default a change is accepted and pending; `change`
 * may answer otherwise, given the change and its number.
 */
async function stub(page: Page, list: (call: number) => Resource[], change?: (sent: Sent, call: number, item: Resource) => Reply | undefined) {
  const reads: URLSearchParams[] = [];
  const changes: Sent[] = [];
  const current = new Map<string, Resource>();
  await page.route(/(?:rest_route=.*gq-support|wp-json\/gq-support)/, async (route: Route) => {
    const request = route.request();
    const url = decodeURIComponent(request.url());
    const path = /\/gq-support\/v1\/requests\/(req_[0-9A-Z]+)\/status/.exec(url);
    if (request.method() === 'POST' && path) {
      const sent = { id: path[1]!, ...request.postDataJSON() } as Sent;
      changes.push(sent);
      const item = current.get(sent.id)!;
      const reply = change?.(sent, changes.length, item) ?? {
        status: 202, body: { ...item, status_change: { change_id: sent.change_id, status: sent.status, delivery: 'accepted-pending' } },
      };
      await route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
      return;
    }
    reads.push(new URL(request.url()).searchParams);
    const items = list(reads.length);
    for (const item of items) current.set(item.id, item);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, next_cursor: null }) });
  });
  return { reads, changes };
}

const panel = (page: Page) => page.getByRole('tabpanel', { name: 'My requests' });
async function showRequests(page: Page) {
  await logIn(page);
  await page.goto(`${site}/wp-admin/`);
  await page.getByRole('button', { name: /^Support/ }).click();
  await expect(page.getByRole('button', { name: 'Send report' })).toBeEnabled();
  await page.getByRole('tab', { name: 'My requests' }).click();
}
const expand = async (page: Page, title: string) => {
  const toggle = panel(page).getByRole('button', { name: new RegExp(title) });
  await toggle.click();
  return toggle;
};
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

test('a Reporter closes their own request: delivery is shown apart from the status, which only refresh changes', async ({ page }) => {
  const id = resource().id;
  const changeIds: string[] = [];
  const { reads, changes } = await stub(page, call => [resource({ id, title: 'Checkout fails',
    status: call === 1 ? 'open' : call === 2 ? 'closed' : 'open',
    status_change: call === 1 ? null : { change_id: changeIds[0]!, status: 'closed', delivery: 'delivered' } })],
  sent => { changeIds.push(sent.change_id); return undefined; });
  await showRequests(page);
  const toggle = await expand(page, 'Checkout fails');
  await panel(page).getByRole('button', { name: 'Close request' }).click();
  await expect(panel(page)).toContainText('Close requested. Delivery is pending.');
  // GitHub has not changed yet: the badge stays Open, and no second action is offered meanwhile.
  await expect(toggle).toContainText('Open');
  await expect(panel(page).getByRole('button', { name: /^(Close|Reopen) request$/ })).toHaveCount(0);
  expect(changes).toEqual([{ id, change_id: expect.stringMatching(UUID4), status: 'closed' }]);
  expect(reads).toHaveLength(1);

  await panel(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(toggle).toContainText('Closed');
  await expect(panel(page)).not.toContainText('Delivery is pending');
  await expect(panel(page).getByRole('button', { name: 'Reopen request' })).toBeVisible();

  // A Developer reopens it in GitHub: the next refresh shows Open, with no competing status.
  await panel(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(toggle).toContainText('Open');
  await expect(panel(page).getByRole('button', { name: 'Close request' })).toBeVisible();
  expect(changes).toHaveLength(1);
});

test('an uncertain change is checked again under its own Change ID, never sent as a new one', async ({ page }) => {
  const { changes } = await stub(page, () => [resource({ title: 'Uncertain', status: 'closed' })], (sent, call, item) => call === 1
    ? { status: 504, body: { code: 'gq_support_outcome_unknown', data: { status: 504, change_id: sent.change_id } } }
    : { status: 200, body: { ...item, status: 'open', status_change: { change_id: sent.change_id, status: sent.status, delivery: 'delivered' } } });
  await showRequests(page);
  const toggle = await expand(page, 'Uncertain');
  await panel(page).getByRole('button', { name: 'Reopen request' }).click();
  await expect(panel(page)).toContainText("We couldn't confirm this status change.");
  await expect(panel(page).getByRole('button', { name: 'Reopen request' })).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Check again' }).click();
  await expect(toggle).toContainText('Open');
  await expect(panel(page).getByRole('button', { name: 'Check again' })).toHaveCount(0);
  expect(changes).toHaveLength(2);
  expect(changes[1]).toEqual(changes[0]);
  expect(changes[0]!.status).toBe('open');
});

for (const [status, code, message] of [
  [409, 'gq_support_change_pending', 'An earlier status change for this request is still being delivered.'],
  [409, 'gq_support_change_not_allowed', "This request's status can't be changed yet."],
  [404, 'gq_support_not_found', 'This request is no longer available.'],
  [403, 'gq_support_forbidden', 'Your session expired. Reload the page to continue.'],
  [429, 'gq_support_rate_limited', 'Too many requests, try again later.'],
] as const) {
  test(`a refused change (${status} ${code}) is shown honestly and spends its key`, async ({ page }) => {
    const { changes } = await stub(page, () => [resource({ title: 'Refused' })], (_sent, call) => call === 1
      ? { status, body: { code, data: { status } } } : undefined);
    await showRequests(page);
    const toggle = await expand(page, 'Refused');
    await panel(page).getByRole('button', { name: 'Close request' }).click();
    await expect(panel(page)).toContainText(message);
    await expect(toggle).toContainText('Open');
    await panel(page).getByRole('button', { name: 'Close request' }).click();
    await expect(panel(page)).toContainText('Close requested. Delivery is pending.');
    expect(changes).toHaveLength(2);
    expect(changes[1]!.change_id).not.toBe(changes[0]!.change_id);
  });
}

test('a service that did not record the change is tried again under the same key', async ({ page }) => {
  const { changes } = await stub(page, () => [resource({ title: 'Not accepted' })], (_sent, call) => call === 1
    ? { status: 503, body: { code: 'gq_support_not_accepted', data: { status: 503 } } } : undefined);
  await showRequests(page);
  await expand(page, 'Not accepted');
  await panel(page).getByRole('button', { name: 'Close request' }).click();
  await expect(panel(page)).toContainText("Your close request wasn't sent. Try again.");
  await panel(page).getByRole('button', { name: 'Check again' }).click();
  await expect(panel(page)).toContainText('Close requested. Delivery is pending.');
  expect(changes[1]).toEqual(changes[0]);
});

test('a malformed reply is uncertain, not a success', async ({ page }) => {
  await stub(page, () => [resource({ title: 'Malformed' })], (sent, _call, item) => ({ status: 202,
    body: { ...item, status_change: { change_id: crypto.randomUUID(), status: sent.status, delivery: 'accepted-pending' } } }));
  await showRequests(page);
  await expand(page, 'Malformed');
  await panel(page).getByRole('button', { name: 'Close request' }).click();
  await expect(panel(page)).toContainText("We couldn't confirm this status change.");
  await expect(panel(page)).not.toContainText('Delivery is pending');
});

test("the service's pending, failed and unknown change outcomes are shown, with no action while one is unresolved", async ({ page }) => {
  const change = (status: Change['status'], delivery: string): Change => ({ change_id: crypto.randomUUID(), status, delivery });
  await stub(page, () => [
    resource({ title: 'Pending close', status_change: change('closed', 'accepted-pending') }),
    resource({ title: 'Unknown reopen', status: 'closed', status_change: change('open', 'outcome-unknown') }),
    resource({ title: 'Undelivered close', status_change: change('closed', 'failed') }),
    resource({ title: 'Closed in GitHub anyway', status: 'closed', status_change: change('closed', 'failed') }),
    resource({ title: 'Not delivered yet', delivery: 'accepted-pending', status: null }),
  ]);
  await showRequests(page);
  const item = (title: string) => panel(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: false }) });
  await expand(page, 'Pending close');
  await expect(item('Pending close')).toContainText('Close requested. Delivery is pending.');
  await expect(item('Pending close').getByRole('button', { name: 'Close request' })).toHaveCount(0);
  await expand(page, 'Unknown reopen');
  await expect(item('Unknown reopen')).toContainText('Our team is checking whether your reopen request arrived.');
  await expect(item('Unknown reopen').getByRole('button', { name: 'Reopen request' })).toHaveCount(0);
  await expand(page, 'Undelivered close');
  await expect(item('Undelivered close')).toContainText("Your close request couldn't be confirmed. You can try again.");
  await expect(item('Undelivered close').getByRole('button', { name: 'Close request' })).toBeVisible();
  // GitHub already shows the requested status: nothing to report.
  await expand(page, 'Closed in GitHub anyway');
  await expect(item('Closed in GitHub anyway')).not.toContainText("couldn't be confirmed");
  await expect(item('Closed in GitHub anyway').getByRole('button', { name: 'Reopen request' })).toBeVisible();
  await expand(page, 'Not delivered yet');
  await expect(item('Not delivered yet').getByRole('button', { name: /request$/ })).toHaveCount(0);
});

test('a Support manager closes another Reporter\'s request in the installation scope', async ({ page }) => {
  grantSite(true);
  try {
    const { reads, changes } = await stub(page, call => call === 1 ? [resource({ title: 'My own request' })]
      : [resource({ title: 'Another Reporter request', own: false })]);
    await showRequests(page);
    await panel(page).getByRole('combobox', { name: 'Show' }).selectOption({ label: 'All requests on this site' });
    await expand(page, 'Another Reporter request');
    await panel(page).getByRole('button', { name: 'Close request' }).click();
    await expect(panel(page)).toContainText('Close requested. Delivery is pending.');
    expect(reads.map(query => query.get('scope'))).toEqual(['mine', 'site']);
    expect(changes).toHaveLength(1);
  } finally {
    grantSite(false);
  }
});

test('a changed session sends no change and clears the projection', async ({ page }) => {
  const { changes } = await stub(page, () => [resource({ title: 'Private request' })]);
  await showRequests(page);
  await expand(page, 'Private request');
  await page.context().clearCookies();
  await panel(page).getByRole('button', { name: 'Close request' }).click();
  await expect(panel(page).getByText('Private request')).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Refresh' })).toBeDisabled();
  expect(changes).toHaveLength(0);
});
