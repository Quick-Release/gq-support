import { defineConfig } from '@playwright/test';

// CI runs the counter gate and the acceptance specs as parallel jobs, each on its own site:
// GQ_SUPPORT_BROWSER_SUITE=performance or =acceptance. Unset runs every spec.
const suite = process.env.GQ_SUPPORT_BROWSER_SUITE;
const performance = 'performance.spec.ts';

export default defineConfig({
  testDir: '.',
  testMatch: suite === 'performance' ? performance : '*.spec.ts',
  testIgnore: suite === 'acceptance' ? performance : undefined,
  use: { ignoreHTTPSErrors: true },
  workers: 1,
});
