import { test, expect, type Page } from '@playwright/test';
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

async function logIn(page: Page, user = 'admin', password = 'launcher-test-password') {
  await page.goto(`${site}/wp-login.php`);
  await page.locator('#user_login').fill(user);
  await page.locator('#user_pass').fill(password);
  await page.locator('#wp-submit').click();
}

test('anonymous and unsupported admin screens receive no launcher assets', async ({ page }) => {
  await page.goto(`${site}/wp-admin/`);
  await expect(page.locator('#gq-support-root')).toHaveCount(0);
  await expect(page.locator('script[src*="gq-support-launcher"]')).toHaveCount(0);
});

test('Reporter gets a deferred, keyboard-operable panel with an in-memory draft', async ({ page }) => {
  await logIn(page);
  const pluginRequests: string[] = [];
  page.on('request', (request) => {
    if (/wp-json\/gq-support|rest_route=%2Fgq-support/.test(request.url())) pluginRequests.push(request.url());
  });
  await page.goto(`${site}/wp-admin/`);
  const launcher = page.getByRole('button', { name: /^Support/ });
  await expect(launcher).toBeVisible();
  await expect(page.locator('script[src*="gq-support/assets/dist/index.js"]')).toHaveCount(0);
  // Core may already print React on this screen; the plugin must neither print it nor defer a second copy.
  const pageHasElement = (await page.locator('script#wp-element-js').count()) > 0;
  const templateHasElement = await page.locator('#gq-support-app-assets').evaluate((template: HTMLTemplateElement) => !!template.content.querySelector('#wp-element-js'));
  expect(templateHasElement).toBe(!pageHasElement);
  await expect(page.locator('link[href*="gq-support/assets/dist"]')).toHaveCount(0);
  await expect(page.locator('#gq-support-app-assets')).toHaveCount(1);
  await expect(launcher).not.toHaveAttribute('aria-controls');
  expect(pluginRequests).toEqual([]);
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
  await expect(launcher).toHaveAccessibleName(/Unsent draft/);
  await launcher.click();
  await expect(description).toHaveValue('A draft');
  await expect(launcher).toHaveAttribute('aria-controls', 'gq-support-panel');
  await launcher.click();
  await expect(dialog).toBeHidden();
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  await launcher.click();
  await expect(description).toBeFocused();
  await expect(page.locator('script[src*="gq-support/assets/dist/index.js"]')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toHaveCSS('width', '390px');
  await page.goto(`${site}/wp-admin/plugins.php`);
  await expect(page.locator('#gq-support-root')).toHaveCount(0);
  await page.goto(`${site}/wp-admin/post-new.php`);
  const tour = page.getByRole('dialog', { name: 'Welcome to the block editor' });
  if (await tour.isVisible()) await tour.getByRole('button', { name: 'Close' }).click();
  const editorLauncher = page.getByRole('button', { name: /Support/ });
  await expect(editorLauncher).toBeVisible();
  expect(await page.locator('#gq-support-app-assets').evaluate((template: HTMLTemplateElement) => !!template.content.querySelector('#wp-element-js, #react-js'))).toBe(false);
  await editorLauncher.click();
  await expect(page.getByRole('dialog', { name: 'Support' })).toBeVisible();
  await expect(page.locator('script#react-js')).toHaveCount(1);
  await expect(page.locator('script#wp-element-js')).toHaveCount(1);
});

test('ungranted Reporter has no assets', async ({ page }) => {
  await logIn(page, 'editor', 'editor');
  await page.goto(`${site}/wp-admin/`);
  await expect(page.locator('#gq-support-root')).toHaveCount(0);
  await expect(page.locator('script[src*="gq-support-launcher"]')).toHaveCount(0);
});

test('Reporter on an unconfigured installation has no assets', async ({ page }) => {
  const connection = wp(['option', 'get', 'gq_support_connection', '--format=json']);
  wp(['option', 'delete', 'gq_support_connection']);
  try {
    await logIn(page);
    await page.goto(`${site}/wp-admin/`);
    await expect(page.locator('#wpadminbar')).toBeVisible();
    await expect(page.locator('#gq-support-root')).toHaveCount(0);
    await expect(page.locator('script[src*="gq-support-launcher"]')).toHaveCount(0);
  } finally {
    wp(['option', 'update', 'gq_support_connection', connection, '--format=json']);
  }
});

test('Portuguese translations load on open', async ({ page }) => {
  wp(['option', 'update', 'WPLANG', 'pt_PT']);
  try {
    await logIn(page);
    await page.goto(`${site}/wp-admin/`);
    await page.getByRole('button', { name: 'Apoio', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Novo pedido' })).toBeVisible();
  } finally {
    wp(['option', 'update', 'WPLANG', '']);
  }
});

test('RTL page uses the generated RTL stylesheet', async ({ page }) => {
  wp(['option', 'update', 'WPLANG', 'ar']);
  try {
    await logIn(page);
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
  await logIn(page);
  await page.goto(`${site}/wp-admin/`);
  let attempts = 0;
  await page.route(/gq-support\/assets\/dist\/index\.js/, async (route) => {
    if (attempts++ === 0) await route.abort();
    else await route.continue();
  });
  const launcher = page.getByRole('button', { name: /Support/ });
  await launcher.click();
  await expect(page.locator('.gq-support-launcher-status')).toContainText('Press to retry');
  await expect(page.locator('.gq-support-launcher-status')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => attempts).toBe(1);
  await launcher.click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.locator('script[src*="gq-support/assets/dist/index.js"]')).toHaveCount(1);
});

test('failed stylesheet load waits for an explicit retry and mounts once', async ({ page }) => {
  await logIn(page);
  await page.goto(`${site}/wp-admin/`);
  let failures = 0;
  await page.route(/gq-support\/assets\/dist\/index(-rtl)?\.css/, async (route) => {
    if (failures++ === 0) await route.abort();
    else await route.continue();
  });
  const launcher = page.getByRole('button', { name: /Support/ });
  await launcher.click();
  await expect(page.locator('.gq-support-launcher-status')).toContainText('Press to retry');
  await expect(page.locator('.gq-support-launcher-status')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => failures).toBe(1);
  await launcher.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

const wooActive = () => {
  try { wp(['plugin', 'is-active', 'woocommerce']); return true; } catch { return false; }
};

test('WooCommerce screens get the launcher and the panel without a second React', async ({ page }) => {
  test.skip(!wooActive(), 'WooCommerce is not active on this test site.');
  await logIn(page);
  for (const path of ['admin.php?page=wc-settings', 'admin.php?page=wc-orders', 'admin.php?page=wc-admin']) {
    await page.goto(`${site}/wp-admin/${path}`);
    const launcher = page.getByRole('button', { name: /^Support/ });
    await expect(launcher, path).toBeVisible();
    await launcher.click();
    await expect(page.getByRole('dialog', { name: 'Support' }), path).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Description' }), path).toBeFocused();
    await expect(page.locator('script#react-js'), path).toHaveCount(1);
  }
});

/** Interactive controls whose visible centre is covered by the launcher once every scroller is at its end. */
async function controlsCoveredByLauncher(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) element.scrollTop = element.scrollHeight;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    const root = document.getElementById('gq-support-root')!;
    const covered: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])');
    for (const control of Array.from(controls)) {
      if (root.contains(control)) continue;
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
      if (x !== rect.left + rect.width / 2 || y !== rect.top + rect.height / 2) continue; // Centre is off-screen.
      const hit = document.elementFromPoint(x, y);
      if (hit && root.contains(hit)) covered.push(control.outerHTML.slice(0, 120));
    }
    return covered;
  });
}

