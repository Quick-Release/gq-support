import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { stageCentralTargets } from "../src/central-deployment.ts";
import { stageInventories } from "../src/inventory.ts";
import { runReadiness, SIGN_OFF_REVIEWERS } from "../src/readiness.ts";
import { stageReleaseEnforcement } from "../src/release-policy.ts";
import { stageMappings } from "../src/repository-mappings.ts";
import pins from "../deploy/protected-resources.json" with { type: "json" };
import { githubReadiness } from "./release-evidence.ts";

/**
 * `pnpm readiness --stage prod [--evidence <file>] [--drill-report <file>] [--trusted] [--out <file>]`
 * (src/readiness.ts; docs/runbooks/production-readiness.md). Reads this
 * checkout's reviewed configuration and the named files. `--trusted` also reads
 * GitHub's own records with the Operator's `gh` login, read-only `gh api` GETs and
 * artifact downloads; nothing is triggered, applied or written anywhere but `--out`.
 */
const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const names = (directory: string) => readdirSync(new URL(directory, import.meta.url).pathname).filter((name) => name.endsWith(".sql")).sort();

process.exitCode = await runReadiness(process.argv.slice(2), {
  config: { enforcement: stageReleaseEnforcement.prod, pins: (pins as Record<string, Record<string, Record<string, string>> | undefined>).prod,
    mappings: stageMappings.prod, centralTargets: stageCentralTargets.prod, inventory: stageInventories.prod, reviewers: SIGN_OFF_REVIEWERS,
    migrations: { SupportDB: names("../migrations/"), SupportLedger: names("../ledger-migrations/") } },
  checkout: { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "" },
  trusted: () => githubReadiness(),
  readFile: (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } },
  writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  log: (line) => console.log(line),
  now: () => new Date(),
});
