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

/** Each user's cookies from their last form login in this worker; each test gets a fresh context. */
const savedCookies = new Map();

/** Forget the saved logins, after anything that may end a session (such as a password reset). */
exports.forgetLogIn = () => { savedCookies.clear(); };

/**
 * Logs the page's context in, as admin by default. A user's first call submits the login form;
 * later calls reuse its cookies, which saves a login round trip per test. It leaves the page where it was.
 * @param {import('@playwright/test').Page} page
 * @param {string} [user]
 * @param {string} [password]
 */
exports.logIn = async function logIn(page, user = 'admin', password = exports.adminPassword) {
  if (savedCookies.has(user)) {
    await page.context().addCookies(savedCookies.get(user));
    return;
  }
  // Logged in as someone else, wp-login.php clears the typed password.
  await page.context().clearCookies({ name: /^wordpress/ });
  await page.goto(`${exports.site}/wp-login.php`);
  await page.locator('#user_login').fill(user);
  await page.locator('#user_pass').fill(password);
  await page.locator('#wp-submit').click();
  await page.waitForURL(/wp-admin/);
  // Only the login's own cookies, not a test's (such as a Worker outage).
  savedCookies.set(user, (await page.context().cookies()).filter(({ name }) => name.startsWith('wordpress')));
};
