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
      Effect.provide(Layer.mergeAll(GitHubGateway.live(config), GitHubReader.live(config))),
    ));
    expect(result).toEqual({ delivery: "ok", cleanup: "failed", refresh: "ok", sweep: "ok" });
  } finally { await stage.dispose(); }
});
