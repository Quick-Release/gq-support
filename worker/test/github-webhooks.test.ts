import { createHmac } from "node:crypto";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import { expect, it } from "vitest";
import { createGitHubWebhookReceiver, GITHUB_WEBHOOK_BODY_BYTES, webhookRejections } from "../src/github-webhooks.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";

const secret = "It's a Secret to Everybody";
const config = { appId: "123", secret };
const signature = (body: string, key = secret) => `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
const request = (body: string, headers: Record<string, string> = {}) => new Request("https://support.example/v1/github/webhooks", {
  method: "POST", body, headers: {
    "Content-Type": "application/json", "X-GitHub-Event": "issues", "X-GitHub-Delivery": "delivery-1",
    "X-GitHub-Hook-Installation-Target-ID": "123", "X-GitHub-Hook-Installation-Target-Type": "integration",
    "X-Hub-Signature-256": signature(body), ...headers,
  },
});

const send = async (input: Request, options: Parameters<typeof createGitHubWebhookReceiver>[0] = config,
  receiver = createGitHubWebhookReceiver(options)) => {
  let databaseAccesses = 0;
  const logs: string[] = [];
  const background: Promise<void>[] = [];
  const database = Effect.sync(() => { databaseAccesses++; throw new Error("Webhook must not resolve D1"); });
  const before = await Effect.runPromise(Metric.value(webhookRejections));
  const response = await Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(input), database, [], receiver,
    (task) => { background.push(task); })
    .pipe(Effect.provide(Logger.layer([
      Logger.map(Logger.formatJson, (line) => { logs.push(line); }),
    ]))));
  await Promise.all(background);
  expect(databaseAccesses).toBe(0);
  expect(await response.text()).toBe("");
  expect((await Effect.runPromise(Metric.value(webhookRejections))).count).toBe(before.count + (response.status === 401 ? 1 : 0));
  for (const line of logs) {
    const log = JSON.parse(line);
    expect(log.message).toBe("GitHub webhook rejected");
    expect(Object.keys(log.annotations)).toEqual(["reason"]);
    expect(line).not.toContain(secret);
    expect(line).not.toContain("delivery-1");
    expect(line).not.toContain("Private report");
  }
  return { response, logs };
};

it("acknowledges a signed delivery without installation authentication or D1 access", async () => {
  const { response, logs } = await send(request('{"action":"closed"}'));
  expect(response.status).toBe(204);
  expect(logs).toEqual([]);
  expect(response.headers.get("X-GQ-Webhook-Bytes")).toBeNull();
});

it("exposes only verified byte count and key classification during a staging spike", async () => {
  const body = '{"description":"café 🐙"}';
  const options = { ...config, diagnostics: true, previousSecret: "old-test-secret" };
  const { response } = await send(request(body), options);
  expect(response.headers.get("X-GQ-Webhook-Bytes")).toBe(String(Buffer.byteLength(body)));
  expect(response.headers.get("X-GQ-Webhook-Key")).toBe("current");
  const previous = await send(request(body, { "X-Hub-Signature-256": signature(body, options.previousSecret) }), options);
  expect(previous.response.headers.get("X-GQ-Webhook-Key")).toBe("previous");
  const rejected = await send(request(body, { "X-Hub-Signature-256": signature("tampered") }), options);
  expect(rejected.response.headers.get("X-GQ-Webhook-Bytes")).toBeNull();
});

// GitHub's independent published vector is not JSON: the JSON rejection proves
// it passed HMAC, whereas each tampered variant must stop at signature failure.
it("verifies GitHub's published vector over the exact received bytes", async () => {
  const { response, logs } = await send(request("Hello, World!", {
    "X-Hub-Signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
  }));
  expect(response.status).toBe(401);
  expect(JSON.parse(logs[0]!).annotations.reason).toBe("json");
});

it.each(["body", "signature", "secret"])("rejects one changed byte in the %s", async (change) => {
  const body = '{"action":"closed"}';
  const digest = signature(body);
  const { response, logs } = await send(request(change === "body" ? body + " " : body, {
    "X-Hub-Signature-256": change === "signature" ? digest.slice(0, -1) + (digest.endsWith("0") ? "1" : "0") : digest,
  }), change === "secret" ? { ...config, secret: secret + "!" } : config);
  expect(response.status).toBe(401);
  expect(JSON.parse(logs[0]!).annotations.reason).toBe("signature");
});

it.each(["", "sha1=" + "a".repeat(40), "sha256=" + "A".repeat(64), "SHA256=" + "a".repeat(64),
  "sha256=" + "a".repeat(63), "sha256=" + "a".repeat(65), "sha256=" + "g".repeat(64)])(
  "rejects malformed signature %s", async (digest) => {
    const input = request("{}", { "X-Hub-Signature-256": digest, "X-Hub-Signature": "sha1=" + "a".repeat(40) });
    if (!digest) input.headers.delete("X-Hub-Signature-256");
    expect((await send(input)).response.status).toBe(401);
  },
);

it.each(["X-GitHub-Event", "X-GitHub-Delivery", "X-Hub-Signature-256"])("requires %s", async (header) => {
  const input = request("{}");
  input.headers.delete(header);
  expect((await send(input)).response.status).toBe(401);
});

it.each(["", "text/plain", "application/x-www-form-urlencoded", "application/jsonp", "application/problem+json"])(
  "rejects content type %s", async (type) => {
    expect((await send(request("{}", { "Content-Type": type }))).response.status).toBe(401);
  },
);

it("preserves whitespace, CRLF, UTF-8 and Unicode normalization through Effect conversion", async () => {
  const body = '{\r\n  "description": "Private report: café, café, 日本語, 🐙"\r\n}\n';
  expect((await send(request(body, { "Content-Type": "application/json; charset=utf-8" }))).response.status).toBe(204);
  expect((await send(request(body.normalize("NFC"), { "X-Hub-Signature-256": signature(body) }))).response.status).toBe(401);
});

it.each([undefined, "1", String(GITHUB_WEBHOOK_BODY_BYTES + 1)])("caps a stream despite Content-Length %s", async (length) => {
  let cancelled = false;
  let reads = 0;
  const input = request("{}");
  if (length) input.headers.set("Content-Length", length);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled = true; },
  });
  const init = { body: stream, duplex: "half" };
  const streamed = new Request(input, init);
  const { response, logs } = await send(streamed);
  expect(response.status).toBe(401);
  expect(JSON.parse(logs[0]!).annotations.reason).toBe("body_size");
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThanOrEqual(GITHUB_WEBHOOK_BODY_BYTES / (64 * 1024) + 2);
});

it("accepts a signed body exactly at the cap", async () => {
  const body = '"' + "x".repeat(GITHUB_WEBHOOK_BODY_BYTES - 2) + '"';
  expect((await send(request(body))).response.status).toBe(204);
});

it("supports current and previous secrets only while configured", async () => {
  const body = "{}";
  const rotating = { ...config, previousSecret: "previous-test-secret" };
  const receiver = createGitHubWebhookReceiver(rotating);
  expect((await send(request(body), rotating, receiver)).response.status).toBe(204);
  expect((await send(request(body, { "X-Hub-Signature-256": signature(body, rotating.previousSecret) }), rotating, receiver)).response.status).toBe(204);
  expect((await send(request(body, { "X-Hub-Signature-256": signature(body, rotating.previousSecret) }))).response.status).toBe(401);
});

it.each<Record<string, string>>([
  { "X-GitHub-Hook-Installation-Target-ID": "456" },
  { "X-GitHub-Hook-Installation-Target-ID": "" },
  { "X-GitHub-Hook-Installation-Target-Type": "repository" },
  { "X-GitHub-Hook-Installation-Target-Type": "" },
])("rejects another stage or a non-App hook: %j", async (headers) => {
  const { response, logs } = await send(request("{}", headers));
  expect(response.status).toBe(401);
  expect(JSON.parse(logs[0]!).annotations.reason).toBe("target");
});

it.each(["issues", "issue_comment", "installation", "repository", "ping", "future_event"])(
  "acknowledges %s without handlers or D1 access", async (event) => {
    expect((await send(request('{"action":"future_action","description":"Private report"}', {
      "X-GitHub-Event": event,
    }))).response.status).toBe(204);
  },
);

it.each([{}, { appId: "123" }, { ...config, appId: "" }])("fails closed on missing configuration %j", async (options) => {
  expect((await send(request("{}"), { appId: "", ...options })).response.status).toBe(401);
});

it("rejects a broken body stream without logging its error", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("Private report " + secret)); } });
  const init = { body: stream, duplex: "half" };
  expect((await send(new Request(request("{}"), init))).response.status).toBe(401);
});

it("does not parse an unverified body", async () => {
  const { logs } = await send(request("malformed Private report", { "X-Hub-Signature-256": signature("{}") }));
  expect(JSON.parse(logs[0]!).annotations.reason).toBe("signature");
});

it.each(["GET", "PUT"])("does not expose the webhook through %s", async (method) => {
  const input = new Request("https://support.example/v1/github/webhooks", { method });
  expect((await send(input)).response.status).toBe(404);
});
