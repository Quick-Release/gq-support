import type { D1Database } from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { digestKey, recordErasure, sweepCleanup } from "../src/cleanup.ts";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway } from "../src/github-gateway.ts";
import { restoreGate } from "../src/ledger.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { suspendRepository } from "../src/repository-suspension.ts";
import type { QueryDatabase } from "../src/storage.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

const START = Date.parse("2026-10-17T10:00:00Z");
const DAY = 86_400_000;
const mapping: RepositoryMapping = { slot: "shop/production", client: "shop", project: "shop", environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
const subject = "00000000-0000-4000-8000-000000000001";

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let installation: Installation;
let github: ReturnType<typeof makeFakeGitHub>;
let now: number;
let key: CryptoKey;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared", "ledger"]);
  key = await digestKey("test App private key");
  installation = await harness(stage.databases.shared, [mapping], { digestKey: key, ledger: stage.databases.ledger })
    .enroll(mapping.slot, "installation-a");
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7 });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const main = () => stage.databases.shared;
const ledger = () => stage.databases.ledger;
const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const accept = async () => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary: "Checkout fails", description: "Private report text" }));
  expect(response.status).toBe(202);
  return (await response.json() as { id: string }).id;
};
const gateway = () => GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer));
const sweep = (db: QueryDatabase = main()) => Effect.runPromise(sweepDelivery({ db, ledger: ledger(), mappings: [mapping],
  botLogin: `${SLUG}[bot]`, now: () => now, random: () => 0 }).pipe(Effect.provide(gateway()), Effect.provide(Logger.layer([]))));
const cleanup = (db: QueryDatabase = main()) => Effect.runPromise(sweepCleanup({ db, ledger: ledger(), botLogin: `${SLUG}[bot]`, mappings: [mapping],
  digestKey: key, now: () => now }).pipe(Effect.provide(gateway()), Effect.provide(Logger.layer([]))));
const posts = () => github.requests.filter((request) => request.method === "POST" && request.path.endsWith("/issues"));
const entry = async (kind: string, reference: string) => (await ledger().prepare("SELECT payload FROM ledger_entry WHERE kind = ? AND reference = ?")
  .bind(kind, reference).first<{ payload: string | null }>()) ?? undefined;
