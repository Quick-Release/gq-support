import { URL } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { ACCOUNT as accountId } from "../../deploy/planning-state.ts";
export function confinedInput(stage: "prod" | "staging" = "prod", ledgerHistory: "current" | "before-maintenance" = "current") {
  const suffix = stage === "prod" ? "" : "-staging";
  const worker = `synthetic-worker${suffix}`;
  const database = (fqn: string, dir: string, id: number) => ({
    fqn, namespace: undefined, logicalId: fqn, instanceId: `instance-${fqn}${suffix}`, resourceType: "Cloudflare.D1Database",
    providerVersion: 1, providerMode: "live" as const, status: "created" as const, downstream: ["Worker"], bindings: [], removalPolicy: "retain" as const,
    props: { jurisdiction: "eu", migrations: dir },
    attr: { databaseId: `00000000-0000-4000-8000-00000000000${id + (stage === "staging" ? 2 : 0)}`, databaseName: `synthetic-${fqn}${suffix}`, accountId, jurisdiction: "eu",
      migrationsDir: dir, migrationsTable: "__alchemy_migrations", migrationsHashes: Object.fromEntries(readdirSync(new URL(`../../${dir}/`, import.meta.url)).filter((n) => n.endsWith(".sql")).map((name) => [name, createHash("sha256").update(readFileSync(new URL(`../../${dir}/${name}`, import.meta.url))).digest("hex")])) },
  });
  const rows = {
    SupportDB: database("SupportDB", "./migrations", 1), SupportLedger: database("SupportLedger", "./ledger-migrations", 2),
    Worker: { fqn: "Worker", namespace: undefined, logicalId: "Worker", instanceId: `instance-Worker${suffix}`, resourceType: "Cloudflare.Worker", providerVersion: 1, providerMode: "live" as const, status: "created" as const, downstream: ["GitHubAppSecret"], bindings: [], props: {}, attr: { accountId, workerName: worker, workerId: "00000000000000000000000000000001", url: "https://synthetic-worker.example.workers.dev", urls: ["https://synthetic-worker.example.workers.dev"], crons: ["* * * * *"], hash: {} } },
    GitHubAppSecret: { fqn: "GitHubAppSecret", namespace: undefined, logicalId: "GitHubAppSecret", instanceId: `instance-secret${suffix}`, resourceType: "GQSupport.GitHubAppSecret", providerVersion: 1, providerMode: "live" as const, status: "created" as const, downstream: [], bindings: [], props: { stage, workerName: worker }, attr: {} },
  };
  // Explicit synthetic history for additive-transition tests. The default
  // snapshot assumes all checkout migrations committed; neither represents a
  // remotely observed database. Keep destructive ledger 0002 committed here.
  if (ledgerHistory === "before-maintenance") {
    delete rows.SupportLedger.attr.migrationsHashes["0003_maintenance.sql"];
    delete rows.SupportLedger.attr.migrationsHashes["0004_discord_alerts.sql"];
    delete rows.SupportLedger.attr.migrationsHashes["0005_cron_progress.sql"];
  }
  return { target: { stack: "GQSupportWorker" as const, stage }, databases: [rows.SupportDB, rows.SupportLedger].map((row) => ({
    fqn: row.fqn as "SupportDB" | "SupportLedger", instanceId: row.instanceId, databaseId: row.attr.databaseId, databaseName: row.attr.databaseName,
  })), rows: { GQSupportWorker: { [stage]: rows } }, output: { GQSupportWorker: { [stage]: {} } } };
}
