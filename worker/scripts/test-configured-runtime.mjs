// This override is deliberately scoped to this gate, not normal fixtures/dev/deploy.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const workerd = require("workerd");
const pinned = require("../package.json").devDependencies.workerd;
if (workerd.version !== pinned || typeof workerd.default !== "string") {
  throw new Error("Configured-runtime gate requires the exact pinned workerd package");
}
const binary = spawnSync(workerd.default, ["--version"], { encoding: "utf8", timeout: 10_000 });
if (binary.status !== 0 || binary.stdout.trim() !== `workerd ${workerd.compatibilityDate}`) {
  throw new Error("Configured-runtime gate binary version mismatch");
}
console.log(`Configured-runtime gate: workerd ${pinned}; binary ${binary.stdout.trim()}`);
const result = spawnSync(process.execPath, [join(dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run", "--config", "vitest.configured-runtime.config.ts"], {
  cwd: new URL("../", import.meta.url), stdio: "inherit", timeout: 120_000,
  env: { ...process.env, MINIFLARE_WORKERD_PATH: workerd.default },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
