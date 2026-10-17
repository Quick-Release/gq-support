// The disposable DDEV test site that the counter gate (plugin/tests/browser/performance.spec.ts)
// and the timing benchmark (timing-benchmark.mjs) both run against. CommonJS, because Playwright
// loads the TypeScript specs as CommonJS and the benchmark is an ES module.
const { execFileSync } = require('node:child_process');
const { join, resolve } = require('node:path');

exports.site = process.env.GQ_SUPPORT_TEST_URL ?? 'https://gq-support-lifecycle-testsite.ddev.site';
exports.repository = resolve(__dirname, '..', '..', '..');
exports.testSite = join(exports.repository, '.test-site');
/** Where gq-probe.php is installed as an mu-plugin while a run needs it. */
exports.probe = join(exports.testSite, 'wp-content', 'mu-plugins', 'gq-support-probe.php');
exports.probeSource = join(__dirname, 'gq-probe.php');
exports.adminPassword = 'launcher-test-password';

// `ddev exec` hands its arguments to a shell, so quote each one. (`ddev wp` is far slower on macOS.)
const shellQuote = (arg) => `'${arg.replace(/'/g, `'\\''`)}'`;

/** @param {string[]} args WP-CLI arguments. */
exports.wp = (args) => execFileSync('ddev', ['exec', '--dir', '/var/www/html/.test-site', ['wp', ...args].map(shellQuote).join(' ')], { encoding: 'utf8' }).trim();

/** macOS mounts the site through Mutagen, so files written on the host need a sync. */
exports.sync = () => { if (process.platform === 'darwin') execFileSync('ddev', ['mutagen', 'sync']); };

/** @param {import('@playwright/test').Page} page */
exports.logIn = async function logIn(page) {
  await page.goto(`${exports.site}/wp-login.php`);
  await page.locator('#user_login').fill('admin');
  await page.locator('#user_pass').fill(exports.adminPassword);
  await page.locator('#wp-submit').click();
  await page.waitForURL(/wp-admin/);
};
