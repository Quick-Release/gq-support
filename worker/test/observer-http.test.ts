import { URL } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { observerRequest } from "../src/observer-http.ts";
import { decodeObserverSnapshot } from "../src/observer-snapshot.ts";
import * as Effect from "effect/Effect";
import { emptyPhases, progressIO, startProgress, writeProgress } from "../src/cron-progress.ts";
import { localStage } from "./local-d1.ts";
import { validateSnapshotReview } from "../tools/observer/snapshot-evidence.ts";
import { decodeBatch, evaluate, type Context, type Read } from "../tools/observer/protocol.ts";
const token = randomBytes(32).toString("hex"), candidate = "a".repeat(40);
const env = { SUPPORT_OBSERVER_ENABLED: "true", SUPPORT_OBSERVER_READ_TOKEN: token,
  SUPPORT_OBSERVER_STAGE: "staging", SUPPORT_OBSERVER_RELEASE: candidate,
  SUPPORT_RELEASE_STAGE: "staging", SUPPORT_RELEASE_CANDIDATE: candidate };
const url = "https://support.invalid/internal/observer/v1/snapshot";
const req = (suffix = "", authorization = `Bearer ${token}`) => new Request(url + suffix, { headers: { Authorization: authorization } });
// Node contract tests use the actual Node crypto constant-time implementation.
// A separate workerd test below proves the installed Workers extension works.
const cryptoShim = () => vi.stubGlobal("crypto", { randomUUID: crypto.randomUUID.bind(crypto),
  subtle: { digest: crypto.subtle.digest.bind(crypto.subtle), timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b)) } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("uses the installed workerd timing-safe primitive and never dispatches outbound I/O", async () => {
  const source = ["observer-snapshot", "observer-http"].map(name => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8").replace(/^import .*;$/gm, "")).join("\n");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  let outbound = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-09-16", bindings: env,
    script: `${compiled}\nexport default { async fetch(request, env) {
      let acquired = false;
      const result = await observerRequest(request, env, async () => { acquired = true; throw new Error("binding_canary"); });
      return Response.json({ ...await result.json(), acquired }, { status: result.status });
    } };`,
    outboundService: async () => { outbound++; throw new Error("unexpected network"); } }));
  try {
    const denied = await runtime.dispatchFetch(url, { headers: { Authorization: `Bearer ${randomBytes(32).toString("hex")}` } });
    expect(denied.status).toBe(401); expect(await denied.json()).toMatchObject({ acquired: false });
    const accepted = await runtime.dispatchFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    expect(accepted.status).toBe(503); // passed auth and reached the deliberately unavailable binding
    expect(await accepted.json()).toEqual({ code: "observer_unavailable", acquired: true });
    expect(outbound).toBe(0);
  } finally { await runtime.dispose(); }
});

