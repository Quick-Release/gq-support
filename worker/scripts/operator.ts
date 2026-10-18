import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { parseArgs } from "node:util";
import { runOperator } from "../src/operator.ts";
import { repositoryMappings } from "../src/repository-mappings.ts";

const usage = "Usage: pnpm operator <enroll|revoke|status|resume|reconcile|unsuspend|erase|erasure-status|erasure-close|cleanup-reconcile|cleanup-exception|offboard> <slot> [...] --account-id <id> --database-id <id>";
const directory = mkdtempSync(join(tmpdir(), "gq-support-operator-"));
const lock = new URL("../revocations.lock", import.meta.url);
let lockFd: number | undefined;
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    "account-id": { type: "string" }, "database-id": { type: "string" },
  } });
  const accountId = values["account-id"], databaseId = values["database-id"];
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId) || !databaseId || !/^[a-f0-9-]{36}$/i.test(databaseId)) throw new Error(usage);
  const config = join(directory, "wrangler.json");
  writeFileSync(config, JSON.stringify({ account_id: accountId, d1_databases: [{
    binding: "SupportDB", database_name: "operator-target", database_id: databaseId,
  }] }), { mode: 0o600 });
  if (positionals[0] === "revoke") lockFd = openSync(lock, "wx", 0o600);
  const output = await runOperator(positionals, {
    mappings: repositoryMappings,
    query: async (sql, parameters) => {
      // Wrangler's query interface has no parameter binding. Escape SQL literals.
      // The only code value here is its hash; plaintext codes never enter Wrangler.
      let index = 0;
      const statement = sql.replace(/\?/g, () => {
        const value = parameters[index++];
        if (value === undefined) throw new Error("Missing SQL parameter");
        return typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
      });
      const result = spawnSync(process.execPath, [
        new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname,
        "d1", "execute", "SupportDB", "--config", config, "--remote", "--json", "--command", statement,
      ], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
      if (result.status !== 0) throw new Error("Cloudflare D1 command failed. Check the target IDs and your Wrangler login/credentials.");
      const results: { success: boolean; results: Record<string, unknown>[] }[] = JSON.parse(result.stdout);
      if (results.length !== 1 || results[0].success !== true || !Array.isArray(results[0].results)) throw new Error("Unexpected Cloudflare D1 response");
      return results[0].results;
    },
    recordRevocation: async (keyId, revokedAt) => {
      const log = new URL("../revocations.json", import.meta.url);
      const records: { databaseId: string; keyId: string; revokedAt: number }[] = JSON.parse(readFileSync(log, "utf8"));
      if (records.some((record) => record.databaseId === databaseId && record.keyId === keyId)) return;
      records.push({ databaseId, keyId, revokedAt });
      const temporary = new URL("../revocations.json.tmp", import.meta.url);
      writeFileSync(temporary, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
      const fd = openSync(temporary, "r+");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, log);
    },
  });
  console.log(output);
  if (positionals[0] === "revoke") console.error("Commit worker/revocations.json before the next deployment or restore.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Operator command failed");
  process.exitCode = 1;
} finally {
  if (lockFd !== undefined) { closeSync(lockFd); rmSync(lock); }
  rmSync(directory, { recursive: true, force: true });
}
