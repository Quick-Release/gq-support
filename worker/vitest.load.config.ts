import { defineConfig } from "vitest/config";

/** `pnpm load-test`: kept out of `pnpm test`, which stays fast. */
export default defineConfig({
  test: {
    include: ["load/**/*.load.ts"],
    testTimeout: 600_000,
  },
});
