import { randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorkerBundle } from "alchemy/Cloudflare/Workers/Sources/Rolldown";
import { getCompatibility } from "alchemy/Cloudflare/Workers/Compatibility";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { expect, it } from "vitest";
import { workerCompatibility } from "../src/worker-compatibility.ts";
import { decodeObserverSnapshot } from "../src/observer-snapshot.ts";
import { migrate, LEDGER_MIGRATIONS_DIR } from "./local-d1.ts";
import { startProgress, writeProgress, emptyPhases } from "../src/cron-progress.ts";

const candidate = "a".repeat(40), token = randomBytes(32).toString("hex");
const root = "https://support.invalid", snapshot = `${root}/internal/observer/v1/snapshot`;
const headers = { Authorization: `Bearer ${token}` };
const bindings = { SUPPORT_OBSERVER_ENABLED: "true", SUPPORT_OBSERVER_READ_TOKEN: token,
  SUPPORT_RELEASE_STAGE: "staging", SUPPORT_RELEASE_CANDIDATE: candidate,
  SUPPORT_OBSERVER_STAGE: "staging", SUPPORT_OBSERVER_RELEASE: candidate };
const compatibility = getCompatibility({ main: new URL("../src/worker.ts", import.meta.url).href, compatibility: workerCompatibility });
async function build(main: string, kind: "effect" | "external") {
  const bundle = await Effect.runPromise(Effect.gen(function* () {
    const builder = yield* WorkerBundle;
    return yield* builder.build({ id: "Worker", main: new URL(main, import.meta.url).href,
      compatibility, entry: kind === "effect" ? { kind, exports: {} } : { kind },
      stack: { name: "GQSupportWorker", stage: "staging" }, extraOptions: undefined });
  }).pipe(Effect.provide(NodeServices.layer)));
  return bundle.files.filter(f => f.path.endsWith(".js")).map(f => ({ type: "ESModule" as const, path: f.path, contents: f.content }));
}

it("runs configured-date auth, binding-free readiness and rejects an older-date fallback", async () => {
  let outbound = 0;
  const modules = await build("./fixtures/configured-boundaries.ts", "external");
  const mf = new Miniflare(convertV4MiniflareOptions({ modules, compatibilityDate: compatibility.date,
    compatibilityFlags: compatibility.flags, bindings,
    outboundService: () => { outbound++; throw new Error("outbound forbidden"); } }));
  try {
    // This runs inside workerd. It fails if the harness silently selects the old fixture date.
    const requireConfiguredSemantics = async () => {
      const response = await mf.dispatchFetch(`${root}/runtime-date-probe`);
      if (await response.json() !== true) throw new Error("configured-date fallback refused");
    };
    await requireConfiguredSemantics();
    const wrong = await mf.dispatchFetch(snapshot, { headers: { Authorization: `Bearer ${randomBytes(32).toString("hex")}` } });
    expect(wrong.status).toBe(401); expect(wrong.headers.get("x-test-ledger-acquisitions")).toBe("0");
    const accepted = await mf.dispatchFetch(snapshot, { headers });
    expect(accepted.status).toBe(503); expect(accepted.headers.get("x-test-ledger-acquisitions")).toBe("1");
    expect(await accepted.json()).toEqual({ code: "observer_unavailable" });
    const ready = await mf.dispatchFetch(`${root}/internal/observer/v1/readiness`);
    expect(ready.status).toBe(200); expect(ready.headers.get("x-test-ledger-acquisitions")).toBe("0");
    expect(await ready.json()).toEqual({ version: 1, check: "route_runtime", result: "available" });
    // Executed negative control, never a skip: same new binary, deliberately old date.
    await mf.setOptions(convertV4MiniflareOptions({ modules, compatibilityDate: "2026-09-16", bindings }));
    await expect(requireConfiguredSemantics()).rejects.toThrow("configured-date fallback refused");
    expect(outbound).toBe(0);
  } finally { await mf.dispose(); }
}, 60_000);

it("runs the actual configured Alchemy Worker with missing bindings then coherent local D1 and containment", async () => {
  const modules = await build("../src/worker.ts", "effect");
  let outbound = 0;
  const options = { modules, compatibilityDate: compatibility.date, compatibilityFlags: compatibility.flags,
    outboundService: () => { outbound++; throw new Error("outbound forbidden"); } };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  try {
    // No observer env, D1, App key, or support configuration is provided.
    const ready = await mf.dispatchFetch(`${root}/internal/observer/v1/readiness`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ version: 1, check: "route_runtime", result: "available" });
    await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings,
      d1Databases: ["SupportDB", "SupportLedger"] }));
    const db = await mf.getD1Database("SupportDB") as unknown as D1Database;
    const ledger = await mf.getD1Database("SupportLedger") as unknown as D1Database;
    await migrate(db); await migrate(ledger, LEDGER_MIGRATIONS_DIR);
    const open = await mf.dispatchFetch(`${root}/v1/requests`);
    expect(open.status).toBe(403); await open.text();
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    let late: Awaited<ReturnType<typeof startProgress>> = null;
    for (let minute = now - 59 * 60_000; minute <= now; minute += 60_000) {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const owner = await startProgress(ledger, { stage: "staging", candidate }, minute, minute + attempt);
        if (!owner) throw new Error("local progress fixture could not acquire owner");
        if (minute === now && attempt === 4) late = owner;
        else await writeProgress(ledger, owner, { ...emptyPhases(), delivery: "ok", cleanup: "ok", refresh: "ok", sweep: "ok" }, minute + 5, "settled");
      }
    }
    const response = await mf.dispatchFetch(snapshot, { headers });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    const bytes = await response.text(); expect(new TextEncoder().encode(bytes).byteLength).toBeLessThan(65536);
    const wire = decodeObserverSnapshot(JSON.parse(bytes), Date.now());
    expect(wire).toMatchObject({ stage: "staging", candidate, generation: 0, maintenance: "open", partial: false,
      activation: null, coverage: "unknown", route: "disabled" });
    expect(wire.ticks).toHaveLength(240);
    expect(wire.ticks[0]).toEqual(["staging", candidate, 0, now - 59 * 60_000, 1, now - 59 * 60_000 + 1, now - 59 * 60_000 + 5, 0, 1, 1, 1, 1, 0]);
    expect(wire.ticks[239]).toEqual(["staging", candidate, 0, now, 4, now + 4, null, null, 0, 0, 0, 0, 0]);
    // An uncompleted owner cannot later write across a maintenance generation.
    await ledger.prepare("UPDATE maintenance_control SET generation = 1, mode = 'held'").run();
    await expect(writeProgress(ledger, late!, emptyPhases(), now + 3, "settled")).rejects.toThrow("progress unavailable");
    const held = await mf.dispatchFetch(snapshot, { headers });
    expect(held.status).toBe(200); expect(await held.json()).toMatchObject({ generation: 1, maintenance: "held" });
    const contained = await mf.dispatchFetch(`${root}/v1/requests`);
    expect(contained.status).toBe(503); expect(await contained.json()).toEqual({ code: "service_unavailable" });
    // Corrupt local aggregate data must fail closed without leaking it.
    const canary = `gqcanary_${crypto.randomUUID()}`;
    await ledger.prepare("UPDATE cron_progress SET candidate = ?").bind(canary).run();
    const malformed = await mf.dispatchFetch(snapshot, { headers });
    expect(malformed.status).toBe(503); expect(await malformed.json()).toEqual({ code: "observer_unavailable" });
    expect(outbound).toBe(0);
  } finally { await mf.dispose(); }
}, 60_000);
