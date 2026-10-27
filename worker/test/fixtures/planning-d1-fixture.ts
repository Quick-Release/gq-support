import { discord, observer } from "./discord-custody.ts";
// Real shared graph/Plan/Apply/providers and native StateEncoding, fully offline.
// SQLite implements the supported SQL subset; fake HTTP never opens a socket.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, cpSync, mkdtempSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { StateService } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { planOffline } from "../../deploy/confined-planning-child.ts";
import { retainCandidate } from "../../deploy/retained-plan.ts";
import { planningApplyCapability } from "../../deploy/planning-apply-capability.ts";
import type { BrokerOperation } from "../../deploy/retained-child-channel.ts";
import { planningApplyBroker } from "../../deploy/planning-apply-broker.ts";
import { d1MigrationGrant, sha256, migrationSummary } from "../../deploy/d1-migration-profile.ts";
import { confinedInput } from "./confined-input.ts";
import { requireEvidence, STACK } from "../../deploy/planning-state.ts";

async function main() {
  const { stage, selected, fault, enabled = false } = JSON.parse(readFileSync(0, "utf8")) as { stage: "prod" | "staging"; selected: "SupportDB" | "SupportLedger" | "both"; fault?: string; enabled?: boolean };
  const binding = { ...discord, enabled };
  // A main-only update requires the integrated ledger already current. Ledger
  // transition cases deliberately start before 0003/0004 instead.
  const input = confinedInput(stage, selected === "SupportDB" ? "current" : "before-maintenance"), rows = input.rows[STACK][stage];
  const root = mkdtempSync("/tmp/d1-profile-");
  for (const dir of ["migrations", "ledger-migrations"]) cpSync(dir, join(root, dir), { recursive: true });
  const dbs = new Map<string, DatabaseSync>();
  const selectedFqns = ["SupportDB", "SupportLedger"] as const;
  const files: Record<string, Record<string, string>> = {};
  for (const fqn of selectedFqns) {
    const row = rows[fqn], db = new DatabaseSync(":memory:"); dbs.set(row.attr.databaseId, db);
    // The existing application history (including ledger 0002) is applied only
    // to a synthetic SQLite runtime. No deployed history is asserted.
    const dir = row.props.migrations;
    const prior = Object.keys(row.attr.migrationsHashes).sort();
    for (const name of prior) db.exec(readFileSync(`${dir}/${name}`, "utf8"));
    db.exec('CREATE TABLE "__alchemy_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT);');
    for (const name of prior) db.prepare('INSERT INTO "__alchemy_migrations" (hash, name) VALUES (?, ?)').run(row.attr.migrationsHashes[name], name);
    db.exec("CREATE TABLE existing_canary (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO existing_canary VALUES (1, 'preserved');");
    files[fqn] = Object.fromEntries(prior.map((name) => [name, readFileSync(`${dir}/${name}`, "utf8")]));
    if (selected === "both" || selected === fqn) {
      const additions = fqn === "SupportLedger" ? ["0003_maintenance.sql", "0004_discord_alerts.sql", "0005_cron_progress.sql"] : ["0099_extra.sql"];
      for (const name of additions) {
        const sql = fqn === "SupportLedger" ? readFileSync(name === "0005_cron_progress.sql" ? `ledger-migrations/${name}` : `test/fixtures/additive-d1/${name}.fixture`, "utf8") : "CREATE TABLE support_extra (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'fresh'); INSERT INTO support_extra (id) VALUES (1);\n";
        writeFileSync(join(root, dir, name), sql); files[fqn][name] = sql;
      }
    }
  }
  const grants = input.databases.flatMap((identity) => {
    const grant = d1MigrationGrant(identity, JSON.parse(JSON.stringify(rows[identity.fqn])), files[identity.fqn]); return grant ? [grant] : [];
  });
  const app = { stage, appId: 123, clientId: "public-client", slug: stage === "prod" ? "getquick-support" : "getquick-support-staging", fingerprint: "public-fingerprint" };
  const state: Record<string, unknown>[] = [];
  let queries = 0, batches = 0, open = true;
  let broker: ReturnType<typeof planningApplyBroker>;
  const createBroker = (bundle: string) => planningApplyBroker({ observer: { ...observer, stage }, discord: binding, stage, worker: rows.Worker.attr.workerName, stateOrigin: "https://state.invalid", databases: input.databases, migrations: grants,
    instances: { Worker: rows.Worker.instanceId, GitHubAppSecret: rows.GitHubAppSecret.instanceId }, app, bundle }, {
    cloudflareToken: "FAKE_ONLY", stateBearer: "FAKE_ONLY", app: { observer: { ...observer, stage }, discord: binding, provisionDiscord: async () => {}, provisionKey: async () => app, provisionWebhook: async () => {}, check: async () => ({ appId: app.appId, checkedAt: new Date().toISOString() }) },
    state: async (_url, init) => { state.push(JSON.parse(String(init?.body))); return Response.json({}); },
    cloudflare: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const identity = input.databases.find((identity) => path.includes(identity.databaseId));
      let result: unknown;
      if (identity && init?.method === "GET") result = { uuid: identity.databaseId, name: identity.databaseName, read_replication: { mode: "disabled" } };
      else if (identity && path.endsWith("/query")) {
        queries++; const db = dbs.get(identity.databaseId)!, sql = JSON.parse(String(init?.body)).sql as string;
        const write = sql.includes('INSERT INTO "__alchemy_migrations"');
        if (write) {
          batches++;
          // Faithful supported SQLite statements, with an intentional partial
          // execution fault to prove uncertainty does not authorize a replay.
          if (fault === "partial") { db.exec(sql.slice(0, sql.indexOf("INSERT INTO maintenance_control"))); throw new Error("uncertain partial query"); }
          db.exec(sql);
          if (fault === "unknown") throw new Error("query applied but response lost");
          if (fault === "cancel") { open = false; broker.close(); }
          if (fault === "expiry" || fault === "window") open = false;
          result = [{ success: true, results: [] }];
        } else result = [{ success: true, results: db.prepare(sql).all().map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value]))) }];
      } else if (path.endsWith("/settings")) result = { bindings: [], tags: [], observability: { issues: { enabled: false } } };
      else if (path.endsWith("/subdomain")) result = path.includes("/scripts/") ? { enabled: true, previews_enabled: false } : { subdomain: "synthetic" };
      else if (path.endsWith("/schedules")) result = { schedules: [{ cron: "* * * * *" }] };
      else if (init?.method === "PUT" && path.endsWith(rows.Worker.attr.workerName)) result = { id: rows.Worker.attr.workerName, tag: "1".repeat(32) };
      else throw new Error("ungranted fixture route");
      return Response.json({ success: true, result });
    },
  }, async () => { requireEvidence(open); }, () => { requireEvidence(open); });

  // Match the real private channel's serialized request/response drain.
  let chain = Promise.resolve<unknown>(null);
  const send = (operation: Exclude<BrokerOperation, { op: "authorize" }>) => {
    const result = chain.then(() => broker.handle(operation)); chain = result.catch(() => null); return result;
  };
  const capability = planningApplyCapability();
  const client = HttpClient.make((req, url) => Effect.promise(async () => {
    capability.check();
    let body: Buffer<ArrayBufferLike> = Buffer.alloc(0), contentType = req.headers["content-type"] ?? "";
    if (req.body._tag === "Uint8Array") body = Buffer.from(req.body.body);
    else if (req.body._tag === "FormData") {
      const response = new Response(req.body.formData); body = Buffer.from(await response.arrayBuffer()); contentType = response.headers.get("content-type")!;
    } else requireEvidence(req.body._tag === "Empty");
    const response = await send({ op: "cloudflare", url: String(url), method: req.method, body: body.toString("base64"), contentType }) as { body: string };
    return HttpClientResponse.fromWeb(req, new Response(Buffer.from(response.body, "base64"), { headers: { "content-type": "application/json" } }));
  }));
  process.chdir(root);
  let applied = false, replayBlocked = false;
  try {
    await planOffline({ ...input, app, release: discord.release }, { capability, client, custody: {
      provisionKey: async () => await send({ op: "app-key", worker: rows.Worker.attr.workerName }) as typeof app,
      provisionDiscord: async (worker) => { await send({ op: "app-discord", worker }); },
      provisionWebhook: async (worker, appId) => { await send({ op: "app-webhook", worker, appId }); },
      check: async (metadata, worker) => await send({ op: "app-check", worker, metadata }) as { appId: number; checkedAt: string },
    }, retain: async (native, context, evidence, snapshot, _summary, bundle, checkBundle) => {
      requireEvidence(JSON.stringify(migrationSummary(grants)) === JSON.stringify(migrationSummary(evidence.databases.flatMap((identity) => {
        if (native.resources[identity.fqn].action !== "update") return [];
        const grant = d1MigrationGrant(identity, native.resources[identity.fqn].state!, evidence.migrationFiles![identity.fqn].files); requireEvidence(grant); return [grant];
      }))));
      broker = createBroker(bundle); await checkBundle();
      const binding = { source: sha256("source"), lockfiles: sha256("locks"), migrations: sha256("migrations"), target: stage, state: "state", window: "window", candidate: "candidate" };
      const retained = retainCandidate({ native, stack: { name: STACK, stage }, session: { context } }, evidence, binding);
      const wire = (value: unknown) => JSON.parse(JSON.stringify(encodeState(value)));
      const writer: StateService = { ...snapshot,
        set: (request) => Effect.promise(async () => { await send({ op: "state-set", fqn: request.fqn, value: wire(request.value) }); return request.value; }),
        setOutput: (request) => Effect.promise(async () => { await send({ op: "state-output", value: wire(request.value) }); return request.value; }),
      };
      const verifier = { revalidate: () => Effect.succeed({ binding, writer }) };
      try { await Effect.runPromise(capability.run(retained.apply(verifier))); applied = true; }
      finally { try { await Effect.runPromise(capability.run(retained.apply(verifier))); } catch { replayBlocked = true; } }
    } });
  } catch { requireEvidence(fault); }
  requireEvidence(replayBlocked && (fault ? !applied && batches === 1 && !state.some((row) => row.workerName) : applied && broker!.outcome().completed));
  const proofs = input.databases.map((identity) => {
    const db = dbs.get(identity.databaseId)!;
    requireEvidence(db.prepare("SELECT value FROM existing_canary WHERE id = 1").get()?.value === "preserved");
    const history = db.prepare('SELECT name, hash FROM "__alchemy_migrations" ORDER BY id').all();
    const prior = rows[identity.fqn].attr.migrationsHashes;
    requireEvidence(history.slice(0, Object.keys(prior).length).every((row) => row.hash === prior[String(row.name)]));
    if (!fault && (selected === identity.fqn || selected === "both")) {
      requireEvidence(history.length === Object.keys(files[identity.fqn]).length && history.every((row) => row.hash === sha256(files[identity.fqn][String(row.name)])));
      if (identity.fqn === "SupportLedger") {
        requireEvidence(db.prepare("SELECT mode, generation FROM maintenance_control WHERE id = 1").get()?.mode === "open" &&
          db.prepare("SELECT blocked FROM discord_alert_control WHERE id = 1").get()?.blocked === 0);
      } else requireEvidence(db.prepare("SELECT label FROM support_extra WHERE id = 1").get()?.label === "fresh");
    }
    return { target: identity.fqn, history: history.length, unchanged: true };
  });
  requireEvidence(!fault || !state.some((row) => row.status === "updated"));
  writeSync(3, JSON.stringify({ applied, replayBlocked, queries, batches, proofs, completed: broker!.outcome().completed }));
}
main().catch(() => { process.exitCode = 1; });
