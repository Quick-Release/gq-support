import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/d1-scratch.setup.ts"],
    // Each test worker also starts workerd for real D1. Leave CPU capacity for
    // those processes: competing files can otherwise exhaust the 5 s test budget.
    maxWorkers: "25%",
  },
});
