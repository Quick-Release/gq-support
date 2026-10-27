import "./planning-runtime-guard.mjs";
// Private worker of planning-execution.ts. No CLI/deploy/session/auth bootstrap.
// Native plan and context stay here; only a fixed public summary leaves fd 3.
import { planningBundleDigest } from "./planning-bundle.ts";
import { pathToFileURL } from "node:url";
import { readFileSync, writeSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";
import * as Option from "effect/Option";
import type { PlanEvidence } from "./native-plan-policy.ts";
import type { PlanningApplyCapability } from "./planning-apply-capability.ts";
import type { AppSecretCustody } from "./github-app-secret.ts";
import { type StateService, State } from "alchemy/State/State";
import type { Stack } from "alchemy/Stack";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/http/HttpClient";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { WorkerBundle } from "alchemy/Cloudflare/Workers/Sources/Rolldown";
import { getCompatibility } from "alchemy/Cloudflare/Workers/Compatibility";
import { Artifacts, makeScopedArtifacts, cached } from "alchemy/Artifacts";
import { Stage } from "alchemy/Stage";
import * as Plan from "alchemy/Plan";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { supportStack } from "../support-stack.ts";
import { planningProviders } from "./planning-providers.ts";
import { acquireSnapshot, snapshotLayer, refusal, requireEvidence, STACK, ACCOUNT } from "./planning-state.ts";
import { wireJson } from "./planning-read.ts";
import { validateNativePlan, type DatabaseIdentity } from "./native-plan-policy.ts";

export interface OfflinePlanInput {
  databases: readonly DatabaseIdentity[];
  rows: Parameters<typeof InMemoryService>[0];
  output: Parameters<typeof InMemoryService>[1];
  app: { stage: string; appId: number; slug: string; clientId: string; fingerprint: string };
}
export interface OfflineContinuation {
  capability: PlanningApplyCapability;
  custody: AppSecretCustody;
  client: HttpClient.HttpClient;
  retain: (plan: Plan.Plan, context: Context.Context<State | Stack | Stage>, evidence: PlanEvidence, snapshot: StateService,
    summary: Readonly<Record<string, string>>, bundle: string, checkBundle: () => Promise<void>) => Promise<void>;
}
export async function planOffline(input: OfflinePlanInput, continuation?: OfflineContinuation) {
  requireEvidence(input.app?.stage === "prod" && input.app.slug === "getquick-support" &&
    Number.isSafeInteger(input.app.appId) && input.app.appId > 0 && /^[A-Za-z0-9_.-]+$/.test(input.app.clientId) &&
    typeof input.app.fingerprint === "string" && input.app.fingerprint.length > 0);
  const memory = await Effect.runPromise(InMemoryService(input.rows, input.output));
  const snapshot = await Effect.runPromise(acquireSnapshot({ ...memory, getVersion: () => Effect.succeed(7) }, { stack: STACK, stage: "prod" }));
  const required = { SupportDB: "Cloudflare.D1Database", SupportLedger: "Cloudflare.D1Database", Worker: "Cloudflare.Worker", GitHubAppSecret: "GQSupport.GitHubAppSecret" };
  requireEvidence((await Effect.runPromise(snapshot.list({ stack: STACK, stage: "prod" }))).slice().sort().join() === Object.keys(required).sort().join());
  for (const [fqn, type] of Object.entries(required)) {
    const row = await Effect.runPromise(snapshot.get({ stack: STACK, stage: "prod", fqn }));
    requireEvidence(row && row.kind !== "action" && row.resourceType === type);
  }
  const files = (dir: string) => Object.fromEntries(readdirSync(dir).filter((name) => name.endsWith(".sql")).map((name) => [name, readFileSync(`${dir}/${name}`, "utf8")]));
  const migrationFiles = { SupportDB: { dir: "./migrations", files: files("./migrations") }, SupportLedger: { dir: "./ledger-migrations", files: files("./ledger-migrations") } };
  const hashes = Object.fromEntries(Object.entries(migrationFiles).map(([fqn, { files }]) => [fqn, Object.fromEntries(Object.entries(files).map(([name, sql]) => [name, createHash("sha256").update(sql).digest("hex")]))]));
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stack = yield* supportStack(snapshotLayer(snapshot), "planning", {
      preflight: Effect.void, // Trusted launcher completed verifyApp before creating this process.
      providers: planningProviders(continuation?.capability, continuation?.custody),
    });
    // Build even when the provider's metadata comparison could short-circuit.
    // The actual installed build consumes the shared declaration's entry/exports.
    const props = stack.resources.Worker.Props;
    requireEvidence(typeof props.main === "string" && !props.vite && !props.source && !props.build && !props.preview && !props.version);
    const bundler = yield* WorkerBundle;
    const store = yield* ArtifactStore;
    const bundle = yield* bundler.build({ id: "Worker", main: props.main, compatibility: getCompatibility(props),
      entry: { kind: "effect", exports: props.exports ?? {} }, stack: { name: stack.name, stage: stack.stage }, extraOptions: undefined,
    }).pipe(cached("build"), Effect.provideContext(stack.services), Effect.provideService(Artifacts, makeScopedArtifacts(store, "Worker")));
    requireEvidence(typeof bundle.hash === "string" && bundle.hash.length > 0);
    const originalState = yield* Effect.serviceOption(State).pipe(Effect.provideContext(stack.services));
    requireEvidence(Option.isSome(originalState));
    const { plan, context } = yield* Effect.gen(function* () {
      // Capture the actual complete service context used by Plan.make, while
      // its scope is alive. Reuse its exact service values for continuation.
      const context = yield* Effect.context<State | Stack | Stage>();
      const plan = yield* Plan.make(stack);
      return { plan, context };
    }).pipe(Effect.provideContext(stack.services), Effect.provideService(State, originalState.value));
    const evidence: PlanEvidence = { target: { stack: STACK, stage: "prod" }, resolvedAccount: ACCOUNT, databases: input.databases, migrationFiles, migrationHashes: hashes };
    validateNativePlan(plan, evidence);
    requireEvidence(Object.keys(plan.resources).sort().join() === "GitHubAppSecret,SupportDB,SupportLedger,Worker");
    const summary = Object.fromEntries(Object.entries(plan.resources).map(([fqn, node]) => [fqn, node.action]));
    if (continuation) {
      const compiledDigest = planningBundleDigest(bundle.files[0].path, bundle.files.map((file) => [file.path, file.content]));
      const checkBundle = async () => {
        const retainedBuild = await Effect.runPromise(makeScopedArtifacts(store, "Worker").get<typeof bundle>("build"));
        requireEvidence(retainedBuild === bundle && planningBundleDigest(bundle.files[0].path, bundle.files.map((file) => [file.path, file.content])) === compiledDigest);
      };
      yield* Effect.promise(() => continuation.retain(plan, context, evidence, snapshot, summary, compiledDigest, checkBundle));
    }
    return summary;
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide(Logger.layer([])),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {
      GITHUB_APP_CLIENT_ID: input.app.clientId, GITHUB_APP_SLUG: input.app.slug, GITHUB_APP_ID: String(input.app.appId),
    } }))),
    Effect.provideService(Stage, "prod"),
    Effect.provideService(ArtifactStore, createArtifactStore()),
    Effect.provideService(AlchemyContext, { dotAlchemy: "/tmp/alchemy", dev: false, adopt: false, updateStateStore: false }),
    Effect.provideService(HttpClient.HttpClient, continuation?.client ?? HttpClient.make(() => Effect.die(refusal()))),
  )));
  return { status: "planned", resources: result };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  planOffline(wireJson(readFileSync(0)) as OfflinePlanInput).then(
    (summary) => { writeSync(3, JSON.stringify(summary)); },
    () => { writeSync(3, JSON.stringify({ status: "refused" })); process.exitCode = 1; },
  );
}
