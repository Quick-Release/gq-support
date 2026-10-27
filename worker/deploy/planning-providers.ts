// Pinned beta.83 providers only: no auth/profile/state backend/local-mode layer.
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "alchemy/Provider";
import type { ResourceLike, ResourceClassLike } from "alchemy/Resource";
import { Worker } from "alchemy/Cloudflare/Workers/Worker";
import { Database, ProviderLive } from "alchemy/Cloudflare/D1";
import { LiveWorkerProvider } from "alchemy/Cloudflare/Workers/WorkerProvider";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import { Credentials } from "alchemy/Cloudflare";
import { GitHubAppSecret, GitHubAppSecretProvider } from "./github-app-secret.ts";
import { ACCOUNT, refusal } from "./planning-state.ts";

// Preserve installed diff/stables/version exactly; no other lifecycle can run.
function diffOnly<R extends ResourceLike, Req>(resource: ResourceClassLike<R>, live: Layer.Layer<Provider.Provider<R>, never, Req>) {
  const denied = () => Effect.die(refusal());
  return Provider.effect(resource, Effect.map(resource.Provider, (provider) => ({
    version: provider.version, stables: provider.stables, diff: provider.diff,
    read: denied, list: denied, precreate: denied, reconcile: denied, delete: denied,
  }))).pipe(Layer.provide(live));
}

export const planningProviders = () => Layer.mergeAll(
  diffOnly(Database, ProviderLive()), diffOnly(Worker, LiveWorkerProvider()),
  diffOnly(GitHubAppSecret, GitHubAppSecretProvider()),
).pipe(Layer.provideMerge(Layer.mergeAll(
  Layer.succeed(CloudflareEnvironment, Effect.succeed({
    type: "apiToken", accountId: ACCOUNT, apiToken: Redacted.make("unusable-planning-placeholder"), source: { type: "env" },
  })),
  // SDK operations must never acquire a real token, even on a new code path.
  Layer.succeed(Credentials, Effect.die(refusal())),
)));
