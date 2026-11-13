// The durable databases' removal policy, under the pinned Alchemy's own evaluation and planner:
// the real SupportDB and SupportLedger declarations per stage, and a replacement of a resource
// carrying the same policy, with in-memory state and a fake provider (no credential or network).
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { evalStack } from "alchemy/EvalStack";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { durable, SupportDB, SupportLedger } from "../src/support-db.ts";

const policies = async (stage: string) => {
  const state = inMemoryState();
  const stack = Alchemy.Stack("GQSupportWorker", { providers: Cloudflare.providers(), state }, Effect.gen(function* () {
    yield* SupportDB;
    yield* SupportLedger;
    return {};
  }));
  // The stack's own state and providers satisfy the rest at runtime; its type still lists them.
  const evaluated = evalStack(stack as never, (stack) => Effect.succeed(stack), { stage }) as Effect.Effect<unknown, unknown>;
  const compiled = await Effect.runPromise(evaluated.pipe(Effect.provide(Alchemist.layer()))) as
    { resources: Record<string, { RemovalPolicy: string }> };
  return { SupportDB: compiled.resources.SupportDB!.RemovalPolicy, SupportLedger: compiled.resources.SupportLedger!.RemovalPolicy };
};

type FakeDatabase = Resource<"Test.D1", { jurisdiction: string }, { databaseId: string }>;
const FakeDatabase = Resource<FakeDatabase>("Test.D1");

/** Deploys a fake database with the durable policy on `stage`, then plans a jurisdiction change, which replaces it. */
const replanAfterReplace = (stage: string) => {
  const state = inMemoryState();
  const deleted: string[] = [];
  const providers = Provider.succeed(FakeDatabase, {
    stables: ["databaseId"],
    diff: ({ olds, news }) => Effect.succeed(olds?.jurisdiction !== (news as { jurisdiction?: string } | undefined)?.jurisdiction
      ? { action: "replace" as const } : undefined),
    reconcile: ({ news }) => Effect.succeed({ databaseId: `db-${news?.jurisdiction}` }),
    delete: ({ output }) => Effect.sync(() => { deleted.push(output.databaseId); }),
    read: ({ output }) => Effect.succeed(output),
    list: () => Effect.succeed([]),
  });
  const deploy = (jurisdiction: string) => Effect.runPromise(Effect.gen(function* () {
    const stack = Alchemy.Stack("RemovalPolicy", { providers, state }, Effect.gen(function* () {
      yield* FakeDatabase("SupportDB", { jurisdiction }).pipe(durable(stage));
      return {};
    }));
    return yield* Alchemist.apply(yield* Alchemist.plan({ stack, stage, operation: "deploy" }));
  }).pipe(Effect.scoped, Effect.provide(Alchemist.layer())));
  return { deleted, deploy };
};

describe("the durable databases' removal policy", () => {
  it.each(["prod", "staging"])("protects SupportDB and SupportLedger on %s", async (stage) => {
    expect(await policies(stage)).toEqual({ SupportDB: "protect", SupportLedger: "protect" });
  });

  it("lets a development stage destroy its databases", async () => {
    expect(await policies("dev_removal_policy")).toEqual({ SupportDB: "destroy", SupportLedger: "destroy" });
  });

  it.each(["prod", "staging"])("refuses, before applying anything, a plan that replaces the database on %s", async (stage) => {
    const { deleted, deploy } = replanAfterReplace(stage);
    await deploy("eu");
    await expect(deploy("default")).rejects.toThrow(/protected by RemovalPolicy\.protect\(\)/);
    expect(deleted).toEqual([]);
  });

  it("replaces a development stage's database", async () => {
    const { deleted, deploy } = replanAfterReplace("dev_removal_policy");
    await deploy("eu");
    await deploy("default");
    expect(deleted).toEqual(["db-eu"]);
  });
});
