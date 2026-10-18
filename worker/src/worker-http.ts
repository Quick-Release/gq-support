import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Result from "effect/Result";
import { GITHUB_WEBHOOK_PATH, type GitHubWebhookReceiver } from "./github-webhooks.ts";
import { handleRequest } from "./installation-api.ts";
import type { CredentialDatabase } from "./operator.ts";
import type { RepositoryMapping } from "./repository-mappings.ts";

/** HTTP entry shared by the Alchemy adapter and request-boundary tests. */
export const handleWorkerRequest = <R>(request: HttpServerRequest.HttpServerRequest,
  database: Effect.Effect<CredentialDatabase, never, R>, mappings: readonly RepositoryMapping[], webhook: GitHubWebhookReceiver,
  waitUntil: (task: Promise<void>) => void,
) => Effect.gen(function* () {
  const web = HttpServerRequest.toWebResult(request);
  if (Result.isFailure(web)) return new Response(null, { status: 400 });
  const url = new URL(web.success.url);
  if (url.pathname === GITHUB_WEBHOOK_PATH) {
    if (web.success.method !== "POST" || url.search) return new Response(null, { status: 404 });
    return yield* webhook(web.success, waitUntil);
  }
  const db = yield* database;
  return yield* Effect.promise(() => handleRequest(web.success, db, mappings));
});
