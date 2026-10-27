import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.configured.ts"], maxWorkers: 1 },
});
