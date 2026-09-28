// Disposable browser measurement against a local WordPress Playground site.
const path = require('node:path');
const { chromium } = require(path.join(process.env.WT, 'node_modules/@playwright/test'));
const SITE = process.env.SITE || 'http://127.0.0.1:9471';
const RUNS = Number(process.env.RUNS || 15);
const IDLE_MS = Number(process.env.IDLE_MS || 30000);
const own = (u) => /gq-support/.test(u);

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const med = (xs) => q(xs, 0.5);

async function track(page) {
  const log = [];
  page.on('requestfinished', async (req) => {
    const r = await req.response();
    let bytes = 0;
    try { bytes = (await r.body()).length; } catch {}
    const sizes = await req.sizes().catch(() => ({ responseBodySize: 0 }));
    log.push({ url: req.url(), type: req.resourceType(), bytes, wire: sizes.responseBodySize + sizes.responseHeadersSize });
  });
  return log;
}

(async () => {
  const browser = await chromium.launch();
  const out = {};

  // Anonymous public page.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const log = await track(page);
    await page.goto(`${SITE}/`, { waitUntil: 'networkidle' });
    const html = await page.content();
    out.anonymous = { ownRequests: log.filter((r) => own(r.url)).map((r) => r.url), htmlMentions: /gq-support/.test(html) };
    await ctx.close();
  }

  // Logged-in admin context (Playground --login auto-authenticates on first admin visit).
  const ctx = await browser.newContext();
  const warm = await ctx.newPage();
  await warm.goto(`${SITE}/wp-admin/${process.env.SCREEN || ''}`, { waitUntil: 'networkidle' });
  await warm.close();

  const closed = [];
  const opens = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.addInitScript(() => {
      window.__lt = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true });
    });
    const log = await track(page);
    await page.goto(`${SITE}/wp-admin/${process.env.SCREEN || ''}`, { waitUntil: 'networkidle' });
    const dom = await page.evaluate(() => ({
      template: document.getElementById('gq-support-app-assets')?.outerHTML.length ?? 0,
      root: document.getElementById('gq-support-root')?.outerHTML.length ?? 0,
      inlineBootstrap: [...document.scripts].filter((s) => /gqSupportLauncher=/.test(s.textContent)).reduce((n, s) => n + s.outerHTML.length, 0),
      html: document.documentElement.outerHTML.length,
    }));
    const ownClosed = log.filter((r) => own(r.url));
    closed.push({ ...dom, ownRequests: ownClosed.length, ownBytes: ownClosed.reduce((n, r) => n + r.bytes, 0), totalRequests: log.length, ownUrls: ownClosed.map((r) => r.url.replace(SITE, '')) });

    const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const n0 = log.length;
    const t0 = await page.evaluate(() => performance.now());
    await page.getByRole('button', { name: /^Support/ }).click();
    await page.getByRole('textbox', { name: 'Description' }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Description' || document.activeElement?.tagName === 'TEXTAREA');
    const t1 = await page.evaluate(() => performance.now());
    await page.waitForLoadState('networkidle');
    const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const openReqs = log.slice(n0);
    const lt = await page.evaluate((t) => window.__lt.filter((e) => e.start >= t), t0);
    opens.push({
      usableMs: t1 - t0,
      requests: openReqs.length,
      bytes: openReqs.reduce((n, r) => n + r.bytes, 0),
      urls: openReqs.map((r) => r.url.replace(SITE, '')),
      scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
      taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
      heapDelta: after.JSHeapUsedSize - before.JSHeapUsedSize,
      longTasks: lt.length,
      longestTask: lt.reduce((m, e) => Math.max(m, e.dur), 0),
    });
    await page.close();
  }

  // Idle after load (closed) and after open/close, plus repeated cycles.
  {
    const page = await ctx.newPage();
    const log = await track(page);
    await page.goto(`${SITE}/wp-admin/${process.env.SCREEN || ''}`, { waitUntil: 'networkidle' });
    let n = log.length;
    await page.waitForTimeout(IDLE_MS);
    const idleClosed = log.slice(n);
    const launcher = page.getByRole('button', { name: /^Support/ });
    await launcher.click();
    await page.getByRole('textbox', { name: 'Description' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForLoadState('networkidle');
    n = log.length;
    await page.emulateMedia({});
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(IDLE_MS);
    const idleAfterUse = log.slice(n);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    const h0 = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    n = log.length;
    for (let i = 0; i < 50; i++) { await launcher.click(); await page.keyboard.press('Escape'); }
    await cdp.send('HeapProfiler.collectGarbage');
    const h1 = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    out.idle = {
      idleMs: IDLE_MS,
      closedAll: idleClosed.map((r) => r.url.replace(SITE, '')),
      closedOwn: idleClosed.filter((r) => own(r.url)).length,
      afterUseAll: idleAfterUse.map((r) => r.url.replace(SITE, '')),
      afterUseOwn: idleAfterUse.filter((r) => own(r.url)).length,
      cyclesRequests: log.slice(n).length,
      heapDelta50Cycles: h1 - h0,
    };
  }

  const pick = (rows, k) => ({ median: med(rows.map((r) => r[k])), p95: q(rows.map((r) => r[k]), 0.95), min: Math.min(...rows.map((r) => r[k])), max: Math.max(...rows.map((r) => r[k])) });
  out.closed = { sample: closed[0], runs: RUNS, totalRequests: pick(closed, 'totalRequests'), ownBytes: pick(closed, 'ownBytes'), html: pick(closed, 'html') };
  out.open = { sampleUrls: opens[0].urls, runs: RUNS, usableMs: pick(opens, 'usableMs'), requests: pick(opens, 'requests'), bytes: pick(opens, 'bytes'), scriptMs: pick(opens, 'scriptMs'), taskMs: pick(opens, 'taskMs'), heapDelta: pick(opens, 'heapDelta'), longTasks: pick(opens, 'longTasks'), longestTask: pick(opens, 'longestTask') };
  out.env = { chromium: browser.version(), site: SITE };
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
