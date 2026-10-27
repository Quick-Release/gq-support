import { URL } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { ACCOUNT as accountId } from "../../deploy/planning-state.ts";
export function confinedInput() {
  const database = (fqn: string, dir: string, id: number) => ({
    fqn, logicalId: fqn, instanceId: `instance-${fqn}`, resourceType: "Cloudflare.D1Database",
    providerVersion: 1, providerMode: "live", status: "created", downstream: ["Worker"], bindings: [], removalPolicy: "retain",
    props: { jurisdiction: "eu", migrations: dir },
    attr: { databaseId: `00000000-0000-4000-8000-00000000000${id}`, databaseName: `synthetic-${fqn}`, accountId, jurisdiction: "eu",
      migrationsDir: dir, migrationsTable: "__alchemy_migrations", migrationsHashes: Object.fromEntries(readdirSync(new URL(`../../${dir}/`, import.meta.url)).filter((n) => n.endsWith(".sql")).map((name) => [name, createHash("sha256").update(readFileSync(new URL(`../../${dir}/${name}`, import.meta.url))).digest("hex")])) },
  });
  const rows = {
    SupportDB: database("SupportDB", "./migrations", 1), SupportLedger: database("SupportLedger", "./ledger-migrations", 2),
    Worker: { fqn: "Worker", logicalId: "Worker", instanceId: "instance-Worker", resourceType: "Cloudflare.Worker", providerVersion: 1, providerMode: "live", status: "created", downstream: ["GitHubAppSecret"], bindings: [], props: {}, attr: { accountId, workerName: "synthetic-worker", workerId: "00000000000000000000000000000001", url: "https://synthetic-worker.example.workers.dev", urls: ["https://synthetic-worker.example.workers.dev"], crons: ["* * * * *"], hash: {} } },
    GitHubAppSecret: { fqn: "GitHubAppSecret", logicalId: "GitHubAppSecret", instanceId: "instance-secret", resourceType: "GQSupport.GitHubAppSecret", providerVersion: 1, providerMode: "live", status: "created", downstream: [], bindings: [], props: { stage: "prod", workerName: "synthetic-worker" }, attr: {} },
  };
  return { databases: [
    { fqn: "SupportDB" as const, instanceId: "instance-SupportDB", databaseId: "00000000-0000-4000-8000-000000000001", databaseName: "synthetic-SupportDB" },
    { fqn: "SupportLedger" as const, instanceId: "instance-SupportLedger", databaseId: "00000000-0000-4000-8000-000000000002", databaseName: "synthetic-SupportLedger" },
  ], rows: { GQSupportWorker: { prod: rows } }, output: { GQSupportWorker: { prod: {} } } };
}
