#!/usr/bin/env node
// Q4: is T4's heap growth a retained-tree leak? Run from the repository root against the DDEV
// test site that plugin/tests/integration/run.sh leaves, after `pnpm build:app`:
//   node docs/research/idle-performance-budgets/heap-cycles.mjs
// It prints three JSON lines:
//   curve     Heap, DOM node and listener growth after 0, 10, 50, 100 and 200 cycles, three runs
//             each, with My requests shown and hidden.
//   snapshot  A heap snapshot diff over 200 cycles after the first 50, by node type and name.
//   idle      The counts of the snapshot's suspect nodes again after an 11 s idle.
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';

const { adminPassword, logIn, site, wp } = createRequire(import.meta.url)('../../../plugin/tests/performance/test-site.cjs');

const items = Array.from({ length: 20 }, (_, i) => ({
  id: `req_01J8Z6Q4M1ZC7X0000000000${String(i).padStart(2, '0')}`, title: `Request ${i}`, summary: null,
  description: 'Steps to reproduce. '.repeat(20), created_at: '2026-10-01T10:00:00Z', delivery: 'delivered', status: 'open', status_change: null, own: true,
}));

/** A dashboard with the list stubbed, and one open, My requests (when shown) and close cycle. */
async function dashboard(browser, storageState, showList) {
  const context = await browser.newContext({ storageState, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.route(/gq-support\/v1\/requests/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, next_cursor: null }) }));
  await page.goto(`${site}/wp-admin/index.php`);
  await page.waitForLoadState('networkidle');
  const cycle = async () => {
    await page.locator('.gq-support-launcher').click();
    await page.locator('#gq-support-description:focus').waitFor();
    if (showList) {
      await page.getByRole('tab', { name: 'My requests' }).click();
      await page.getByRole('tabpanel', { name: 'My requests' }).getByRole('listitem').nth(items.length - 1).waitFor();
    }
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Support' }).waitFor({ state: 'hidden' });
  };
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const gc = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
  };
  return { context, page, cdp, cycle, gc };
}

async function curve(browser, storageState, showList) {
  const { context, cdp, cycle, gc } = await dashboard(browser, storageState, showList);
  await cycle();
  const measure = async () => {
    await gc();
    const { metrics } = await cdp.send('Performance.getMetrics');
    const dom = await cdp.send('Memory.getDOMCounters');
    return { heap: metrics.find(({ name }) => name === 'JSHeapUsedSize').value, nodes: dom.nodes, listeners: dom.jsEventListeners };
  };
  const start = await measure();
  const rows = [];
  let done = 0;
  for (const cycles of [0, 10, 50, 100, 200]) {
    for (; done < cycles; done++) await cycle();
    const now = await measure();
    rows.push({ cycles, heapKB: Math.round((now.heap - start.heap) / 102.4) / 10, nodes: now.nodes - start.nodes, listeners: now.listeners - start.listeners });
  }
  await context.close();
  return rows;
}

/** Self size and count per node type and name; strings are pooled. */
async function snapshot(cdp, gc) {
  await gc();
  const chunks = [];
  const collect = ({ chunk }) => chunks.push(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', collect);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', collect);
  const { snapshot: { meta }, nodes, strings } = JSON.parse(chunks.join(''));
  const fields = meta.node_fields;
  const [type, name, size, detachedness] = ['type', 'name', 'self_size', 'detachedness'].map((field) => fields.indexOf(field));
  const groups = {};
  let detached = 0;
  for (let i = 0; i < nodes.length; i += fields.length) {
    const kind = meta.node_types[0][nodes[i + type]];
    const key = `${kind}:${kind.includes('string') ? '(string)' : strings[nodes[i + name]].slice(0, 60)}`;
    groups[key] ??= { count: 0, size: 0 };
    groups[key].count++;
    groups[key].size += nodes[i + size];
    if (detachedness >= 0 && nodes[i + detachedness] === 2) detached++;
  }
  return { groups, detached };
}

const state = wp(['eval', "echo wp_json_encode( get_option( 'gq_support_state', null ) );"]);
wp(['eval', "GQ_Support_State::update( array( 'connection' => 'connected' ) );"]);
wp(['user', 'update', 'admin', `--user_pass=${adminPassword}`]);
const browser = await chromium.launch();
try {
  const login = await browser.newContext({ ignoreHTTPSErrors: true });
  await logIn(await login.newPage());
  const storageState = await login.storageState();
  await login.close();

  const runs = { shown: [], hidden: [] };
  for (let run = 0; run < 3; run++) {
    runs.shown.push(await curve(browser, storageState, true));
    runs.hidden.push(await curve(browser, storageState, false));
  }
  console.log(JSON.stringify({ curve: runs }));

  const { context, page, cdp, cycle, gc } = await dashboard(browser, storageState, true);
  for (let i = 0; i < 50; i++) await cycle();
  const before = await snapshot(cdp, gc);
  for (let i = 0; i < 200; i++) await cycle();
  const after = await snapshot(cdp, gc);
  const count = (taken, key) => taken.groups[key] ?? { count: 0, size: 0 };
  const diff = [...new Set([...Object.keys(before.groups), ...Object.keys(after.groups)])]
    .map((key) => ({ key, count: count(after, key).count - count(before, key).count, size: count(after, key).size - count(before, key).size }))
    .filter(({ size }) => size)
    .sort((a, b) => b.size - a.size);
  console.log(JSON.stringify({ snapshot: { detached: [before.detached, after.detached], total: diff.reduce((sum, { size }) => sum + size, 0), top: diff.slice(0, 25) } }));

  // Timer-held signals expire; capped buffers stay at their cap.
  await page.waitForTimeout(11_000);
  const idle = await snapshot(cdp, gc);
  const suspects = ['native:AbortSignal', 'native:blink::NetworkResourcesData::ResourceData', 'native:PerformanceResourceTiming', 'code:system / InstructionStream'];
  console.log(JSON.stringify({ idle: Object.fromEntries(suspects.map((key) => [key, [count(before, key).count, count(after, key).count, count(idle, key).count]])) }));
  await context.close();
} finally {
  await browser.close();
  if (state !== 'null') wp(['option', 'update', 'gq_support_state', state, '--format=json']);
}
