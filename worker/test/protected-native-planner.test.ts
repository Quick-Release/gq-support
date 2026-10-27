import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi, afterEach } from "vitest";
import { retainCandidate, type CandidateBinding } from "../deploy/retained-plan.ts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { protectedPlanningEntry } from "../deploy/planning-entry.ts";
import { Action } from "alchemy/Action";
import type { PersistedState } from "alchemy/State/State";
import * as Plan from "alchemy/Plan";
import { Stage } from "alchemy/Stage";
import { Stack, type StackSpec } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import type { ResourceState, CreatedResourceState } from "alchemy/State/ResourceState";
import { Database, ProviderLive } from "alchemy/Cloudflare/D1";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import { ACCOUNT, STACK, acquireSnapshot, acquireHttpSnapshot, productionEndpointContract, defaultDeploymentGuard, confinedClient, type EndpointContract } from "../deploy/planning-state.ts";
import { validateAdditiveSql, validateNativePlan, type PlanEvidence } from "../deploy/native-plan-policy.ts";

const target = { stack: STACK, stage: "prod" } as const;
const canary = "CONFIDENTIAL_CANARY_DO_NOT_PRINT";
const contract: EndpointContract = {
  origin: "https://state.invalid", account: ACCOUNT, script: "synthetic", scriptDigest: "a".repeat(64), protocol: 7, target,
};
function row(fqn: string): CreatedResourceState {
  return { fqn, logicalId: fqn, instanceId: `instance-${fqn}`, resourceType: "Cloudflare.D1Database",
    namespace: undefined, providerVersion: 1, providerMode: "live", status: "created", downstream: [], bindings: [],
    removalPolicy: "retain", props: { jurisdiction: "eu" },
    attr: { databaseId: fqn === "SupportDB" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002", databaseName: `name-${fqn}`, jurisdiction: "eu", accountId: ACCOUNT, migrationsHashes: {} },
  };
}
const rows = () => ({ SupportDB: row("SupportDB"), SupportLedger: row("SupportLedger") });
const evidence = (): PlanEvidence => ({ target, resolvedAccount: ACCOUNT,
  databases: Object.values(rows()).map((r) => ({ fqn: r.fqn as "SupportDB" | "SupportLedger", instanceId: r.instanceId,
    databaseId: r.attr.databaseId, databaseName: r.attr.databaseName })),
  migrationHashes: { SupportDB: {}, SupportLedger: {} },
});
async function source(initial: Record<string, ResourceState> = rows()) {
  const memory = await Effect.runPromise(InMemoryService({ [STACK]: { prod: initial } }, { [STACK]: { prod: { value: canary } } }));
  return { ...memory, getVersion: () => Effect.succeed(7) };
}
const providerEnvironment = Layer.succeed(CloudflareEnvironment, Effect.succeed({
  type: "apiToken", apiToken: Redacted.make("public-placeholder"), accountId: ACCOUNT, source: { type: "env" },
}));
async function nativePlan(options: { omit?: string; props?: Record<string, unknown>; changed?: string; initial?: Record<string, ResourceState>; action?: boolean; extraState?: PersistedState } = {}) {
  const memory = await source(options.initial);
  if (options.extraState) await Effect.runPromise(memory.set({ ...target, fqn: options.extraState.fqn, value: options.extraState }));
  const stack: StackSpec = { name: STACK, stage: "prod", resources: {}, bindings: {}, actions: {}, output: {} };
  // The installed layer over-approximates requirements with reconcile/delete-only
  // SDK services. Deliberately leave them absent: any accidental mutation dies.
  // @ts-expect-error fixture exercises only native planning and live D1 diff
  return Effect.runPromise(Effect.gen(function* () {
    for (const fqn of ["SupportDB", "SupportLedger"]) {
      if (fqn !== options.omit) yield* Database(fqn, {
        jurisdiction: "eu", ...(fqn === options.changed ? options.props : {}),
      });
    }
    if (options.action) yield* Action("FixtureAction", (_input: { value: number }) => Effect.die(new Error("Planning must not run action body")))({ value: 1 });
    return yield* Plan.make(stack);
  }).pipe(
    Effect.provideService(Stack, stack),
    Effect.provideService(Stage, "prod"),
    Effect.provide(NodeServices.layer),
    Effect.provideService(State, Effect.succeed(memory)),
    Effect.provide(ProviderLive().pipe(Layer.provideMerge(providerEnvironment))),
  ));
}

afterEach(() => vi.restoreAllMocks());
describe("complete immutable acquisition", () => {
  it("has no invented production endpoint attestation", () => expect(productionEndpointContract).toBeUndefined());
  it("captures outputs and every listed row; rejects writes and cross-project references", async () => {
    const live = await source();
    const snapshot = await Effect.runPromise(acquireSnapshot(live, target));
    await Effect.runPromise(live.delete({ ...target, fqn: "SupportDB" }));
    const saved = await Effect.runPromise(snapshot.get({ ...target, fqn: "SupportDB" }));
    expect(saved?.fqn).toBe("SupportDB");
    expect(Object.isFrozen(saved)).toBe(true);
    expect(await Effect.runPromise(snapshot.getOutput(target))).toEqual({ value: canary });
    for (const operation of [snapshot.set({ ...target, fqn: "SupportDB", value: row("SupportDB") }), snapshot.delete(targetWithFqn()),
      snapshot.deleteStack(target), snapshot.setOutput({ ...target, value: {} }), snapshot.getOutput({ ...target, stack: "Other" })]) {
      expect((await Effect.runPromise(operation.pipe(Effect.result)))._tag).toBe("Failure");
    }
  });
  it.each(["vanished", "empty", "unknown-stage", "version", "malformed", "old", "reference"])("rejects %s without sensitive diagnostics", async (failure) => {
    const state = await source();
    if (failure === "vanished") state.get = () => Effect.succeed(undefined);
    if (failure === "empty") state.list = () => Effect.succeed([]);
    if (failure === "unknown-stage") state.listStages = () => Effect.succeed([]);
    if (failure === "version") state.getVersion = () => Effect.succeed(5);
    if (["malformed", "old", "reference"].includes(failure)) {
      state.get = () => Effect.succeed({ ...row("SupportDB"), ...(failure === "old" ? { old: row("SupportDB") } :
        failure === "reference" ? { attr: { _tag: "StackRef", value: canary } } : { status: canary }) } as CreatedResourceState);
    }
    await expect(Effect.runPromise(acquireSnapshot(state, target))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
  });
});
function targetWithFqn() { return { ...target, fqn: "SupportDB" }; }

describe("installed native engine and live D1 provider diffs", () => {
  it("accepts the genuine engine no-op plan for both identities", async () => {
    const plan = await nativePlan();
    expect(plan.resources.SupportDB.action).toBe("noop");
    expect(() => validateNativePlan(plan, evidence())).not.toThrow();
  });
  it("accepts a genuine additive provider update without changing identities", async () => {
    const plan = await nativePlan({ changed: "SupportDB", props: { readReplication: { mode: "auto" } } });
    expect(plan.resources.SupportDB.action).toBe("update");
    expect(() => validateNativePlan(plan, evidence())).not.toThrow();
  });
  for (const fqn of ["SupportDB", "SupportLedger"]) {
    it.each([{ name: "renamed" }, { jurisdiction: "default" }, { primaryLocationHint: "weur" }])(`rejects ${fqn} replacement %j`, async (props) => {
      const plan = await nativePlan({ changed: fqn, props });
      expect(plan.resources[fqn].action).toBe("replace");
      expect(() => validateNativePlan(plan, evidence())).toThrow();
    });
    it(`rejects ${fqn} retained orphan from native engine`, async () => {
      const plan = await nativePlan({ omit: fqn });
      expect(plan.deletions[fqn]?.action).toBe("orphaned");
      expect(() => validateNativePlan(plan, evidence())).toThrow();
    });
    it(`rejects ${fqn} deletion from native engine`, async () => {
      const initial = rows(); initial[fqn as keyof typeof initial].removalPolicy = "destroy";
      const plan = await nativePlan({ omit: fqn, initial });
      expect(plan.deletions[fqn]?.action).toBe("delete");
      expect(() => validateNativePlan(plan, evidence())).toThrow();
    });
    it(`rejects ${fqn} missing prior state and account replacement`, async () => {
      const initial = rows(); delete (initial as Partial<typeof initial>)[fqn as keyof typeof initial];
      // Missing state asks the installed provider to probe ownership. With
      // no HTTP capability that probe fails; acquisition must reject first.
      await expect(nativePlan({ initial })).rejects.toThrow("Service not found: effect/HttpClient");
      const wrong = rows(); wrong[fqn as keyof typeof wrong].attr.accountId = "wrong";
      const replaced = await nativePlan({ initial: wrong });
      expect(replaced.resources[fqn].action).toBe("replace");
      expect(() => validateNativePlan(replaced, evidence())).toThrow();
    });
  }
  it("rejects removal of previously committed migration checksums", async () => {
    const initial = rows(); initial.SupportLedger.attr.migrationsHashes = { "001.sql": "a".repeat(64) };
    const plan = await nativePlan({ initial });
    expect(() => validateNativePlan(plan, evidence())).toThrow();
  });
});

describe("native HTTP acquisition confinement", () => {
  it.each(["ok", "redirect", "error", "malformed"])("confines %s and sanitizes failures", async (outcome) => {
    const bypass = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(canary));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error");
      expect(url.origin).toBe(contract.origin);
      if (outcome === "error") throw new Error(canary);
      if (outcome === "redirect") return new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid" } });
      const data = url.pathname === "/version" ? { version: 7 } : url.pathname.endsWith("/stages") ? ["prod"] :
        url.pathname.endsWith("/replaced-resources") ? [] : url.pathname.endsWith("/resources") ? Object.keys(rows()) :
        url.pathname.endsWith("/output") ? { value: canary } : rows()[url.pathname.split("/").at(-1) as "SupportDB"];
      return new Response(outcome === "malformed" ? canary : JSON.stringify(data), { headers: { "content-type": "application/json" } });
    };
    if (outcome === "ok") await Effect.runPromise(acquireHttpSnapshot(contract, "public-placeholder", transport));
    else await expect(Effect.runPromise(acquireHttpSnapshot(contract, "public-placeholder", transport))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
    expect(requests.length).toBeGreaterThan(0); expect(bypass).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
});


describe("same native plan capability handoff (simulated apply only)", () => {
  const binding: CandidateBinding = { source: "source", lockfiles: "locks", migrations: "migrations", target: "target", state: "state", window: "window", candidate: "candidate" };
  async function candidate() {
    const native = await nativePlan({ changed: "SupportDB", props: { readReplication: { mode: "auto" } } });
    const writer = await source();
    const readonly = await Effect.runPromise(acquireSnapshot(writer, target));
    const stack: StackSpec = { name: STACK, stage: "prod", resources: {}, actions: {}, bindings: {}, output: {} };
    const context = Context.make(State, Effect.succeed(readonly)).pipe(Context.add(Stack, stack), Context.add(Stage, "prod"));
    const reconcile = vi.fn(() => Effect.gen(function* () {
      // This capability must be the writer, despite State in the old session.
      const state = yield* Effect.serviceOption(State);
      if (Option.isNone(state)) return yield* Effect.die(new Error("Missing State"));
      expect(yield* state.value).toBe(writer);
      expect(Option.getOrUndefined(yield* Effect.serviceOption(Stack))).toBe(stack);
      return { ...row("SupportDB").attr, readReplication: { mode: "auto" } };
    }));
    // Only apply's provider is simulated. Planning above used installed live D1 diff.
    native.resources.SupportDB.provider = { ...native.resources.SupportDB.provider, reconcile };
    const snapshot = { native, stack: { name: STACK, stage: "prod" }, session: { context } };
    return { snapshot, writer, reconcile, retained: retainCandidate(snapshot, evidence(), binding) };
  }
  it("uses the exact engine object with original context and explicit State replacement once", async () => {
    const { writer, reconcile, retained } = await candidate();
    const verifier = { revalidate: () => Effect.succeed({ binding, writer }) };
    await Effect.runPromise(retained.apply(verifier));
    expect(reconcile).toHaveBeenCalledOnce();
    await expect(Effect.runPromise(retained.apply(verifier))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
  });
  it.each(Object.keys(binding) as (keyof CandidateBinding)[])("rejects changed %s before simulated apply", async (key) => {
    const { writer, reconcile, retained } = await candidate();
    await expect(Effect.runPromise(retained.apply({ revalidate: () => Effect.succeed({ binding: { ...binding, [key]: "changed" }, writer }) }))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
    expect(reconcile).not.toHaveBeenCalled();
  });
  it.each(["approval", "window", "state"])("rejects unavailable authenticated %s evidence", async () => {
    const { reconcile, retained } = await candidate();
    await expect(Effect.runPromise(retained.apply({ revalidate: () => Effect.die(new Error(canary)) }))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
    expect(reconcile).not.toHaveBeenCalled();
  });
});


describe("forward-only migration fixtures using installed D1 diff", () => {
  it("accepts a real additive migration directory while preserving both identities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-plan-fixture-"));
    const sql = "CREATE TABLE extra_fixture (id INTEGER PRIMARY KEY);";
    try {
      writeFileSync(join(dir, "001_extra.sql"), sql);
      const initial = rows();
      initial.SupportDB.attr.migrationsDir = dir;
      initial.SupportDB.attr.migrationsTable = "__alchemy_migrations";
      const plan = await nativePlan({ initial, changed: "SupportDB", props: { migrations: dir } });
      expect(plan.resources.SupportDB.action).toBe("update");
      const policy = { ...evidence(), migrationHashes: { SupportDB: { "001_extra.sql": createHash("sha256").update(sql).digest("hex") }, SupportLedger: {} },
        migrationFiles: { SupportDB: { dir, files: { "001_extra.sql": sql } } } };
      expect(() => validateNativePlan(plan, policy)).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["DROP TABLE reports;", "DELETE FROM reports;", "ALTER TABLE reports DROP COLUMN text;", "PRAGMA writable_schema=ON;", "CREATE TABLE x AS SELECT * FROM reports;"])("rejects destructive/unknown SQL %s", (sql) => {
    expect(() => validateAdditiveSql(sql)).toThrow();
  });
  for (const fqn of ["SupportDB", "SupportLedger"]) {
    it(`rejects ${fqn} recursive native replacement cleanup`, async () => {
      const initial: Record<string, ResourceState> = rows();
      initial[fqn] = { ...row(fqn), status: "replaced", deleteFirst: false,
        old: { ...row(fqn), status: "replaced", deleteFirst: false, old: row(fqn) } };
      const plan = await nativePlan({ initial });
      expect(plan.resources[fqn].state?.status).toBe("replaced");
      expect(() => validateNativePlan(plan, evidence())).toThrow();
    });
  }
});


describe("transport and candidate tamper boundaries", () => {
  it.each([
    ["GET", "https://elsewhere.invalid/version"],
    ["GET", "https://state.invalid/state/stacks/Other/stages/prod/output"],
    ["GET", "https://state.invalid/state/stacks/GQSupportWorker/stages/staging/output"],
    ["GET", "https://state.invalid/version?token=forbidden"],
    ["GET", "https://state.invalid/state/stacks"],
    ["POST", "https://state.invalid/version"], ["PUT", "https://state.invalid/version"], ["DELETE", "https://state.invalid/version"],
  ] as const)("denies %s %s before sending any credential", async (method, url) => {
    const transport = vi.fn<typeof fetch>();
    const client = confinedClient(contract, transport);
    await expect(Effect.runPromise(client.execute(HttpClientRequest.make(method)(url)))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["", "bad\ncredential", "bad credential"])("rejects malformed credential before requests", async (credential) => {
    const transport = vi.fn<typeof fetch>();
    await expect(Effect.runPromise(acquireHttpSnapshot(contract, credential, transport))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects native plan mutation even when the replacement props would pass policy", async () => {
    const native = await nativePlan({ changed: "SupportDB", props: { readReplication: { mode: "auto" } } });
    const writer = await source();
    const stack: StackSpec = { name: STACK, stage: "prod", resources: {}, bindings: {}, actions: {}, output: {} };
    const context = Context.make(State, Effect.succeed(writer)).pipe(Context.add(Stack, stack), Context.add(Stage, "prod"));
    const retained = retainCandidate({ native, stack: { name: STACK, stage: "prod" }, session: { context } }, evidence(), {
      source: "s", lockfiles: "l", migrations: "m", target: "t", state: "s", window: "w", candidate: "c",
    });
    const node = native.resources.SupportDB;
    if (node.action !== "update") throw new Error("Fixture expected update");
    node.props = { ...node.props, readReplication: { mode: "disabled" } };
    const binding = { source: "s", lockfiles: "l", migrations: "m", target: "t", state: "s", window: "w", candidate: "c" };
    await expect(Effect.runPromise(retained.apply({ revalidate: () => Effect.succeed({ binding, writer }) }))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
  });
});


describe("native action and target rejection", () => {
  it("rejects actual native action execution and deletion tables", async () => {
    const execution = await nativePlan({ action: true });
    expect(execution.actions.FixtureAction.action).toBe("run");
    expect(() => validateNativePlan(execution, evidence())).toThrow();
    const deletion = await nativePlan({ extraState: { kind: "action", actionType: "FixtureAction", fqn: "FixtureAction", logicalId: "FixtureAction", namespace: undefined,
      status: "ran", downstream: [], input: { value: 1 }, inputHash: "a".repeat(64), output: {} } });
    expect(deletion.actionDeletions.FixtureAction?.action).toBe("delete");
    expect(() => validateNativePlan(deletion, evidence())).toThrow();
  });
  it("rejects resolved wrong account and target on a genuine native no-op plan", async () => {
    const native = await nativePlan();
    expect(() => validateNativePlan(native, { ...evidence(), resolvedAccount: "wrong" })).toThrow();
    expect(() => validateNativePlan(native, { ...evidence(), target: Object.assign({}, target, { stack: "Other" }) })).toThrow();
  });
  it("rejects a renamed/missing D1 row before provider ownership lookup", async () => {
    const original = rows();
    const state = await source({ SupportLedger: original.SupportLedger, FormerSupportDB: { ...original.SupportDB, fqn: "FormerSupportDB", logicalId: "FormerSupportDB" } });
    await expect(Effect.runPromise(acquireSnapshot(state, target))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
  });
});


it("production entry refuses before credentials, graph execution or network", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(canary));
  await expect(Effect.runPromise(protectedPlanningEntry("/does-not-exist/private-credential"))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
  expect(fetch).not.toHaveBeenCalled();
});


it.each(["prod", "staging"])("default CLI declaration refuses protected %s apply", async (stage) => {
  await expect(Effect.runPromise(defaultDeploymentGuard(stage))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
});
it("keeps default personal-stage deployment guard behavior", async () => {
  await expect(Effect.runPromise(defaultDeploymentGuard("dev_fixture"))).resolves.toBeUndefined();
});
