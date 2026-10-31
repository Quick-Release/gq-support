import { defineConfig } from "vitest/config";
import { availableParallelism } from "node:os";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/d1-scratch.setup.ts"],
    // Each integration worker starts workerd and real local D1. Unbounded host
    // CPU concurrency makes unrelated scenarios exceed their execution timeout.
    maxWorkers: Math.min(4, availableParallelism()),
  },
});
