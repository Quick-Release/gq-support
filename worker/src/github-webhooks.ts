import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import { applyLifecycleChange, lifecycleChange } from "./lifecycle-webhooks.ts";
import type { RepositoryMapping } from "./repository-mappings.ts";
import type { QueryDatabase } from "./storage.ts";
import { requestStatusRefresh } from "./status-refresh.ts";

export const GITHUB_WEBHOOK_PATH = "/v1/github/webhooks";
// Over 13x the largest measured staging issue payload; see the webhook runbook.
export const GITHUB_WEBHOOK_BODY_BYTES = 1024 * 1024;
export const webhookRejections = Metric.counter("github_webhook_rejections_total");

interface WebhookConfig {
  readonly appId: string;
  readonly secret?: string;
  readonly previousSecret?: string;
  readonly diagnostics?: boolean;
}

export interface StatusWebhookConfig {
  readonly mappings: readonly RepositoryMapping[];
  readonly botLogin: string;
  readonly database: () => Promise<QueryDatabase>;
  /** The adapter provides only GitHubReader, never the mutation gateway. */
  readonly refresh: (db: QueryDatabase) => Promise<void>;
}
type Rejection = "configuration" | "content_type" | "headers" | "body_size" | "body_read" |
  "signature" | "target" | "json";

/** One receiver per isolate. Keys are imported lazily once, never per delivery. */
export const createGitHubWebhookReceiver = ({ appId, secret, previousSecret, diagnostics = false }: WebhookConfig) => {
  let keys: Promise<readonly CryptoKey[]> | undefined;
  const importKeys = () => keys ??= Promise.all([secret!, ...(previousSecret ? [previousSecret] : [])].map((value) =>
    crypto.subtle.importKey("raw", new TextEncoder().encode(value), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])));

  const verify = async (request: Request, waitUntil: (task: Promise<void>) => void):
    Promise<Rejection | { bytes: number; key: "current" | "previous"; payload: unknown }> => {
    if (!secret || !/^[1-9][0-9]*$/.test(appId)) return "configuration";
    if (request.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() !== "application/json") return "content_type";
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    if (!request.headers.get("x-github-event") || !request.headers.get("x-github-delivery") ||
        !/^sha256=[0-9a-f]{64}$/.test(signature)) return "headers";

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    try {
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > GITHUB_WEBHOOK_BODY_BYTES) {
          // Keep cancellation alive without delaying the rejection response.
          waitUntil(reader.cancel().catch(() => {}));
          return "body_size";
        }
        chunks.push(value);
      }
    } catch { return "body_read"; }
    finally { reader?.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = Uint8Array.from(signature.slice(7).match(/../g)!, (hex) => parseInt(hex, 16));
    let valid = false;
    let matchedKey: "current" | "previous" = "current";
    try {
      for (const [index, key] of (await importKeys()).entries()) {
        if (await crypto.subtle.verify("HMAC", key, digest, bytes)) {
          valid = true; matchedKey = index === 0 ? "current" : "previous"; break;
        }
      }
    } catch { return "configuration"; }
    if (!valid) return "signature";
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { return "json"; }
    if (request.headers.get("x-github-hook-installation-target-type") !== "integration" ||
        request.headers.get("x-github-hook-installation-target-id") !== appId) return "target";
    return { bytes: size, key: matchedKey, payload };
  };

  return (request: Request, waitUntil: (task: Promise<void>) => void, status?: StatusWebhookConfig) => Effect.gen(function* () {
    const result = yield* Effect.promise(() => verify(request, waitUntil));
    if (typeof result === "string") {
      yield* Metric.update(webhookRejections, 1);
      yield* Effect.logWarning("GitHub webhook rejected").pipe(Effect.annotateLogs({ reason: result }));
      return new Response(null, { status: 401 });
    }
    let responseStatus = 204;
    const record = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    const payload = record(result.payload);
    const issue = record(payload.issue);
    const repositoryId = record(payload.repository).id;
    const installationId = record(payload.installation).id;
    const issueId = issue.id;
    const positiveId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
    if (status && request.headers.get("x-github-event") === "issues" &&
        typeof payload.action === "string" && ["closed", "reopened", "transferred", "deleted"].includes(payload.action) &&
        record(issue.user).login === status.botLogin && record(issue.user).type === "Bot" &&
        positiveId(repositoryId) && positiveId(installationId) && positiveId(issueId)) {
      const mapped = status.mappings.filter((mapping) => mapping.repositoryId === repositoryId);
      // Conflicting pins fail closed, as they do for the repository sweep.
      if (mapped.length > 0 && mapped.every((mapping) => mapping.githubInstallationId === installationId)) {
        const accepted = yield* Effect.tryPromise({ try: async () => {
          const db = await status.database();
          const marked = await requestStatusRefresh(db, repositoryId, issueId, Date.now());
          if (marked.meta.changes === 0) return false;
          waitUntil(Promise.resolve().then(() => status.refresh(db)).catch(() => {}));
          return true;
        }, catch: () => "storage" as const }).pipe(Effect.catch(() => Effect.succeed("storage" as const)));
        responseStatus = accepted === "storage" ? 503 : accepted ? 202 : 204;
      }
    }
    const change = status ? lifecycleChange(request.headers.get("x-github-event")!, result.payload, status.mappings) : undefined;
    if (status && change && (change.suspend.length > 0 || change.verify.length > 0)) {
      // Written before the acknowledgement: GitHub does not redeliver a 2xx.
      const applied = yield* Effect.tryPromise({ try: () => status.database(), catch: () => "storage" as const }).pipe(
        Effect.flatMap((db) => applyLifecycleChange(db, change, Date.now())),
        Effect.as("applied" as const), Effect.catch(() => Effect.succeed("storage" as const)));
      responseStatus = applied === "storage" ? 503 : 202;
    }
    return new Response(null, { status: responseStatus, headers: diagnostics ? {
      "X-GQ-Webhook-Bytes": String(result.bytes), "X-GQ-Webhook-Key": result.key,
    } : undefined });
  });
};

export type GitHubWebhookReceiver = ReturnType<typeof createGitHubWebhookReceiver>;
