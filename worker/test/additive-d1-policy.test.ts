import { discord as discordBinding, observer } from "./fixtures/discord-custody.ts";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateAdditiveSql } from "../deploy/additive-sql.ts";
import { d1MigrationGrant, d1MigrationSession, nativeColumnsSql, nativeHistorySql, migrationSummary, sha256 } from "../deploy/d1-migration-profile.ts";
import { planningApplyBroker } from "../deploy/planning-apply-broker.ts";
import { confinedInput } from "./fixtures/confined-input.ts";
const fixtureSql = (name: string) => readFileSync(new URL(`./fixtures/additive-d1/${name}.fixture`, import.meta.url), "utf8");
const maintenance = fixtureSql("0003_maintenance.sql"), discord = fixtureSql("0004_discord_alerts.sql");
function fixture(stage: "prod" | "staging" = "prod", fqn: "SupportDB" | "SupportLedger" = "SupportLedger") {
  const input = confinedInput(stage, "before-maintenance"), row = JSON.parse(JSON.stringify(input.rows.GQSupportWorker[stage][fqn]));
  const identity = input.databases.find((db) => db.fqn === fqn)!;
  const files = Object.fromEntries(Object.keys(row.attr.migrationsHashes).map((name) => [name, readFileSync(new URL(`../${row.props.migrations}/${name}`, import.meta.url), "utf8")]));
  Object.assign(files, { "0003_maintenance.sql": maintenance, "0004_discord_alerts.sql": discord });
  // SupportDB's committed files extend beyond 0004; use fresh forward names.
  if (fqn === "SupportDB") { delete files["0003_maintenance.sql"]; delete files["0004_discord_alerts.sql"]; files["0098_maintenance.sql"] = maintenance; files["0099_discord.sql"] = discord; }
  const grant = d1MigrationGrant(identity, row, files)!;
  const session = d1MigrationSession(grant);
  const updating = { ...row, namespace: undefined, providerVersion: 0, status: "updating", old: row };
  delete updating.namespace;
  const columns = ["id", "hash", "created_at", "name", "applied_at"].map((name, i) => ({ name, type: ["INTEGER", "text", "numeric", "text", "TEXT"][i] }));
  const response = (results: unknown) => ({ success: true, result: [{ success: true, results }] });
  const query = (sql: string) => session.request(session.base + "/query", "POST", Buffer.from(JSON.stringify({ sql })), "application/json");
  const start = () => {
    session.state(updating);
    session.request(session.base, "GET", Buffer.alloc(0), "")({ success: true, result: { uuid: identity.databaseId, name: identity.databaseName } });
    query(nativeColumnsSql)(response(columns));
  };
  const history = Object.entries(row.attr.migrationsHashes).map(([name, hash]) => ({ name, hash }));
  return { input, row, identity, files, grant, session, updating, start, history, response, query };
}
describe("closed additive SQLite grammar", () => {
  it("pins exact independent PR108/110 bytes without owning application migrations", () => {
    const sources = JSON.parse(readFileSync(new URL("./fixtures/additive-d1/sources.json", import.meta.url), "utf8"));
    for (const [name, source] of Object.entries(sources) as [string, { sha256: string }][]) {
      const sql = fixtureSql(name); expect(sha256(sql)).toBe(source.sha256); expect(() => validateAdditiveSql(sql)).not.toThrow();
      expect(readFileSync(new URL(`../ledger-migrations/${name}`, import.meta.url), "utf8")).toBe(sql);
    }
  });
  it.each([
    "DROP TABLE reports;", "CREATE TABLE x AS SELECT * FROM reports;", "CREATE TABLE IF NOT EXISTS reports (id INTEGER);",
    "CREATE TABLE x (id INTEGER); INSERT INTO reports (id) VALUES (1);", "CREATE TABLE x (id INTEGER); INSERT INTO x (id) SELECT 1;",
    "CREATE TABLE x (id INTEGER); INSERT OR REPLACE INTO x (id) VALUES (1);", "CREATE TABLE x (id INTEGER); INSERT INTO x (id) VALUES (1),(2);",
    "CREATE TABLE x (id INTEGER); INSERT INTO x (id) VALUES (random());", "CREATE TABLE x (id INTEGER REFERENCES reports(id));",
    "CREATE TABLE x (id INTEGER CHECK (EXISTS(SELECT 1 FROM reports)));", "CREATE TABLE x (id INTEGER DEFAULT (random()));",
    "CREATE TABLE x (id INTEGER); INSERT INTO x (id) VALUES (1); INSERT INTO x (id) VALUES (2);", "CREATE TABLE __alchemy_migrations (id INTEGER);",
    'CREATE TABLE "DROP TABLE reports" (id INTEGER);', "CREATE TABLE x (id INTEGER); /* harmless */ DELETE FROM reports;",
    "CREATE TABLE x (id INTEGER); -- ignored\nUPDATE reports SET id=1;", "CREATE TABLE x (id INTEGER); PRAGMA writable_schema=ON;",
    "CREATE TABLE x (id INTEGER); CREATE TRIGGER t AFTER INSERT ON x BEGIN DELETE FROM reports; END;",
    "CREATE TABLE x (id TEXT DEFAULT 'safe'); DROP TABLE reports; -- '", "CREATE TABLE x (id TEXT DEFAULT 'unterminated);",
    "CRE/* hiding */ATE TABLE x (id INTEGER);", "CREATE TABLE x (id TEXT DEFAULT 'a--> statement-breakpoint b');",
    "CREATE TABLE x (id TEXT); /* unterminated", "CREATE TABLE x (id INTEGER CHECK (other = 1));", "ATTACH DATABASE 'x' AS x;",
    "ALTER TABLE reports ADD COLUMN x TEXT;", "CREATE TABLE x (id INTEGER); ALTER TABLE x RENAME TO reports;",
  ])("refuses unsupported or disguised SQL %s", (sql) => expect(() => validateAdditiveSql(sql)).toThrow("apply blocked"));
  it("keeps quoted semicolons/comment markers as literal data and supports escaped quotes", () => {
    expect(() => validateAdditiveSql("-- comment\nCREATE TABLE x (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'a; -- /* ''quoted'''); INSERT INTO x (id, label) VALUES (1, 'DROP TABLE reports;');")).not.toThrow();
  });
  it("refuses upstream ledger 0002 pending, preserving it unchanged when committed", () => {
    const f = fixture(); expect(f.grant.pending).toEqual(["0003_maintenance.sql", "0004_discord_alerts.sql"]);
    expect(() => validateAdditiveSql(f.files["0002_delivery_phases.sql"] ?? Object.entries(f.files).find(([name]) => name.startsWith("0002"))![1])).toThrow();
    delete f.row.attr.migrationsHashes[Object.keys(f.row.attr.migrationsHashes).find((name) => name.startsWith("0002"))!];
    expect(() => d1MigrationGrant(f.identity, f.row, f.files)).toThrow("apply blocked");
  });
});
describe.each(["prod", "staging"] as const)("%s exact D1 request/history/checkpoint profile", (stage) => {
  it.each(["SupportDB", "SupportLedger"] as const)("binds %s and permits only expected history progression", (fqn) => {
    const f = fixture(stage, fqn); f.start(); f.query(nativeHistorySql)(f.response(f.history));
    for (const sql of f.grant.batches) f.query(sql)(f.response([]));
    expect(f.session.settled()).toBe(false);
    const attr = { ...f.row.attr, migrationsHashes: f.grant.hashes, importHashes: {} };
    f.session.state({ ...f.row, providerVersion: 0, status: "updated", attr });
    expect(f.session.settled()).toBe(true);
    expect(() => f.query(f.grant.batches[0])).toThrow("apply blocked");
  });
  it("changes the approval summary for bytes, filename, count, history or physical target changes", () => {
    const f = fixture(stage), original = migrationSummary([f.grant]).SupportLedger;
    expect(original.count).toBe(2);
    for (const key of ["bytes", "filename", "count", "history", "identity"] as const) {
      const grant = structuredClone(f.grant);
      if (key === "bytes") Object.assign(grant.hashes, { [grant.pending[0]]: sha256(maintenance + "\n") });
      if (key === "filename") Object.assign(grant, { pending: ["0003_other.sql", grant.pending[1]] });
      if (key === "count") Object.assign(grant, { pending: [grant.pending[0]] });
      if (key === "history") Object.assign(grant.initial.attr!.migrationsHashes, { prior: "a".repeat(64) });
      if (key === "identity") Object.assign(grant.identity, { databaseId: "00000000-0000-4000-8000-000000000009" });
      expect(migrationSummary([grant]).SupportLedger.digest).not.toBe(original.digest);
    }
    expect(JSON.stringify(original)).not.toMatch(/CREATE|maintenance|databaseId|instance|open/);
  });
  it.each(["hash", "extra", "missing", "duplicate", "alias"])("rejects %s live history before batch dispatch", (change) => {
    const f = fixture(stage); f.start();
    const history = structuredClone(f.history);
    if (change === "hash") history[0].hash = "bad";
    if (change === "extra") history.push({ name: "unreviewed.sql", hash: "b".repeat(64) });
    if (change === "missing") history.pop();
    if (change === "duplicate") history[1] = history[0];
    if (change === "alias") history[0].name += "/migration.sql";
    expect(() => f.query(nativeHistorySql)(f.response(history))).toThrow("apply blocked");
  });
  it.each(["clone", "importFiles", "readReplication", "primaryLocationHint", "name", "old", "removalPolicy", "hash", "removed", "order"])("rejects changed candidate %s", (change) => {
    const f = fixture(stage);
    if (["clone", "importFiles", "readReplication", "primaryLocationHint", "name"].includes(change)) f.row.props[change] = "changed";
    if (change === "old") f.row.old = f.row;
    if (change === "removalPolicy") f.row.removalPolicy = "destroy";
    if (change === "hash") f.files[Object.keys(f.row.attr.migrationsHashes)[0]] += "\n";
    if (change === "removed") delete f.files[Object.keys(f.row.attr.migrationsHashes)[0]];
    if (change === "order") f.files["0000_earlier.sql"] = "CREATE TABLE earlier (id INTEGER);";
    expect(() => d1MigrationGrant(f.identity, f.row, f.files)).toThrow();
  });
  it.each(["wrongDB", "account", "params", "extraSQL", "changedSQL", "secondFile", "premature", "metadata", "columns", "checkpoint", "oldCheckpoint", "settled"])("rejects %s before ungranted operations", (change) => {
    const f = fixture(stage);
    if (change === "checkpoint") { expect(() => f.session.state({ ...f.updating, removalPolicy: "destroy" })).toThrow(); return; }
    if (change === "oldCheckpoint") { expect(() => f.session.state({ ...f.updating, old: { ...f.row, instanceId: "different" } })).toThrow(); return; }
    f.session.state(f.updating);
    if (change === "metadata") {
      expect(() => f.session.request(f.session.base, "GET", Buffer.alloc(0), "")({ result: { uuid: "other", name: f.identity.databaseName } })).toThrow(); return;
    }
    f.session.request(f.session.base, "GET", Buffer.alloc(0), "")({ result: { uuid: f.identity.databaseId, name: f.identity.databaseName } });
    if (change === "columns") { expect(() => f.query(nativeColumnsSql)(f.response([{ name: "name", type: "text" }]))).toThrow(); return; }
    f.query(nativeColumnsSql)(f.response(["id", "hash", "created_at", "name", "applied_at"].map((name, i) => ({ name, type: ["INTEGER", "text", "numeric", "text", "TEXT"][i] }))));
    if (change === "premature") { expect(() => f.query(f.grant.batches[0])).toThrow(); return; }
    f.query(nativeHistorySql)(f.response(f.history));
    if (change === "settled") { expect(() => f.session.state({ ...f.row, status: "updated", providerVersion: 0 })).toThrow(); return; }
    const path = change === "wrongDB" ? f.session.base.replace(f.identity.databaseId, "other") : change === "account" ? f.session.base.replace(/accounts\/[^/]+/, "accounts/other") : f.session.base;
    const sql = change === "extraSQL" ? f.grant.batches[0] + " DELETE FROM reports;" : change === "changedSQL" ? f.grant.batches[0].replace("open", "held") : change === "secondFile" ? f.grant.batches[1] : f.grant.batches[0];
    const body = { sql, ...(change === "params" ? { params: [] } : {}) };
    expect(() => f.session.request(path + "/query", "POST", Buffer.from(JSON.stringify(body)), "application/json")).toThrow();
  });
  it.each(["checksum", "identity", "old", "adopting"])("rejects changed settled %s after all successful batches", (change) => {
    const f = fixture(stage); f.start(); f.query(nativeHistorySql)(f.response(f.history));
    for (const sql of f.grant.batches) f.query(sql)(f.response([]));
    const attr = { ...f.row.attr, migrationsHashes: { ...f.grant.hashes }, importHashes: {} };
    if (change === "checksum") attr.migrationsHashes[f.grant.pending[0]] = "b".repeat(64);
    if (change === "identity") attr.databaseId = "00000000-0000-4000-8000-000000000009";
    const row = { ...f.row, providerVersion: 0, status: "updated", attr, ...(change === "old" ? { old: null } : {}), ...(change === "adopting" ? { adopting: false } : {}) };
    expect(() => f.session.state(row)).toThrow("apply blocked"); expect(f.session.settled()).toBe(false);
  });
  it("rejects duplicate JSON keys and noncanonical query envelopes", () => {
    for (const encode of [(sql: string) => `{"sql":"DELETE FROM reports;","sql":${JSON.stringify(sql)}}`, (sql: string) => JSON.stringify({ sql }, null, 2)]) {
      const f = fixture(stage); f.start(); f.query(nativeHistorySql)(f.response(f.history));
      expect(() => f.session.request(f.session.base + "/query", "POST", Buffer.from(encode(f.grant.batches[0])), "application/json")).toThrow("apply blocked");
    }
  });
  it("refuses Worker mutation before D1 settles", async () => {
    for (const route of ["subdomain", "schedules"]) {
      const f = fixture(stage), send = vi.fn<typeof fetch>();
      const app = { stage, appId: 1, clientId: "public", slug: stage === "prod" ? "getquick-support" : "getquick-support-staging", fingerprint: "public" };
      const broker = planningApplyBroker({ observer: { ...observer, stage }, discord: discordBinding, stage, worker: "synthetic-worker", stateOrigin: "https://state.invalid", databases: f.input.databases, migrations: [f.grant],
        instances: { Worker: "w", GitHubAppSecret: "a" }, bundle: "b".repeat(64), app }, { cloudflareToken: "FAKE_ONLY", stateBearer: "FAKE_ONLY", cloudflare: send, state: send,
        app: { observer: { ...observer, stage }, discord: discordBinding, provisionDiscord: async () => {}, provisionKey: async () => app, provisionWebhook: async () => {}, check: async () => ({ appId: 1, checkedAt: new Date().toISOString() }) } }, async () => {}, () => {});
      const body = route === "subdomain" ? { enabled: true, previews_enabled: false } : [{ cron: "* * * * *" }];
      await expect(broker.handle({ op: "cloudflare", method: route === "subdomain" ? "POST" : "PUT", url: `https://api.cloudflare.com/client/v4/accounts/${f.row.attr.accountId}/workers/scripts/synthetic-worker/${route}`, contentType: "application/json", body: Buffer.from(JSON.stringify(body)).toString("base64") })).rejects.toThrow("apply blocked");
      expect(send).not.toHaveBeenCalled();
    }
  });
  it.each(["cancel", "expiry", "window", "uncertain"])("poisons whole broker on %s before a subsequent D1 dispatch", async (change) => {
    const f = fixture(stage), send = vi.fn<typeof fetch>(async () => { throw new Error("uncertain query"); });
    const app = { stage, appId: 1, clientId: "public", slug: stage === "prod" ? "getquick-support" : "getquick-support-staging", fingerprint: "public" };
    const guard = vi.fn(async () => { if (change !== "uncertain") throw new Error(change); });
    const broker = planningApplyBroker({ observer: { ...observer, stage }, discord: discordBinding, stage, worker: "synthetic-worker", stateOrigin: "https://state.invalid", databases: f.input.databases, migrations: [f.grant],
      instances: { Worker: "w", GitHubAppSecret: "a" }, bundle: "b".repeat(64), app }, { cloudflareToken: "FAKE_ONLY", stateBearer: "FAKE_ONLY", cloudflare: send, state: send,
      app: { observer: { ...observer, stage }, discord: discordBinding, provisionDiscord: async () => {}, provisionKey: async () => app, provisionWebhook: async () => {}, check: async () => ({ appId: 1, checkedAt: new Date().toISOString() }) } }, guard, () => {});
    const op = { op: "state-set" as const, fqn: "SupportLedger", value: f.updating };
    await expect(broker.handle(op)).rejects.toThrow("apply blocked");
    await expect(broker.handle(op)).rejects.toThrow("apply blocked");
    expect(send).toHaveBeenCalledTimes(change === "uncertain" ? 1 : 0);
  });
});
