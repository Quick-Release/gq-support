import { defineConfig } from '@playwright/test';

// CI runs the counter gate and the acceptance specs as parallel jobs, each on its own site:
// GQ_SUPPORT_BROWSER_SUITE=performance or =acceptance. Unset runs every spec.
const suite = process.env.GQ_SUPPORT_BROWSER_SUITE;
const performance = 'performance.spec.ts';
// A runtime matrix cell's engine (.github/runtime-matrix.json): chromium, firefox or webkit.
const browserName = (process.env.GQ_SUPPORT_BROWSER ?? 'chromium') as 'chromium' | 'firefox' | 'webkit';

export default defineConfig({
  testDir: '.',
  testMatch: suite === 'performance' ? performance : '*.spec.ts',
  testIgnore: suite === 'acceptance' ? performance : undefined,
  use: { browserName, ignoreHTTPSErrors: true, screenshot: 'only-on-failure' },
  workers: 1,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]] : 'list',
});
