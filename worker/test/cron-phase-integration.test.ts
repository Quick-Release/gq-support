import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import { localStage } from "./local-d1.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";

it("reports real cleanup's isolated storage failure without hiding later phase outcomes", async () => {
  const stage = await localStage(["main"]);
  try {
    await stage.databases.main.prepare("DROP TABLE support_cleanup").run();
    const config = { clientId: "synthetic", slug: "synthetic", privateKeyPem: "synthetic" };
    const result = await Effect.runPromise(scheduledTick({ db: stage.databases.main, mappings: [], botLogin: "synthetic" }).pipe(
      Effect.provideService(MinimumLogLevel, "None"),
      Effect.provide(Layer.mergeAll(GitHubGateway.live(config), GitHubReader.live(config))),
    ));
    expect(result).toEqual({ delivery: "ok", cleanup: "failed", refresh: "ok", sweep: "ok" });
  } finally { await stage.dispose(); }
});

it("records only cleanup discovery failure and continues later scheduler phases", async () => {
  const stage = await localStage(["main"]);
  const raw = stage.databases.main;
  let dueFailures = 0;
  const db = { batch: raw.batch.bind(raw), prepare: (sql: string) => {
    if (sql.includes("FROM support_cleanup") && sql.includes("ORDER BY next_attempt_at, request_id LIMIT 8")) {
      dueFailures++;
      throw new Error("synthetic due discovery failure");
    }
    return raw.prepare(sql);
  } };
  try {
    const config = { clientId: "synthetic", slug: "synthetic", privateKeyPem: "synthetic" };
    const result = await Effect.runPromise(scheduledTick({ db, mappings: [], botLogin: "synthetic" }).pipe(
      Effect.provideService(MinimumLogLevel, "None"),
      Effect.provide(Layer.mergeAll(GitHubGateway.live(config), GitHubReader.live(config))),
    ));
    expect(dueFailures).toBe(1);
    expect(result).toEqual({ delivery: "ok", cleanup: "failed", refresh: "ok", sweep: "ok" });
  } finally { await stage.dispose(); }
});
