import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { parseArgs } from "node:util";
import { runOperator } from "../src/operator.ts";
import { stageInventories } from "../src/inventory.ts";
import { stageMappings } from "../src/repository-mappings.ts";
import { stageReleaseEnforcement } from "../src/release-policy.ts";
import { stageCentralTargets } from "../src/central-deployment.ts";
import { commandTransport } from "./central-transport.ts";
import { githubEvidence } from "./release-evidence.ts";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

const usage = "Usage: pnpm operator <enroll|revoke|status|resume|reconcile|unsuspend|erase|erasure-status|erasure-close|restore-recorded|cleanup-reconcile|cleanup-exception|offboard|status-<health|reconcile|repair>|incidents|incident|incident-claim|notifications|notification-retry|health|drill-verify|inventory|inventory-credentials|inventory-record|inventory-contact|release-status|release-candidate|release-verify|release-approve|release-withdraw|release-boundary|fleet-launch|fleet-status|fleet-run|update-access-status|update-access-grant|update-access-revoke|central-apply|central-status> [...] --stage <staging|prod> --account-id <id> --database-id <id> [--ledger-database-id <id>]";
const directory = mkdtempSync(join(tmpdir(), "gq-support-operator-"));
const lock = new URL("../revocations.lock", import.meta.url);
let lockFd: number | undefined;
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    stage: { type: "string" }, "account-id": { type: "string" }, "database-id": { type: "string" }, "ledger-database-id": { type: "string" },
  } });
  const stage = values.stage;
  if (stage !== "staging" && stage !== "prod") throw new Error(usage);
  const accountId = values["account-id"], databaseId = values["database-id"], ledgerId = values["ledger-database-id"];
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId) || !databaseId || !/^[a-f0-9-]{36}$/i.test(databaseId) ||
    (ledgerId !== undefined && !/^[a-f0-9-]{36}$/i.test(ledgerId))) throw new Error(usage);
  const config = join(directory, "wrangler.json");
  writeFileSync(config, JSON.stringify({ account_id: accountId, d1_databases: [
    { binding: "SupportDB", database_name: "operator-target", database_id: databaseId },
    ...(ledgerId ? [{ binding: "SupportLedger", database_name: "operator-ledger", database_id: ledgerId }] : []),
  ] }), { mode: 0o600 });
  if (positionals[0] === "revoke") lockFd = openSync(lock, "wx", 0o600);
  const d1 = (binding: string) => async (sql: string, parameters: readonly (string | number | null)[]) => {
    // Wrangler's query interface has no parameter binding. Escape SQL literals.
    // The only code value here is its hash; plaintext codes never enter Wrangler.
    let index = 0;
    const statement = sql.replace(/\?/g, () => {
      const value = parameters[index++];
      if (value === undefined) throw new Error("Missing SQL parameter");
      return value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
    });
    const result = spawnSync(process.execPath, [
      new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname,
      "d1", "execute", binding, "--config", config, "--remote", "--json", "--command", statement,
    ], { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
    if (result.status !== 0) throw new Error("Cloudflare D1 command failed. Check the target IDs and your Wrangler login/credentials.");
    const results: { success: boolean; results: Record<string, unknown>[] }[] = JSON.parse(result.stdout);
    if (results.length !== 1 || results[0].success !== true || !Array.isArray(results[0].results)) throw new Error("Unexpected Cloudflare D1 response");
    return results[0].results;
  };
  const output = await runOperator(positionals, {
    // Only the target stage's reviewed mappings; the database IDs must belong to the same stage.
    mappings: stageMappings[stage],
    inventory: stageInventories[stage],
    release: stageReleaseEnforcement[stage],
    stage,
    // GitHub's own run records for release gates, read with the Operator's `gh` login.
    evidence: githubEvidence(),
    // The reviewed migrations in this checkout, by their checksum (migrations/checksums.txt), compared with the live record.
    migrations: (() => {
      const migrations = new URL("../migrations/", import.meta.url);
      const locked = new Map(readFileSync(new URL("checksums.txt", migrations), "utf8").trim().split("\n").map((line) => line.split(/\s+/).reverse() as [string, string]));
      return readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort().map((name) => {
        const sql = readFileSync(new URL(name, migrations), "utf8");
        const sha256 = createHash("sha256").update(sql).digest("hex");
        if (locked.get(name) !== sha256) throw new Error(`Migration ${name} does not match migrations/checksums.txt; use a clean reviewed checkout.`);
        return { name, sha256, sql };
      });
    })(),
    // The stage's reviewed central targets, reached with the Operator's own hosting access.
    central: { targets: stageCentralTargets[stage], transport: commandTransport() },
    // A downloaded release workflow artifact: the exact ZIP and the manifest and provenance recorded with it.
    readArtifact: async (artifact) => ({ zip: readFileSync(join(artifact, "gq-support.zip")),
      manifest: readFileSync(join(artifact, "gq-support.manifest.json"), "utf8"), provenance: readFileSync(join(artifact, "provenance.json"), "utf8") }),
    query: d1("SupportDB"),
    ...(ledgerId ? { ledger: d1("SupportLedger") } : {}),
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
