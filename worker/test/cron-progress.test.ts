import { expect, it } from "vitest";
import { localStage } from "./local-d1.ts";
import { emptyPhases, startProgress, writeProgress } from "../src/cron-progress.ts";
const identity = { stage: "staging" as const, candidate: "a".repeat(40) };
it("allocates concurrent bounded attempts, preserves finished evidence and reports overflow", async () => {
  const stage = await localStage(["ledger"]);
  try {
    const db = stage.databases.ledger, now = 120_000;
    const owners = await Promise.all(Array.from({ length: 4 }, () => startProgress(db, identity, now, now + 1)));
    expect(owners.map(x => x?.attempt).sort()).toEqual([1, 2, 3, 4]);
    expect(await startProgress(db, identity, now, now + 2)).toBeNull();
    const phases = { ...emptyPhases(), delivery: "failed" as const };
    await writeProgress(db, owners[0]!, phases, now + 3, "settled");
    await expect(writeProgress(db, owners[0]!, emptyPhases())).rejects.toThrow();
    expect(await db.prepare("SELECT partial FROM cron_progress_control").first()).toEqual({ partial: 1 });
    expect(await db.prepare("SELECT delivery FROM cron_progress WHERE attempt = ?").bind(owners[0]!.attempt).first()).toEqual({ delivery: "failed" });
    for (let m = 3; m <= 63; m++) await startProgress(db, identity, m * 60_000, m * 60_000);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM cron_progress").first())?.n).toBeLessThanOrEqual(240);
    await expect(writeProgress(db, owners[1]!, phases)).rejects.toThrow();
    expect(await startProgress(db, identity, now, now)).toBeNull();
  } finally { await stage.dispose(); }
});
it("cannot rewind phases or cross a restore maintenance generation", async () => {
  const stage = await localStage(["ledger"]);
  try {
    const db = stage.databases.ledger;
    const owner = (await startProgress(db, identity, 120_000, 120_001))!;
    await writeProgress(db, owner, { ...emptyPhases(), delivery: "failed" });
    await writeProgress(db, owner, emptyPhases());
    expect(await db.prepare("SELECT delivery FROM cron_progress").first()).toEqual({ delivery: "failed" });
    await db.prepare("UPDATE maintenance_control SET generation = generation + 1").run();
    await expect(writeProgress(db, owner, emptyPhases(), 120_002, "settled")).rejects.toThrow();
    expect(await db.prepare("SELECT terminal FROM cron_progress").first()).toEqual({ terminal: null });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM maintenance_operation").first()).toEqual({ n: 0 });
  } finally { await stage.dispose(); }
});

it("refuses unsupported stage/candidate metadata rather than persisting arbitrary dimensions", async () => {
  const stage = await localStage(["ledger"]);
  try {
    const candidate = `gqcanary_${crypto.randomUUID()}`;
    expect(await startProgress(stage.databases.ledger, { ...identity, candidate }, 120_000, 120_001)).toBeNull();
    expect((await stage.databases.ledger.prepare("SELECT * FROM cron_progress").all()).results).toEqual([]);
  } finally { await stage.dispose(); }
});
