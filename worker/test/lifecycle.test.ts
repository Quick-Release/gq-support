import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway } from "../src/github-gateway.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import { harness, signed, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

const mapping: RepositoryMapping = { slot: "shop/production", client: "shop", project: "shop", environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let installation: Installation;
let github: ReturnType<typeof makeFakeGitHub>;
let logs: string[];
let spans: Tracer.Span[];
let authenticationValues: string[];
let now: number;
const logger = () => Logger.layer([Logger.map(Logger.formatJson, line => { logs.push(line); })]);
const tracer = Tracer.make({ span(options) {
  const span = Tracer.nativeTracer.span(options);
  spans.push(span);
  return span;
} });
const subject = "00000000-0000-4000-8000-000000000001";

beforeEach(async () => {
  now = Date.parse("2026-10-17T10:00:00Z");
  vi.useFakeTimers({ toFake: ["Date"], now });
  logs = [];
  spans = [];
  authenticationValues = [];
  stage = await localStage(["shared"]);
  installation = await harness(stage.databases.shared, [mapping]).enroll(mapping.slot, "installation-a");
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7 });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const send = async (body: string, path = "/v1/requests") => {
  const request = await signed(installation.pair, "POST", path, body, installation.keyId, installation.installationId);
  authenticationValues.push(request.headers.get("GQ-Support-Request-Id")!, request.headers.get("GQ-Support-Signature")!);
  request.headers.set("Cookie", "private-cookie-canary");
  return Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(request), Effect.succeed(stage.databases.shared),
    [mapping], () => Effect.die("Not a webhook"), () => {}, undefined, { release: "staged" }).pipe(Effect.provide(logger()), Effect.withTracer(tracer)));
};
const sweep = () => Effect.runPromise(sweepDelivery({ db: stage.databases.shared, mappings: [mapping],
  botLogin: `${SLUG}[bot]`, now: () => now, random: () => 0 }).pipe(
  Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer))),
  Effect.provide(logger()), Effect.withTracer(tracer)));

it("joins acceptance, duplicate receipt, uncertain delivery and reconciliation using only opaque lifecycle identifiers", async () => {
  const submission = crypto.randomUUID();
  const text = 'gqcanary_' + crypto.randomUUID().replaceAll('-', '');
  const body = JSON.stringify({ submission_id: submission, reporter_subject: subject, scope: "mine", description: text });
  const accepted = await send(body);
  expect(accepted.status).toBe(202);
  const receipt = await accepted.json() as { id: string };
  expect(await (await send(body)).json()).toMatchObject({ id: receipt.id, delivery: "accepted-pending" });
  github.onCreate(() => new Response(null, { status: 502 }));
  await sweep();
  now += 60_000;
  vi.setSystemTime(now);
  await sweep();
  await sweep(); // Redelivery of the wake-up must not recreate the issue.
  const projected = await installation.send("GET", `/v1/requests/${receipt.id}?reporter_subject=${subject}&scope=mine`);
  expect(await projected.json()).toMatchObject({ id: receipt.id, delivery: "delivered", status: "open", description: text });
  expect(github.issues).toHaveLength(1);
  const events = logs.map(line => JSON.parse(line).annotations);
  expect(events.filter(event => event.event === "support.receipt")).toEqual([
    { event: "support.receipt", request: receipt.id, operation: "create", delivery: "accepted-pending" },
    { event: "support.receipt", request: receipt.id, operation: "create", delivery: "accepted-pending" },
  ]);
  const attempts = events.filter(event => event.outcome === "OutcomeUnknown" || event.outcome === "Reconciled");
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toMatchObject({ request: receipt.id, intent: expect.stringMatching(/^int_/), generation: 1,
    attempt: expect.any(String), outcome: "OutcomeUnknown" });
  expect(attempts[1]).toMatchObject({ request: receipt.id, intent: attempts[0].intent, generation: 2,
    attempt: expect.any(String), outcome: "Reconciled" });
  expect(attempts[0].attempt).not.toBe(attempts[1].attempt);
  expect(spans.filter(span => span.name === "support.receipt").map(span => Object.fromEntries(span.attributes))).toEqual([
    events[0], events[1],
  ]);
  expect(spans.filter(span => span.name === "support.delivery").map(span => Object.fromEntries(span.attributes))).toEqual(
    attempts.map(event => ({ request: receipt.id, intent: event.intent, generation: event.generation, attempt: event.attempt })));
  const output = logs.join("\n") + JSON.stringify(spans.map(span => Object.fromEntries(span.attributes)));
  for (const secret of [text, subject, submission, installation.keyId, github.privateKeyPem, "private-cookie-canary", ...authenticationValues]) {
    expect(output).not.toContain(secret);
  }
  for (const request of github.requests) {
    const credential = request.headers.get("authorization");
    if (credential) expect(output).not.toContain(credential);
  }
});

it("logs a status receipt's delivery separately from the delivered create, and rejects provider credentials as Visibility scope", async () => {
  const accepted = await send(JSON.stringify({ submission_id: crypto.randomUUID(), reporter_subject: subject, scope: "mine", description: "Private report" }));
  const { id } = await accepted.json() as { id: string };
  await sweep();
  const change = JSON.stringify({ change_id: crypto.randomUUID(), reporter_subject: subject, scope: "mine", status: "closed" });
  const response = await send(change, `/v1/requests/${id}/status`);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ delivery: "delivered", status: "open", status_change: { delivery: "accepted-pending" } });
  expect(logs.map(line => JSON.parse(line).annotations)).toContainEqual({
    event: "support.receipt", request: id, operation: "status", delivery: "accepted-pending",
  });
  now += 60_000;
  vi.setSystemTime(now);
  await sweep();
  const replay = await send(change, `/v1/requests/${id}/status`);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ status: "closed", status_change: { delivery: "delivered" } });
  expect(logs.map(line => JSON.parse(line).annotations)).toContainEqual({
    event: "support.receipt", request: id, operation: "status", delivery: "delivered",
  });
  const credential = github.requests.find(request => request.path.endsWith("/issues"))!.headers.get("authorization")!;
  const forbidden = await Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(new Request(
    `https://support.example/v1/requests/${id}?reporter_subject=${subject}&scope=site`, { headers: { Authorization: credential } })),
  Effect.succeed(stage.databases.shared), [mapping], () => Effect.die("Not a webhook"), () => {}).pipe(Effect.provide(logger())));
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toEqual({ code: "gq_support_not_configured", message: "Installation rejected." });
  expect(logs.join("\n")).not.toContain(credential);
  expect(logs.filter(line => JSON.parse(line).annotations.event === "support.receipt")).toHaveLength(3);
});
