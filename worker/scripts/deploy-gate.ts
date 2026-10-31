// The only deployment path for staging and prod, run by .github/workflows/deploy-worker.yml:
//   pnpm deploy-gate plan --stage <stage> --out deploy-plan
//   pnpm deploy-gate apply --stage <stage> --evidence deploy-plan
// See deploy/plan-gate.ts and the operations runbook's deployment plan gate.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { alchemyPlanner } from "../deploy/alchemy-planner.ts";
import { planGate, type ProtectedPins } from "../deploy/plan-gate.ts";
import pins from "../deploy/protected-resources.json" with { type: "json" };

const readFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

process.exitCode = await planGate(process.argv.slice(2), {
  env: process.env,
  pins: pins as ProtectedPins,
  stack: alchemyPlanner,
  now: () => new Date(),
  readFile,
  writeFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  log: (line) => console.log(line),
});