const operator = (...args: string[]) => runOperator(args, {
  query: async (sql, parameters) => (await main().prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
  ledger: async (sql, parameters) => (await ledger().prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
  recordRevocation: async () => {}, mappings: [mapping], now,
});

/** Every main table's rows: what a Time Travel restore brings back. */
const snapshot = async (db: D1Database) => {
  const tables = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'`).all<{ name: string }>()).results.map((row) => row.name);
  return Promise.all(tables.map(async (table) => ({ table, rows: (await db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()).results })));
};
const restore = async (db: D1Database, image: Awaited<ReturnType<typeof snapshot>>) => {
  await db.batch([db.prepare("PRAGMA defer_foreign_keys = ON"),
    ...image.map(({ table }) => db.prepare(`DELETE FROM ${table}`)),
    ...image.flatMap(({ table, rows }) => rows.map((row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")})
      VALUES (${Object.keys(row).map(() => "?").join(", ")})`).bind(...Object.values(row))))]);
};

it("records an erasure in the ledger first, and the ledger alone stops a create", async () => {
  const request = await accept();
  const failing: QueryDatabase = { prepare: main().prepare.bind(main()), batch: async () => { throw new Error("D1 unavailable"); } };
  await expect(recordErasure(failing, mapping.slot, subject, now, key, ledger())).rejects.toThrow();
  expect(await main().prepare("SELECT 1 FROM delivery_suppression").first()).toBeNull();
  expect(await entry("suppression", `request:${request}`)).toEqual({ payload: JSON.stringify({ scope: "request", reference: request, reason: "erasure" }) });
  await sweep();
  expect(posts()).toHaveLength(0);
});

it("a recorded restore replays erasures and suspensions and makes restored work uncertain before anything is served", async () => {
  const delivered = await accept();
  await sweep();
  const pending = await accept();
  const image = await snapshot(main());
  expect((await installation.send("POST", "/v1/erasures", JSON.stringify({ reporter_subject: subject }))).status).toBe(202);
  await cleanup();
  advance(10_000);
  await cleanup();
  expect(github.issues[0]!.body).not.toContain("Private report text");
  await Effect.runPromise(suspendRepository(main(), 42, "public", now, []));
  await cleanup(); // mirrors the suspension
  await restore(main(), image);
  const gate = restoreGate();
  expect(await gate(main(), ledger(), now)).toBe(true); // nothing recorded yet: the ledger cannot tell
  expect(await operator("restore-recorded", "operator-1", "time-travel-restore")).toMatch(/Restore recorded/);
  expect(await restoreGate()(main(), ledger(), now)).toBe(true);
  for (const id of [delivered, pending]) {
    expect(await main().prepare("SELECT 1 FROM delivery_suppression WHERE scope = 'request' AND reference = ?").bind(id).first()).not.toBeNull();
    expect((await installation.send("GET", `/v1/requests/${id}?reporter_subject=${subject}&scope=mine`)).status).toBe(404);
  }
  expect(await main().prepare("SELECT description FROM support_request WHERE id = ?").bind(pending).first("description")).toBe("");
  expect(await main().prepare("SELECT state FROM delivery_intent WHERE request_id = ?").bind(pending).first("state")).toBe("outcome_unknown");
  expect(await main().prepare("SELECT suspended_reason FROM repository_state WHERE repository_id = 42").first("suspended_reason")).toBe("public");
  expect(await main().prepare("SELECT epoch FROM restore_state").first("epoch")).toBe(1);
  await cleanup();
  await sweep();
  expect(posts()).toHaveLength(1);
  expect(await main().prepare("SELECT COUNT(*) AS n FROM support_request").first("n")).toBe(0);
});

it("the mirror never drops an image; compaction records removals, which the ledger keeps 45 days", async () => {
  const request = await accept();
  const erasure = await recordErasure(main(), mapping.slot, subject, now, key, ledger());
  await cleanup();
  expect(JSON.parse((await entry("cleanup", request))!.payload!)).toMatchObject({ state: "resolved", outcome: "purged" });
  await main().prepare("DELETE FROM delivery_suppression").run();
  await cleanup();
  expect((await entry("suppression", `request:${request}`))!.payload).not.toBeNull();
  advance(45 * DAY);
  await cleanup();
  expect(await entry("cleanup", request)).toEqual({ payload: null });
  expect(await entry("erasure", erasure)).toEqual({ payload: null });
  expect(await entry("suppression", `request:${request}`)).toEqual({ payload: null });
  advance(45 * DAY);
  await cleanup();
  expect(await entry("cleanup", request)).toBeUndefined();
});

it("the restore gate fails closed without a recent verdict", async () => {
  const broken = { prepare: () => { throw new Error("ledger unreachable"); }, batch: async () => [] } as unknown as QueryDatabase;
  const gate = restoreGate();
  expect(await gate(main(), broken, now)).toBe(false);
  expect(await gate(main(), ledger(), now)).toBe(true);
  expect(await gate(main(), broken, now + 61_000)).toBe(true);
  expect(await gate(main(), broken, now + 601_000)).toBe(false);
});

it("Operator erasure and offboarding refuse to run without the ledger", async () => {
  await accept();
  const without = (...args: string[]) => runOperator(args, {
    query: async (sql, parameters) => (await main().prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
    recordRevocation: async () => {}, mappings: [mapping], now,
  });
  await expect(without("offboard", mapping.slot, "operator-1")).rejects.toThrow("ledger database is required");
  await expect(without("restore-recorded", "operator-1", "time-travel-restore")).rejects.toThrow("ledger database is required");
  expect(await main().prepare("SELECT COUNT(*) AS n FROM delivery_suppression").first("n")).toBe(0);
  await operator("offboard", mapping.slot, "operator-1");
  expect(await entry("suppression", `slot:${mapping.slot}`)).toEqual({
    payload: JSON.stringify({ scope: "slot", reference: mapping.slot, reason: "offboarding" }) });
});

it("an Operator's lift is recorded, so a later replay does not suspend the repository again", async () => {
  await Effect.runPromise(suspendRepository(main(), 42, "public", now, []));
  await cleanup();
  expect((await entry("suspension", "42"))!.payload).toContain("public");
  advance(1000);
  await main().prepare("UPDATE repository_state SET verified_safe_at = ? WHERE repository_id = 42").bind(now).run();
  expect(await operator("unsuspend", mapping.slot, "operator-1", "verified-private")).toMatch(/Unsuspended/);
  expect(await entry("suspension", "42")).toEqual({ payload: null });
  await cleanup();
  expect(await entry("suspension", "42")).toEqual({ payload: null });
});

it("runtime key revocations survive a restore", async () => {
  const clients = harness(main(), [mapping], { digestKey: key, ledger: ledger() });
  const image = await snapshot(main());
  // Re-enrollment replaces the first key; the site then revokes its new one.
  const replacement = await clients.enroll(mapping.slot, "installation-b");
  expect((await replacement.send("DELETE", "/v1/installation")).status).toBe(200);
  for (const revoked of [installation.keyId, replacement.keyId]) {
    expect(JSON.parse((await entry("revocation", revoked))!.payload!)).toMatchObject({ key_id: revoked, revoked_at: now });
  }
  await restore(main(), image);
  expect((await installation.send("GET", "/v1/installation")).status).toBe(200); // the restore revived the old key
  await operator("restore-recorded", "operator-1", "time-travel-restore");
  expect(await restoreGate()(main(), ledger(), now)).toBe(true);
  expect((await installation.send("GET", "/v1/installation")).status).toBe(403);
});

it("mirrors changes incrementally, and every row in the daily full pass", async () => {
  await cleanup(); // the first pass is a full one
  const request = await accept();
  await recordErasure(main(), mapping.slot, subject, now, key, null); // no ledger write: only the mirror can carry it
  // A writer that leaves changed_at at its default is invisible to the incremental pass.
  await main().prepare("INSERT INTO delivery_suppression (scope, reference, reason) VALUES ('slot', 'other/production', 'offboarding')").run();
  advance(60_000);
  await cleanup();
  expect(JSON.parse((await entry("cleanup", request))!.payload!)).toMatchObject({ state: "resolved" });
  expect(await entry("suppression", `request:${request}`)).toBeDefined();
  expect(await entry("suppression", "slot:other/production")).toBeUndefined();
  advance(DAY);
  await cleanup();
  expect(await entry("suppression", "slot:other/production")).toBeDefined();
});

it("a claimed cleanup record's lease reaches the ledger, even when its pass dies before finishing", async () => {
  const request = await accept();
  github.onCreate((issue) => { issue.deleted = true; return new Response(null, { status: 502 }); });
  await sweep();
  await recordErasure(main(), mapping.slot, subject, now, key, ledger());
  await cleanup(); // captured: reconciling, scheduled a minute later
  // A provider cooldown holds the record while a later pass moves the mirror past its last change.
  await main().prepare(`INSERT INTO delivery_permit (installation_id, owner, drain_until, next_mutation_at, provider_cooldown_until)
    VALUES (7, '', 0, 0, ?1) ON CONFLICT (installation_id) DO UPDATE SET provider_cooldown_until = ?1`).bind(now + 3_600_000).run();
  advance(1_800_000);
  await cleanup();
  advance(1_800_000);
  // The pass claims the record, then every batch fails, so its own finish is lost.
  await cleanup({ prepare: main().prepare.bind(main()), batch: async () => { throw new Error("D1 unavailable"); } });
  const claimed = await main().prepare("SELECT next_attempt_at FROM support_cleanup WHERE request_id = ?").bind(request).first<number>("next_attempt_at");
  expect(claimed).toBe(now + 60_000);
  expect(JSON.parse((await entry("cleanup", request))!.payload!)).toMatchObject({ state: "reconciling", next_attempt_at: claimed });
});
