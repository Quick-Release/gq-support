import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  use: { ignoreHTTPSErrors: true },
  workers: 1,
});
