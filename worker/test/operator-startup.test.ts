import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("starts the documented Operator command and explains missing arguments without contacting a provider", () => {
  const result = spawnSync("pnpm", ["operator"], {
    cwd: fileURLToPath(new URL("..", import.meta.url).href), encoding: "utf8", timeout: 10_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage: pnpm operator");
  expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
}, 15_000);
