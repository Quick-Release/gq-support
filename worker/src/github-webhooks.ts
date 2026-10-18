import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

export const GITHUB_WEBHOOK_PATH = "/v1/github/webhooks";
// Provisional until staging payload measurements are recorded in #55.
export const GITHUB_WEBHOOK_BODY_BYTES = 1024 * 1024;
export const webhookRejections = Metric.counter("github_webhook_rejections_total");

interface WebhookConfig {
  readonly appId: string;
  readonly secret?: string;
  readonly previousSecret?: string;
  readonly diagnostics?: boolean;
}
type Rejection = "configuration" | "content_type" | "headers" | "body_size" | "body_read" |
  "signature" | "target" | "json";

/** One receiver per isolate. Keys are imported lazily once, never per delivery. */
export const createGitHubWebhookReceiver = ({ appId, secret, previousSecret, diagnostics = false }: WebhookConfig) => {
  let keys: Promise<readonly CryptoKey[]> | undefined;
  const importKeys = () => keys ??= Promise.all([secret!, ...(previousSecret ? [previousSecret] : [])].map((value) =>
    crypto.subtle.importKey("raw", new TextEncoder().encode(value), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])));

  const verify = async (request: Request, waitUntil: (task: Promise<void>) => void):
    Promise<Rejection | { bytes: number; key: "current" | "previous" }> => {
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
    try { JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { return "json"; }
    if (request.headers.get("x-github-hook-installation-target-type") !== "integration" ||
        request.headers.get("x-github-hook-installation-target-id") !== appId) return "target";
    // The event/action allowlist is intentionally empty in #55. No handler,
    // gateway or D1 capability is reachable from this receiver.
    return { bytes: size, key: matchedKey };
  };

  return (request: Request, waitUntil: (task: Promise<void>) => void) => Effect.gen(function* () {
    const result = yield* Effect.promise(() => verify(request, waitUntil));
    if (typeof result === "string") {
      yield* Metric.update(webhookRejections, 1);
      yield* Effect.logWarning("GitHub webhook rejected").pipe(Effect.annotateLogs({ reason: result }));
      return new Response(null, { status: 401 });
    }
    return new Response(null, { status: 204, headers: diagnostics ? {
      "X-GQ-Webhook-Bytes": String(result.bytes), "X-GQ-Webhook-Key": result.key,
    } : undefined });
  });
};

export type GitHubWebhookReceiver = ReturnType<typeof createGitHubWebhookReceiver>;
