import { test, expect } from '@playwright/test';
import { adminPassword, submitLogIn, wp } from '../performance/test-site.cjs';

test.beforeAll(() => wp(['user', 'update', 'admin', `--user_pass=${adminPassword}`]));

// wp-login.php focuses and selects the username 200 ms after it renders (core's wp_attempt_focus()).
// On a fast page load that timer fires in the middle of the form fill. In the 0.1.11 release run it
// moved the caret just as the password was typed: the password replaced the username, the required
// password stayed empty, and the browser refused to submit the form (Firefox and WebKit).
test('the form login survives WordPress autofocus landing while the password is typed', async ({ page }) => {
  // Holds core's own autofocus callback and replays it at the worst moment: right after the
  // password field gains focus, before any text reaches it.
  await page.addInitScript(() => {
    const schedule = window.setTimeout;
    let autofocus: (() => void) | undefined;
    window.setTimeout = ((callback: () => void, delay?: number, ...rest: unknown[]) => {
      if (delay === 200 && !autofocus && String(callback).includes('user_login')) {
        autofocus = callback;
        return 0;
      }
      return schedule(callback, delay, ...rest);
    }) as typeof window.setTimeout;
    document.addEventListener('focusin', (event) => {
      if (!autofocus || (event.target as HTMLElement).id !== 'user_pass') return;
      const run = autofocus;
      autofocus = undefined;
      sessionStorage.setItem('gq-test-autofocus', 'replayed');
      queueMicrotask(run);
    });
  });
  await submitLogIn(page, 'admin', adminPassword);
  await expect(page).toHaveURL(/wp-admin/);
  // The race really happened during this login, not before or never.
  expect(await page.evaluate(() => sessionStorage.getItem('gq-test-autofocus'))).toBe('replayed');
});
