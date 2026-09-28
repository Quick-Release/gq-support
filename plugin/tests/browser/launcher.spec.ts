import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const site = process.env.GQ_SUPPORT_TEST_URL ?? 'https://gq-support-lifecycle-testsite.ddev.site';
const wp = (args: string[]) => execFileSync('ddev', ['exec', '--dir', '/var/www/html/.test-site', 'wp', ...args], { encoding: 'utf8' }).trim();

// Run against a disposable DDEV site: plugin is symlinked under wp-content/plugins.
test.beforeAll(() => {
  wp(['option', 'update', 'WPLANG', '']);
  wp(['language', 'core', 'install', 'pt_PT', 'ar']);
  wp(['plugin', 'activate', 'gq-support']);
  wp(['eval', "update_option('gq_support_connection', array('status' => 'connected', 'installation_id' => get_option('gq_support_installation_id')));"]);
  wp(['user', 'update', 'admin', '--user_pass=launcher-test-password']);
  wp(['user', 'update', 'editor', '--user_pass=editor']);
});
test.afterAll(() => { wp(['option', 'delete', 'gq_support_connection']); });

test('anonymous and unsupported admin screens receive no launcher assets', async ({ page }) => {
  await page.goto(`${site}/wp-admin/`);
  await expect(page.locator('#gq-support-root')).toHaveCount(0);
  await expect(page.locator('script[src*="gq-support-launcher"]')).toHaveCount(0);
});

test('Reporter gets a deferred, keyboard-operable panel with an in-memory draft', async ({ page }) => {
  await page.goto(`${site}/wp-login.php`);
  await page.locator('#user_login').fill('admin');
  await page.locator('#user_pass').fill('launcher-test-password');
  await page.locator('#wp-submit').click();
  await page.goto(`${site}/wp-admin/`);
  const launcher = page.getByRole('button', { name: 'Support', exact: false });
  await expect(launcher).toBeVisible();
  await expect(page.locator('script[src*="index.js"]')).toHaveCount(0);
  await expect(page.locator('#gq-support-app-assets')).toHaveCount(1);
  await launcher.click();
  const dialog = page.getByRole('dialog', { name: 'Support' });
  await expect(dialog).toBeVisible();
  const description = page.getByRole('textbox', { name: 'Description' });
  await expect(description).toBeFocused();
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a description');
  await description.fill('x'.repeat(5001));
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.getByRole('alert')).toContainText('too long');
  await description.fill('A draft');
  await page.keyboard.press('Escape');
  await expect(launcher).toBeFocused();
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  await expect(launcher.locator('.gq-support-draft-indicator')).toBeVisible();
  await launcher.click();
  await expect(description).toHaveValue('A draft');
  await expect(page.locator('script[src*="index.js"]')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toHaveCSS('width', '390px');
  await page.goto(`${site}/wp-admin/plugins.php`);
  await expect(page.locator('#gq-support-root')).toHaveCount(0);
  await page.goto(`${site}/wp-admin/post-new.php`);
  const tour = page.getByRole('dialog', { name: 'Welcome to the block editor' });
  if (await tour.isVisible()) await tour.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: /Support/ })).toBeVisible();
  expect(await page.locator('#gq-support-app-assets').evaluate((template: HTMLTemplateElement) => !!template.content.querySelector('#wp-element-js'))).toBe(false);
});

test('ungranted Reporter and unconfigured installation have no assets', async ({ page }) => {
  await page.goto(`${site}/wp-login.php`);
  await page.locator('#user_login').fill('editor');
  await page.locator('#user_pass').fill('editor');
  await page.locator('#wp-submit').click();
  await page.goto(`${site}/wp-admin/`);
  await expect(page.locator('#gq-support-root')).toHaveCount(0);
  await expect(page.locator('script[src*="gq-support-launcher"]')).toHaveCount(0);
});

test('Portuguese translations load on open', async ({ page }) => {
  wp(['option', 'update', 'WPLANG', 'pt_PT']);
  try {
    await page.goto(`${site}/wp-login.php`);
    await page.locator('#user_login').fill('admin');
    await page.locator('#user_pass').fill('launcher-test-password');
    await page.locator('#wp-submit').click();
    await page.goto(`${site}/wp-admin/`);
    await page.getByRole('button', { name: /Support|Apoio/ }).click();
    await expect(page.getByRole('tab', { name: 'Novo pedido' })).toBeVisible();

  } finally {
    wp(['option', 'update', 'WPLANG', '']);
  }
});

test('RTL page uses the generated RTL stylesheet', async ({ page }) => {
  wp(['option', 'update', 'WPLANG', 'ar']);
  try {
    await page.goto(`${site}/wp-login.php`);
    await page.locator('#user_login').fill('admin');
    await page.locator('#user_pass').fill('launcher-test-password');
    await page.locator('#wp-submit').click();
    await page.goto(`${site}/wp-admin/`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const launcher = page.locator('.gq-support-launcher');
    await launcher.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('link[href*="index-rtl.css"]')).toHaveCount(1);
  } finally {
    wp(['option', 'update', 'WPLANG', '']);
  }
});

test('failed app script load can be retried without a duplicate mount', async ({ page }) => {
  await page.goto(`${site}/wp-login.php`);
  await page.locator('#user_login').fill('admin');
  await page.locator('#user_pass').fill('launcher-test-password');
  await page.locator('#wp-submit').click();
  await page.goto(`${site}/wp-admin/`);
  let attempts = 0;
  await page.route(/gq-support\/assets\/dist\/index\.js/, async (route) => {
    if (attempts++ === 0) await route.abort();
    else await route.continue();
  });
  const launcher = page.getByRole('button', { name: /Support/ });
  await launcher.click();
  await expect(page.locator('.gq-support-launcher-status')).toContainText('Press to retry');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => attempts).toBe(1);
  await launcher.click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.locator('script[src*="index.js"]')).toHaveCount(1);
});

test('failed stylesheet load waits for an explicit retry and mounts once', async ({ page }) => {
  await page.goto(`${site}/wp-login.php`);
  await page.locator('#user_login').fill('admin');
  await page.locator('#user_pass').fill('launcher-test-password');
  await page.locator('#wp-submit').click();
  await page.goto(`${site}/wp-admin/`);
  let failures = 0;
  await page.route(/index(-rtl)?\.css/, async (route) => {
    if (failures++ === 0) await route.abort();
    else await route.continue();
  });
  const launcher = page.getByRole('button', { name: /Support/ });
  await launcher.click();
  await expect(page.locator('.gq-support-launcher-status')).toContainText('Press to retry');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => failures).toBe(1);
  await launcher.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
});