it.each([
  ["disabled", {}, req(), 404], ["missing secret", { ...env, SUPPORT_OBSERVER_READ_TOKEN: undefined }, req(), 401],
  ["wrong token", env, req("", `Bearer ${randomBytes(32).toString("hex")}`), 401],
  ["short token", env, req("", "Bearer ab"), 401], ["query", env, req("?x=y"), 400], ["empty query", env, req("?"), 400],
  ["cookie", env, new Request(url, { headers: { Cookie: "session=private" } }), 400],
  ["origin", env, new Request(url, { headers: { Origin: "https://other.invalid" } }), 400],
  ["body", env, new Request(url, { method: "POST", body: "private" }), 405],
  ["head", env, new Request(url, { method: "HEAD" }), 405],
] as const)("rejects %s before any ledger access", async (_name, config, request, status) => {
  cryptoShim(); const ledger = vi.fn();
  const result = await observerRequest(request, config, ledger);
  expect(result.status).toBe(status); expect(ledger).not.toHaveBeenCalled();
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect(result.headers.has("set-cookie")).toBe(false); expect(result.headers.has("access-control-allow-origin")).toBe(false);
});
it("fails closed on unsupported crypto and uses the current token/release/stage without warm caches", async () => {
  const ledger = vi.fn(async () => { throw new Error(`gqcanary_${crypto.randomUUID()}`); });
  expect((await observerRequest(req(), env, ledger)).status).toBe(401);
  cryptoShim();
  expect((await observerRequest(req(), env, ledger)).status).toBe(503); expect(ledger).toHaveBeenCalledOnce();
  const rotated = { ...env, SUPPORT_OBSERVER_READ_TOKEN: randomBytes(32).toString("hex") };
  expect((await observerRequest(req(), rotated, ledger)).status).toBe(401);
  expect((await observerRequest(req("", `Bearer ${rotated.SUPPORT_OBSERVER_READ_TOKEN}`), rotated, ledger)).status).toBe(503);
  const calls = ledger.mock.calls.length;
  expect((await observerRequest(req(), { ...env, SUPPORT_OBSERVER_STAGE: "prod" }, ledger)).status).toBe(503);
  expect((await observerRequest(req(), { ...env, SUPPORT_OBSERVER_RELEASE: "b".repeat(40) }, ledger)).status).toBe(503);
  expect(ledger).toHaveBeenCalledTimes(calls);
});
it("bounds a hung binding resolution and hides storage errors", async () => {
  cryptoShim();
  const result = await observerRequest(req(), env, () => new Promise(() => {}));
  expect(result.status).toBe(503); expect(await result.json()).toEqual({ code: "observer_unavailable" });
});
it("returns all 240 cells in one coherent fixed read, preserves overflow/generation, and adapts actual bytes conservatively", async () => {
  cryptoShim(); const stage = await localStage(["ledger"]);
  try {
    const db = stage.databases.ledger, now = Math.floor(Date.now() / 60_000) * 60_000;
    const identity = { stage: "staging" as const, candidate };
    for (let n = 59; n >= 0; n--) {
      const slot = now - n * 60_000;
      for (let a = 0; a < 4; a++) {
        const owner = await startProgress(db, identity, slot, slot + 1);
        await writeProgress(db, owner!, { ...emptyPhases(), delivery: "ok", cleanup: "ok", refresh: "ok", sweep: "ok" }, slot + 2, "settled");
      }
    }
    const calls: number[] = [];
    const query = { prepare: db.prepare.bind(db), batch: <T>(statements: Parameters<typeof db.batch>[0]) => { calls.push(statements.length); return db.batch<T>(statements); } };
    const result = await observerRequest(req(), env, async () => query);
    expect(result.status).toBe(200); expect(calls).toEqual([1]);
    const bytes = new Uint8Array(await result.arrayBuffer()); expect(bytes.byteLength).toBeLessThan(65536);
    const wire = decodeObserverSnapshot(JSON.parse(new TextDecoder().decode(bytes)), Date.now());
    expect(wire.ticks).toHaveLength(240); expect(wire.activation).toBeNull(); expect(wire.coverage).toBe("unknown"); expect(wire.partial).toBe(false);
    const context: Context = { now: wire.generated, stage: "staging", candidate, activation: now - 60 * 60_000, generation: 0,
      account: "8f38791a8c37b182239af2a385ab3c31", expected: [], exclusions: [] };
    const read: Read = { source: "snapshot", observed: 1, at: wire.generated, from: now - 59 * 60_000, to: now,
      account: context.account, stage: context.stage, candidate, generation: 0, status: "ok", coverage: "complete", pages: 1, body: bytes };
    const batchEvidence = decodeBatch(context, [read]); expect(batchEvidence.invalid).toBe(false);
    expect(evaluate(context, batchEvidence).public.classes.find(c => c.class === "cron_start_missing")?.verdict).toBe("unknown");
    // A separately supplied private review grants only narrow record evidence.
    const deployment = "11111111-1111-1111-1111-111111111111", version = "22222222-2222-2222-2222-222222222222";
    const pins = { account: context.account, stage: context.stage, candidate, deployment, version, generation: 0,
      reviewer: "gmarques" as const, record: randomBytes(32).toString("hex") };
    const manifest = new TextEncoder().encode(JSON.stringify({ ...pins, schema: 1, proof: "reviewed_business_activation",
      activatedAt: context.activation, validFrom: now - 5 * 60_000, validTo: wire.generated + 60_000,
      issued: wire.generated, evidenceObserved: wire.generated, observation: read.observed, readAt: read.at,
      snapshotSha256: createHash("sha256").update(bytes).digest("hex"), notification: "disabled", exclusions: [] }));
    const review = validateSnapshotReview(manifest, { ...pins, sha256: createHash("sha256").update(manifest).digest("hex") }, wire.generated);
    const reviewedBatch = decodeBatch(context, [{ ...read, deployment, version }], review);
    const payload = reviewedBatch.evidence[0].payload;
    expect(payload && "claims" in payload && payload.claims).toMatchObject({
      records: { proof: "coherent_ring_read", from: now - 5 * 60_000, to: now, missing: [] },
      notification: "reviewed_disabled", continuity: "unknown",
    });
    // Every real terminal has drain=not_run. Reviewed disabled expectation is
    // truthful metadata, never a conversion of not_run to ok or recovery proof.
    expect(evaluate(context, reviewedBatch).public.classes[3].verdict).toBe("unknown");
    // Real wire failure remains visible, and later unknown/partial cannot recover it.
    const failed = structuredClone(wire); failed.ticks[0][7] = 1;
    const failRead = { ...read, body: new TextEncoder().encode(JSON.stringify(failed)) };
    const incident = evaluate(context, decodeBatch(context, [failRead]));
    expect(incident.public.classes.find(c => c.class === "cron_incomplete")?.verdict).toBe("incident");
    const partial = { ...wire, partial: true };
    expect(evaluate(context, decodeBatch(context, [{ ...read, observed: 2, body: new TextEncoder().encode(JSON.stringify(partial)) }]), incident.state).public.classes.find(c => c.class === "cron_incomplete")?.verdict).toBe("incident");
    await startProgress(db, identity, now, now + 3);
    const overflow = await observerRequest(req(), env, async () => db); expect((await overflow.json() as { partial: boolean }).partial).toBe(true);
    await db.prepare("UPDATE maintenance_control SET generation = 1, mode = 'held'").run();
    const changed = await observerRequest(req(), env, async () => db); expect(await changed.json()).toMatchObject({ generation: 1, maintenance: "held", partial: true });
    const invalid = { ...wire, ticks: [...wire.ticks].reverse() };
    expect(decodeBatch(context, [{ ...read, body: new TextEncoder().encode(JSON.stringify(invalid)) }]).invalid).toBe(true);
    expect(decodeBatch(context, [{ ...read, body: new TextEncoder().encode(JSON.stringify({ ...wire, generation: 1 })) }]).invalid).toBe(true);
    expect(decodeBatch(context, [{ ...read, body: new TextEncoder().encode(JSON.stringify({ ...wire, candidate: "b".repeat(40) })) }]).invalid).toBe(true);
    const staleContext = { ...context, now: context.now + 180_000 };
    expect(evaluate(staleContext, decodeBatch(staleContext, [failRead])).public.classes.find(c => c.class === "cron_incomplete")?.verdict).toBe("unknown");
    const canary = `gqcanary_${crypto.randomUUID()}`;
    await db.prepare("UPDATE cron_progress SET started = ? WHERE cell = 0").bind(canary.repeat(10_000)).run();
    const malformed = await observerRequest(req(), env, async () => db);
    expect(malformed.status).toBe(503); expect(JSON.stringify(await malformed.json())).not.toContain(canary);
    await db.prepare("DROP TABLE cron_progress_control").run();
    const bad = await observerRequest(req(), env, async () => db); expect(bad.status).toBe(503); expect(await bad.json()).toEqual({ code: "observer_unavailable" });
  } finally { await stage.dispose(); }
}, 15_000);
it("enforces exact DTO keys, ordering, enums and finite bounded values", () => {
  const base = { version: 1, generated: 180_000, stage: "staging", candidate, generation: 0, maintenance: "open", watermark: 120_000,
    partial: false, activation: null, coverage: "unknown", route: "disabled", ticks: [] };
  for (const bad of [{ ...base, private: `gqcanary_${crypto.randomUUID()}` }, { ...base, activation: 1 }, { ...base, coverage: "complete" },
    { ...base, generation: Infinity }, { ...base, ticks: [["staging", candidate, 0, 120_000, 1, 120_001, 120_002, 8, 0, 0, 0, 0, 0]] }]) expect(() => decodeObserverSnapshot(bad, 180_000)).toThrow("observer_unavailable");
});
it("keeps the maximum-width 240-cell valid wire budget below 40 KiB without increasing other query limits", () => {
  const generated = Number.MAX_SAFE_INTEGER, watermark = Math.floor(generated / 60_000) * 60_000;
  const ticks = Array.from({ length: 240 }, (_, i) => ["staging", candidate, Number.MAX_SAFE_INTEGER,
    watermark - (59 - Math.floor(i / 4)) * 60_000, i % 4 + 1, generated, generated, 2, 4, 4, 4, 4, 4]);
  const wire = { version: 1, generated, stage: "staging", candidate, generation: Number.MAX_SAFE_INTEGER,
    maintenance: "verified", watermark, partial: true, activation: null, coverage: "unknown", route: "blocked_unknown", ticks };
  expect(decodeObserverSnapshot(wire, generated).ticks).toHaveLength(240);
  expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeLessThan(40 * 1024);
});
it("exposes only finite local alert configuration/control, never provider health or URLs", async () => {
  cryptoShim(); const stage = await localStage(["ledger"]);
  try {
    const config = { ...env, DISCORD_ALERTS_ENABLED: "true", DISCORD_ALERT_RELEASE: candidate,
      DISCORD_ALERT_WEBHOOK_URL: `https://discord.com/api/webhooks/123456789012345678/${"synthetic_".repeat(8)}` };
    const read = async (current = config) => await (await observerRequest(req(), current, async () => stage.databases.ledger)).json();
    expect(await read()).toMatchObject({ route: "ready" });
    const canary = `gqcanary_${crypto.randomUUID()}`;
    expect(await read({ ...config, DISCORD_ALERT_WEBHOOK_URL: canary })).toMatchObject({ route: "blocked_unknown" });
    await stage.databases.ledger.prepare("UPDATE discord_alert_control SET blocked = 1").run();
    expect(await read()).toMatchObject({ route: "blocked_unknown" });
    await stage.databases.ledger.prepare("UPDATE discord_alert_control SET blocked = 0, next_at = ?").bind(Date.now() + 60_000).run();
    expect(await read()).toMatchObject({ route: "rate_limited" });
    expect(await read({ ...config, DISCORD_ALERTS_ENABLED: "false" })).toMatchObject({ route: "disabled" });
    const owner = await startProgress(stage.databases.ledger, { stage: "staging", candidate }, 120_000, 120_001);
    await stage.databases.ledger.prepare("UPDATE cron_progress SET candidate = ? WHERE cell = ?").bind(candidate + "\0" + canary, owner!.cell).run();
    const malformed = await observerRequest(req(), config, async () => stage.databases.ledger);
    expect(malformed.status).toBe(503); expect(await malformed.json()).toEqual({ code: "observer_unavailable" });
  } finally { await stage.dispose(); }
});

