// Native fixture creation only: simulated local Apply, never live reconcile.
import { readFileSync, writeSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Provider from "alchemy/Provider";
import * as Plan from "alchemy/Plan";
import * as Apply from "alchemy/Apply";
import { Resource } from "alchemy/Resource";
const Database = Resource<Resource<"Cloudflare.D1Database", Record<string, unknown>, Record<string, unknown>>>("Cloudflare.D1Database");
const Worker = Resource<Resource<"Cloudflare.Worker", Record<string, unknown>, Record<string, unknown>>>("Cloudflare.Worker");
import type { ResourceState } from "alchemy/State/ResourceState";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { encodeState } from "alchemy/State/StateEncoding";
import { Stage } from "alchemy/Stage";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/http/HttpClient";
import { supportStack } from "../../support-stack.ts";
import { GitHubAppSecret } from "../../deploy/github-app-secret.ts";
import { planOffline, type OfflinePlanInput } from "../../deploy/confined-planning-child.ts";
import { acquireHttpSnapshot, refusal, requireEvidence, STACK, ACCOUNT } from "../../deploy/planning-state.ts";

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8")) as OfflinePlanInput;
  const seeds = input.rows![STACK][input.target.stage];
  const memory = await Effect.runPromise(InMemoryService());
  const denied = () => Effect.die(refusal());
  const providers = Layer.mergeAll(
    Provider.succeed(Database, { version: 1, diff: () => Effect.succeed(undefined), read: () => Effect.succeed(undefined), reconcile: ({ id }) => Effect.succeed((seeds[id] as ResourceState).attr!), delete: denied }),
    Provider.succeed(Worker, { version: 1, diff: () => Effect.succeed(undefined), read: () => Effect.succeed(undefined), reconcile: () => Effect.succeed((seeds.Worker as ResourceState).attr!), delete: denied }),
    Provider.succeed(GitHubAppSecret, { diff: () => Effect.succeed(undefined), reconcile: () => Effect.succeed({ ...input.app, checkedAt: "2026-10-27T00:00:00.000Z" }), delete: denied }),
  );
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stack = yield* supportStack(Layer.succeed(State, Effect.succeed(memory)), "planning", { preflight: Effect.void, providers });
    yield* Apply.apply(yield* Plan.make(stack).pipe(Effect.provideContext(stack.services))).pipe(Effect.provideContext(stack.services));
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([])), Effect.provideService(Stage, input.target.stage),
    Effect.provideService(ArtifactStore, createArtifactStore()), Effect.provideService(HttpClient.HttpClient, HttpClient.make(denied)))));
  const target = input.target;
  const listed = await Effect.runPromise(memory.list(target));
  const rows = Object.fromEntries(await Promise.all(listed.map(async (fqn) => [fqn, await Effect.runPromise(memory.get({ ...target, fqn }))])));
  const output = await Effect.runPromise(memory.getOutput(target));
  const wire = (v: unknown) => JSON.parse(JSON.stringify(encodeState(v)));
  let reads = 0;
  // Installed native encoding -> synthetic native HTTP -> strict immutable
  // snapshot. No global fetch, writes, recovery or backend bootstrap.
  const snapshot = await Effect.runPromise(acquireHttpSnapshot({ origin: "https://state.invalid", account: ACCOUNT, script: "synthetic", scriptDigest: "a".repeat(64), protocol: 7, target }, "SYNTHETIC_STATE_CANARY", async (url, init) => {
    requireEvidence(init?.method === "GET" && new URL(String(url)).origin === "https://state.invalid"); reads++;
    const path = new URL(String(url)).pathname;
    const data = path === "/version" ? { version: 7 } : path.endsWith("/stages") ? [target.stage] : path.endsWith("/resources") ? listed : path.endsWith("/replaced-resources") ? [] : path.endsWith("/output") ? output : rows[path.split("/").at(-1)!];
    return Response.json(wire(data));
  }));
  requireEvidence(reads === 9);
  // Bind independently supplied physical identities to native-generated instance IDs.
  const databases = input.databases.map((db) => ({ ...db, instanceId: (rows[db.fqn] as ResourceState).instanceId }));
  const acquired = Object.fromEntries(await Promise.all(listed.map(async (fqn) => [fqn, wire(await Effect.runPromise(snapshot.get({ ...target, fqn })))])));
  const result = await planOffline({ ...input, databases, rows: { [STACK]: { [target.stage]: acquired } }, output: { [STACK]: { [target.stage]: wire(await Effect.runPromise(snapshot.getOutput(target))) } } });
  writeSync(3, JSON.stringify(result));
}
main().catch(() => { writeSync(3, JSON.stringify({ status: "refused" })); process.exitCode = 1; });
