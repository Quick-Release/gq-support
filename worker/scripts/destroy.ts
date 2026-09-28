// The only supported way to run `alchemy destroy`: `pnpm run destroy --stage <stage>`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { destroyRefusal } from "./destroy-guard.ts";

const readFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const argv = process.argv.slice(2);
const refusal = destroyRefusal(argv, process.env, readFile);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(1);
}
const result = spawnSync("alchemy", ["destroy", ...argv], { stdio: "inherit" });
process.exit(result.status ?? 1);