it("keeps a heartbeat write timeout/late settlement as an evidence gap, never execution proof", async () => {
  cryptoShim(); const stage = await localStage(["ledger"]);
  let releaseWrite!: () => void;
  const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
  try {
    const db = stage.databases.ledger, now = Math.floor(Date.now() / 60_000) * 60_000;
    let late!: ReturnType<typeof startProgress>;
    const timedOut = await Effect.runPromise(progressIO(() => {
      late = gate.then(() => startProgress(db, { stage: "staging", candidate }, now - 60_000, now - 59_999));
      return late;
    }));
    expect(timedOut).toBeNull();
    const response = await observerRequest(req(), env, async () => db);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const wire = decodeObserverSnapshot(JSON.parse(new TextDecoder().decode(bytes)), Date.now());
    expect(wire.ticks).toEqual([]); expect(wire.partial).toBe(false);
    const context: Context = { now: wire.generated, stage: "staging", candidate, activation: now - 5 * 60_000,
      generation: 0, account: "8f38791a8c37b182239af2a385ab3c31", expected: [], exclusions: [] };
    const pins = { account: context.account, stage: context.stage, candidate, generation: 0,
      deployment: "11111111-1111-1111-1111-111111111111", version: "22222222-2222-2222-2222-222222222222",
      reviewer: "vvaz" as const, record: randomBytes(32).toString("hex") };
    const read: Read = { ...pins, source: "snapshot", observed: 1, at: wire.generated, from: context.activation, to: now,
      status: "ok", coverage: "complete", pages: 1, body: bytes };
    const manifest = new TextEncoder().encode(JSON.stringify({ ...pins, schema: 1, proof: "reviewed_business_activation",
      activatedAt: context.activation, validFrom: context.activation, validTo: wire.generated + 60_000,
      issued: wire.generated, evidenceObserved: wire.generated, observation: read.observed, readAt: read.at,
      snapshotSha256: createHash("sha256").update(bytes).digest("hex"), notification: "disabled", exclusions: [] }));
    const review = validateSnapshotReview(manifest, { ...pins, sha256: createHash("sha256").update(manifest).digest("hex") }, wire.generated);
    const batch = decodeBatch(context, [read], review), payload = batch.evidence[0].payload;
    expect(payload && "claims" in payload && payload.claims).toMatchObject({
      records: { from: context.activation, to: now, missing: Array.from({ length: 5 }, (_, i) => context.activation + i * 60_000) },
      continuity: "unknown",
    });
    expect(evaluate(context, batch).public.classes[2].verdict).toBe("unknown");
    releaseWrite(); await late;
    // The timed-out operation can settle later; its record is not in the attested read.
    const changed = await observerRequest(req(), env, async () => db);
    const lateBytes = new Uint8Array(await changed.arrayBuffer());
    expect(decodeObserverSnapshot(JSON.parse(new TextDecoder().decode(lateBytes)), Date.now()).ticks).toHaveLength(1);
    expect(evaluate(context, decodeBatch(context, [read], review)).public.classes[3].verdict).toBe("unknown");
  } finally { releaseWrite(); await stage.dispose(); }
});