test('the closed launcher never covers admin controls', async ({ page }) => {
  await logIn(page);
  const screens = ['index.php', 'edit.php', 'post-new.php', ...(wooActive() ? ['admin.php?page=wc-settings', 'admin.php?page=wc-orders'] : [])];
  for (const viewport of [{ width: 1280, height: 800 }, { width: 782, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const screen of screens) {
      await page.goto(`${site}/wp-admin/${screen}`);
      const tour = page.getByRole('dialog', { name: 'Welcome to the block editor' });
      if (await tour.isVisible()) await tour.getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('#gq-support-root')).toBeVisible();
      expect(await controlsCoveredByLauncher(page), `${screen} at ${viewport.width}px`).toEqual([]);
    }
  }
  // Prove the probe detects cover: stretch the launcher over the whole viewport.
  await page.locator('#gq-support-root').evaluate((root) => { root.style.inset = '0'; });
  expect((await controlsCoveredByLauncher(page)).length).toBeGreaterThan(0);
});

const schemes = ['fresh', 'light', 'modern', 'blue', 'coffee', 'ectoplasm', 'midnight', 'ocean', 'sunrise'];

test('launcher and panel keep AA contrast in every admin colour scheme', async ({ page }) => {
  await logIn(page);
  const accents = new Set<string>();
  const coreAccents = new Set<string>();
  try {
    for (const scheme of schemes) {
      wp(['user', 'meta', 'update', 'admin', 'admin_color', scheme]);
      await page.goto(`${site}/wp-admin/`);
      await page.getByRole('button', { name: /^Support/ }).click();
      await expect(page.getByRole('dialog', { name: 'Support' })).toBeVisible();
      const report = await page.evaluate(() => {
        const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const luminance = (value: string) => {
          const [r, g, b] = rgb(value).map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a: string, b: string) => { const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
        const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        // Resolve core's accent for this screen; WordPress 6.5 defines it per scheme only in the block editor.
        const probe = document.body.appendChild(document.createElement('span'));
        probe.style.color = 'var(--wp-admin-theme-color, #007cba)';
        const coreAccent = getComputedStyle(probe).color;
        probe.remove();
        return {
          coreAccent,
          accent: css('.gq-support-tab[aria-selected="true"]').borderBottomColor,
          launcherText: contrast(css('.gq-support-launcher').color, css('.gq-support-launcher').backgroundColor),
          launcherOnPage: contrast(css('.gq-support-launcher').backgroundColor, getComputedStyle(document.body).backgroundColor),
          selectedTab: contrast(css('.gq-support-tab[aria-selected="true"]').borderBottomColor, css('.gq-support-panel').backgroundColor),
          panelText: contrast(css('.gq-support-panel').color, css('.gq-support-panel').backgroundColor),
        };
      });
      accents.add(report.accent);
      coreAccents.add(report.coreAccent);
      expect(report.accent, scheme).toBe(report.coreAccent);
      // WCAG AA: 4.5:1 for text, 3:1 for the selected-tab indicator and focus ring (same accent).
      expect(report.launcherText, scheme).toBeGreaterThanOrEqual(4.5);
      expect(report.panelText, scheme).toBeGreaterThanOrEqual(4.5);
      expect(report.launcherOnPage, scheme).toBeGreaterThanOrEqual(3);
      expect(report.selectedTab, scheme).toBeGreaterThanOrEqual(3);
    }
    // The accent follows core's scheme colour wherever core provides one.
    expect(accents.size).toBe(coreAccents.size);
  } finally {
    wp(['user', 'meta', 'update', 'admin', 'admin_color', 'fresh']);
  }
});
