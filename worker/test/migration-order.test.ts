// Migration order under Alchemy's own plan and apply engine (the pinned alchemy
// version), with in-memory state and fake providers shaped like D1 (stable
// `databaseId`, `migrationsHashes` set by reconcile) and the Worker.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import { evalStack } from "alchemy/Stack";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Core from "alchemy/Test/Core";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { MIGRATED_SCHEMA_BINDING, migratedSchema } from "../src/migration-order.ts";
import { SupportDB, SupportLedger } from "../src/support-db.ts";
import Worker from "../src/worker.ts";

type FakeDatabase = Resource<"Test.D1", { migrations: string[] }, { databaseId: string; migrationsHashes: Record<string, string> }>;
const FakeDatabase = Resource<FakeDatabase>("Test.D1");
type FakeWorker = Resource<"Test.Worker", { code: string; databaseId: string; ledgerId: string }, { workerName: string; schema?: string }, { name: string; text: string }>;
const FakeWorker = Resource<FakeWorker>("Test.Worker");

interface World {
  events: string[];
  /** Database logical IDs whose next migration run fails. */
  failing: Set<string>;
}

const providers = (world: World) => Layer.mergeAll(
  Provider.succeed(FakeDatabase, {
    stables: ["databaseId"],
    reconcile: ({ id, news, output }) => Effect.gen(function* () {
      world.events.push(`${id}:migrating`);
      // Migrations take a while: anything unordered starts in this window.
      yield* Effect.sleep("30 millis");
      if (world.failing.has(id)) {
        world.events.push(`${id}:failed`);
        return yield* Effect.die(new Error(`${id} migration failed`));
      }
      world.events.push(`${id}:migrated`);
      return {
        databaseId: output?.databaseId ?? `${id}-id`,
        migrationsHashes: Object.fromEntries((news?.migrations ?? []).map((name) => [name, `hash-${name}`])),
      };
    }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
    list: () => Effect.succeed([]),
  }),
  Provider.succeed(FakeWorker, {
    stables: ["workerName"],
    reconcile: ({ bindings }) => Effect.sync(() => {
      const schema = bindings.map(({ data }) => data).find((binding) => binding.name === MIGRATED_SCHEMA_BINDING)?.text;
      world.events.push(`Worker:published:${schema ?? "unordered"}`);
      return { workerName: "worker", schema };
    }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
    list: () => Effect.succeed([]),
  }),
);

/** Plans and applies the fake stack at `migrations` with `ordered` (migratedSchema) or the bare stable-ID bindings. */
const deployer = (world: World) => {
  const state = inMemoryState();
  return (migrations: { main: string[]; ledger: string[] }, ordered: boolean) => {
    const stack = Alchemy.Stack("MigrationOrder", { providers: providers(world), state }, Effect.gen(function* () {
      const database = yield* FakeDatabase("SupportDB", { migrations: migrations.main });
      const ledger = yield* FakeDatabase("SupportLedger", { migrations: migrations.ledger });
      // Each release changes the script, as every real deployment of new code does.
      const worker = yield* FakeWorker("Worker", {
        code: `release-${migrations.main.length}`,
        databaseId: database.databaseId,
        ledgerId: ledger.databaseId,
      });
      // The binding src/worker.ts registers on the real Worker.
      if (ordered) yield* worker.bind`${MIGRATED_SCHEMA_BINDING}`({ name: MIGRATED_SCHEMA_BINDING, text: migratedSchema(database, ledger) });
      return { workerName: worker.workerName };
    }));
    const options = { providers: Layer.empty as never, state, stage: "test" };
    return Core.run(Core.deploy(options, stack as never, { stage: "test" }) as never, options);
  };
};

const BEFORE = { main: ["0019_status_change_intents.sql"], ledger: ["0002_revocations.sql"] };
const AFTER = { main: [...BEFORE.main, "0031_offboarding_retention.sql"], ledger: [...BEFORE.ledger, "0004_offboarding.sql"] };

/** A deployed stage at BEFORE, with its event log cleared. */
async function deployedStage(ordered: boolean) {
  const world: World = { events: [], failing: new Set() };
  const deploy = deployer(world);
  await deploy(BEFORE, ordered);
  world.events.length = 0;
  return { world, deploy };
}

const index = (events: string[], event: string) => {
  const at = events.indexOf(event);
  expect(at, `${event} in ${events.join(" ")}`).toBeGreaterThanOrEqual(0);
  return at;
};

describe("migration order under Alchemy's plan and apply", () => {
  it("publishes a Worker bound only by stable database IDs before its migrations finish (the defect)", async () => {
    const { world, deploy } = await deployedStage(false);
    await deploy(AFTER, false);
    const published = world.events.findIndex((event) => event.startsWith("Worker:published"));
    expect(published).toBeGreaterThanOrEqual(0);
    expect(published).toBeLessThan(index(world.events, "SupportDB:migrated"));
  });

  it("publishes the Worker only after both the main database and the ledger finished migrating", async () => {
    const { world, deploy } = await deployedStage(true);
    await deploy(AFTER, true);
    const published = index(world.events, "Worker:published:2:0031_offboarding_retention.sql,2:0004_offboarding.sql");
    expect(published).toBeGreaterThan(index(world.events, "SupportDB:migrated"));
    expect(published).toBeGreaterThan(index(world.events, "SupportLedger:migrated"));
  });

  it.each(["SupportDB", "SupportLedger"])("keeps the old Worker, and its cron, when the %s migration fails", async (failing) => {
    const { world, deploy } = await deployedStage(true);
    world.failing.add(failing);
    await expect(deploy(AFTER, true)).rejects.toThrow();
    index(world.events, `${failing}:failed`);
    expect(world.events.filter((event) => event.startsWith("Worker:published"))).toEqual([]);
  });
});

describe("the Support Worker's migration order", () => {
  it("binds the migrated schema of both SupportDB and SupportLedger, which the D1 bindings alone do not wait for", async () => {
    // Evaluates the real Worker declaration offline: no plan, provider call or credential.
    const state = inMemoryState();
    const stack = Alchemy.Stack("GQSupportWorker", { providers: Cloudflare.providers(), state }, Effect.gen(function* () {
      yield* SupportDB;
      yield* SupportLedger;
      yield* Worker;
      return {};
    }));
    const options = { providers: Layer.empty as never, state, stage: "dev_migration_order" };
    const compiled = await Core.run(evalStack(stack as never, (stack) => Effect.succeed(stack), { stage: options.stage }) as never, options) as
      { bindings: Record<string, ReadonlyArray<{ data: { bindings?: ReadonlyArray<Record<string, unknown>> } }>> };
    const bindings = compiled.bindings.Worker!.flatMap(({ data }) => data.bindings ?? []);
    const schema = bindings.filter((binding) => binding.name === MIGRATED_SCHEMA_BINDING);
    expect(schema).toHaveLength(1);
    expect(schema[0]!.type).toBe("plain_text");
    expect(Output.isExpr(schema[0]!.text)).toBe(true);
    expect(Object.keys(Output.resolveUpstream(schema[0]!.text)).sort()).toEqual(["SupportDB", "SupportLedger"]);
    // The D1 bindings carry only stable IDs: alone, they would let the Worker upload during migrations.
    expect(bindings.filter((binding) => binding.type === "d1").map((binding) => binding.name).sort()).toEqual(["SupportDB", "SupportLedger"]);
  });
});
