import { createRequire } from "node:module";
import { writeSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Database } from "alchemy/Cloudflare/D1";
import { Worker } from "alchemy/Cloudflare/Workers/Worker";
import { Stack } from "alchemy/Stack";
import { planningProviders } from "../../deploy/planning-providers.ts";
import { GitHubAppSecret } from "../../deploy/github-app-secret.ts";
import { refusal } from "../../deploy/planning-state.ts";
const requireAlchemy = createRequire(import.meta.resolve("alchemy"));
const d1 = await import(requireAlchemy.resolve("@distilled.cloud/cloudflare/d1"));
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const failures = [];
  for (const resource of [Database, Worker, GitHubAppSecret]) {
    const provider = yield* resource.Provider;
    for (const op of ["read", "list", "precreate", "reconcile", "delete"]) {
      const exit = yield* provider[op]().pipe(Effect.exit);
      failures.push(exit._tag === "Failure");
    }
    failures.push(provider.tail === undefined && provider.logs === undefined && provider.modes === undefined);
  }
  const client = yield* HttpClient.HttpClient;
  const exit = yield* client.execute(HttpClientRequest.post("https://api.cloudflare.com/client/v4/accounts/synthetic/d1/database/synthetic/query")).pipe(Effect.exit);
  failures.push(exit._tag === "Failure");
  const sdk = yield* d1.queryDatabase({ accountId: "8f38791a8c37b182239af2a385ab3c31", databaseId: "00000000-0000-4000-8000-000000000001", sql: "SELECT 1" }).pipe(Effect.exit);
  failures.push(sdk._tag === "Failure");
  return failures;
}).pipe(
  Effect.provide(planningProviders()), Effect.provide(NodeServices.layer),
  Effect.provideService(Stack, { name: "GQSupportWorker", stage: "prod", resources: {}, bindings: {}, actions: {} }),
  Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die(refusal()))),
)));
writeSync(3, JSON.stringify({ denied: result }));
