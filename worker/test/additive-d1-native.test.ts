import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { runOfflineModule } from "../deploy/planning-execution.ts";
const repo = fileURLToPath(new URL("../../", import.meta.url));
describe.each(["prod", "staging"] as const)("%s installed shared graph additive D1 reconcile in offline namespace", (stage) => {
  it.each(["SupportDB", "SupportLedger", "both"])("applies %s independently, preserving original rows, identities and checksums", async (selected) => {
    const result = JSON.parse(await runOfflineModule(repo, "test/fixtures/planning-d1-fixture.ts", { stage, selected }));
    expect(result).toMatchObject({ applied: true, replayBlocked: true, completed: true });
    expect(result.batches).toBe(selected === "both" ? 3 : selected === "SupportLedger" ? 2 : 1);
    expect(result.proofs).toHaveLength(2);
  }, 90_000);
  it.each(["unknown", "partial", "cancel", "expiry", "window"])("stops all subsequent SQL/checkpoints/Worker writes on %s and cannot replay", async (fault) => {
    const result = JSON.parse(await runOfflineModule(repo, "test/fixtures/planning-d1-fixture.ts", { stage, selected: "SupportLedger", fault }));
    expect(result).toMatchObject({ applied: false, replayBlocked: true, completed: false, batches: 1 });
  }, 90_000);
});
