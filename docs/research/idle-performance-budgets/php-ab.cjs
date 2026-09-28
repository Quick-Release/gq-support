// Interleaved plugin-on/off requests; the mu-plugin probe records per-request metrics.
const path = require('node:path');
const { chromium } = require(path.join(process.env.WT, 'node_modules/@playwright/test'));
const SITE = process.env.SITE || 'http://127.0.0.1:9471';
const N = Number(process.env.N || 30);
(async () => {
  const browser = await chromium.launch();
  const admin = await browser.newContext();
  const p = await admin.newPage();
  await p.goto(`${SITE}/wp-admin/`);
  await p.close();
  const anon = await browser.newContext();
  const targets = [
    [anon, '/'],
    [admin, '/wp-admin/index.php'],
    [admin, '/wp-admin/plugins.php'],
    [admin, '/wp-admin/admin-ajax.php?action=heartbeat'],
  ];
  for (const [ctx] of targets) for (let w = 0; w < 3; w++) await ctx.request.get(`${SITE}/`);
  for (let i = 0; i < N; i++) {
    for (const [ctx, url] of targets) {
      const order = i % 2 ? ['', '&gq_off=1'] : ['&gq_off=1', ''];
      for (const o of order) {
        const sep = url.includes('?') ? '&' : '?';
        await ctx.request.get(`${SITE}${url}${sep}gq_probe=1${o}`, { maxRedirects: 0 }).catch(() => {});
      }
    }
  }
  await browser.close();
})();
