import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { exclusiveLocalWindow } from "../deploy/planner-evidence.ts";
import { planningApplyCapability } from "../deploy/planning-apply-capability.ts";
import * as Effect from "effect/Effect";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gq-lease-test-")); dirs.push(dir);
  const path = join(dir, "lock"); let now = 1000;
  const window = { id: "a".repeat(64), startsAt: 1000, expiresAt: 2000, duty: "exclude-every-state-writer-and-endpoint-deployer" as const };
  return { path, window, now: () => now, expire: () => { now = 2000; } };
}
describe("local writer exclusion and irreversible phase gate", () => {
  it("excludes another acquisition and never steals a stale lock", () => {
    const f = fixture(); const first = exclusiveLocalWindow(f.path, f.window, f.now);
    expect(() => exclusiveLocalWindow(f.path, f.window, f.now)).toThrow(); first.check(); first.close();
    const next = exclusiveLocalWindow(f.path, f.window, f.now); next.close();
  });
  it("invalidates expired or replaced lease evidence", () => {
    const f = fixture(); const first = exclusiveLocalWindow(f.path, f.window, f.now); f.expire();
    expect(first.check).toThrow(); expect(first.close).toThrow();
    const g = fixture(); const other = exclusiveLocalWindow(g.path, g.window, g.now);
    unlinkSync(g.path); writeFileSync(g.path, "", { mode: 0o600 });
    expect(other.check).toThrow(); expect(other.close).toThrow();
  });
  it("refuses pre-approval reconcile, revokes on partial failure and cannot replay", async () => {
    const gate = planningApplyCapability(); expect(gate.check).toThrow();
    let calls = 0;
    const operation = Effect.sync(() => { gate.check(); calls++; throw new Error("SYNTHETIC_PARTIAL_FAILURE"); });
    await expect(Effect.runPromise(gate.run(operation))).rejects.toThrow(); expect(calls).toBe(1);
    expect(gate.check).toThrow(); await expect(Effect.runPromise(gate.run(operation))).rejects.toThrow(); expect(calls).toBe(1);
  });
});
