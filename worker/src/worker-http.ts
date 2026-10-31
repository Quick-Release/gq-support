import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Result from "effect/Result";
import { GITHUB_WEBHOOK_PATH, type GitHubWebhookReceiver, type StatusWebhookConfig } from "./github-webhooks.ts";
import { handleRequest, type InstallationApiOptions, type Observation } from "./installation-api.ts";
import { mappingFor } from "./repository-mappings.ts";
import { recordMetric, type MetricEvent } from "./operational-metrics.ts";
import type { CredentialDatabase } from "./operator.ts";
import { handleOperationsRequest, NO_OPERATIONS_ACCESS, type OperationsAccess } from "./operations-api.ts";
import type { Destination } from "./notifications.ts";
import type { StageInventory } from "./inventory.ts";
import type { RepositoryMapping } from "./repository-mappings.ts";
import type { QueryDatabase } from "./storage.ts";

/** HTTP entry shared by the Alchemy adapter and request-boundary tests. */
export const handleWorkerRequest = <R>(request: HttpServerRequest.HttpServerRequest,
  database: Effect.Effect<CredentialDatabase, never, R>, mappings: readonly RepositoryMapping[], webhook: GitHubWebhookReceiver,
  waitUntil: (task: Promise<void>) => void, status?: StatusWebhookConfig, installation: InstallationApiOptions = {},
  operations: OperationsAccess = NO_OPERATIONS_ACCESS, notifications: readonly Destination[] = [],
  inventory: StageInventory | null = null,
) => Effect.gen(function* () {
  const web = HttpServerRequest.toWebResult(request);
  if (Result.isFailure(web)) return new Response(null, { status: 400 });
  const url = new URL(web.success.url);
  if (url.pathname === GITHUB_WEBHOOK_PATH) {
    if (web.success.method !== "POST" || url.search) return new Response(null, { status: 404 });
    return yield* webhook(web.success, waitUntil, status);
  }
  const db = yield* database;
  // Staff dashboards only; the installation API never answers here.
  if (url.pathname === "/v1/operations" || url.pathname.startsWith("/v1/operations/")) {
    return yield* Effect.promise(() => handleOperationsRequest(web.success, db, operations, Date.now(), notifications,
      { mappings, inventory }));
  }
  let observed: Observation | undefined;
  const started = Date.now();
  const response = yield* Effect.promise(() => handleRequest(web.success, db, mappings,
    { ...installation, observe: (observation) => { observed = observation; } }));
  // Aggregate measurements, written in the background: intake never waits for, or fails with, them.
  // A Client only for a verified credential; refusals only by bounded reason.
  const mutation = web.success.method === "POST" && /^\/v1\/requests(?:\/[^/]+\/status)?$/.test(url.pathname);
  const measure = (event: MetricEvent, client?: string, durationMs?: number) => waitUntil(recordMetric(db as QueryDatabase, event,
    { at: Date.now(), ...(client ? { client } : {}), ...(durationMs === undefined ? {} : { durationMs }) }));
  if (observed && "rejected" in observed) measure({ metric: "auth", outcome: observed.rejected });
  if (mutation) {
    const verified = observed && "slot" in observed ? mappingFor(mappings, observed.slot)?.client : undefined;
    measure({ metric: "intake", outcome: response.status < 300 ? "acknowledged" : response.status < 500 ? "rejected" : "failed" },
      verified, Date.now() - started);
  }
  // Only the service's successful mutation receipt enters telemetry. Never use
  // request bodies, URLs, headers or authentication Request IDs as annotations.
  const operation = url.pathname.endsWith("/status") ? "status" : "create";
  if (mutation && (response.status === 201 || response.status === 202 || (operation === "status" && response.status === 200))) {
    const receipt = (yield* Effect.promise(() => response.clone().json())) as {
      id: string; delivery: string; status_change: { delivery: string } | null;
    };
    const annotations = { event: "support.receipt", request: receipt.id,
      operation, delivery: operation === "status" ? receipt.status_change!.delivery : receipt.delivery };
    yield* Effect.logInfo("Support receipt returned").pipe(Effect.annotateLogs(annotations),
      Effect.withSpan("support.receipt", { attributes: annotations }));
  }
  return response;
});
