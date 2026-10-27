import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tools/observer/**/*.test.ts"], maxWorkers: 1 },
});
