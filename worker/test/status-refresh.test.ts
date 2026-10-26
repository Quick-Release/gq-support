import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { requestStatusRefresh, type RefreshConfig } from "../src/status-refresh.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { BOT, CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";

const START = Date.parse("2026-10-17T10:00:00Z");
const MINUTE = 60_000;
const SWEEP = 15 * MINUTE;
const production: RepositoryMapping = { slot: "shop/production", client: "shop", project: "shop", environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
const subject = "00000000-0000-4000-8000-000000000001";
let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let now: number;
let mappings: RepositoryMapping[];
let logs: string[];
beforeEach(async () => {
  logs = [];
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  mappings = [production];
  stage = await localStage(["shared"]);
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7 });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const enroll = (mapping: RepositoryMapping, installationId = "installation-a") =>
  harness(stage.databases.shared, mappings).enroll(mapping.slot, installationId);
const accept = async (installation: Installation, description = "Private report text") => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary: "Checkout fails", description }));
  expect(response.status).toBe(202);
  return await response.json() as { id: string };
};
/** The Reporter's My requests list, through the installation API. */
const list = async (installation: Installation) => {
  const response = await installation.send("GET", `/v1/requests?reporter_subject=${subject}&scope=mine`);
  expect(response.status).toBe(200);
  return (await response.json() as { items: { id: string; status: string | null; title: string; description: string }[] }).items;
};
const statusOf = async (installation: Installation, id: string) => (await list(installation)).find((item) => item.id === id)?.status;
const tickEffect = (refresh: Partial<RefreshConfig> = {}, random = () => 0) => {
  // A GitHub call that never answers times out on the real clock: keep that short.
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem, requestTimeoutMs: 1_000 };
  return scheduledTick({ db: stage.databases.shared, mappings, botLogin: BOT, now: () => now, random, sweep: { pagesPerTick: 0 }, refresh })
    .pipe(Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer))),
      Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => { logs.push(line); })])));
};
const tick = (refresh: Partial<RefreshConfig> = {}) => Effect.runPromise(tickEffect(refresh));
const issueOf = (title = "Checkout fails") => github.issues.find((issue) => issue.title === title)!;
const mutations = () => github.requests.filter((request) => request.method !== "GET" && !request.path.endsWith("/access_tokens"));

it("closes a deleted issue and alerts an Operator on the daily pass", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  issueOf().deleted = true;
  advance(24 * 60 * MINUTE);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
  expect(logs.join("\n")).toContain("Support status tracking lost");
});

const reads = () => github.requests.filter((r) => r.method === "GET" && /\/issues\/\d+$/.test(r.path));
const due = () => requestStatusRefresh(stage.databases.shared, 42, issueOf().id, now);

it("refreshes GitHub status without exposing internal edits or fetching comments", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  const issue = issueOf();
  advance(MINUTE);
  github.edit(issue, { state: "closed", title: "Internal engineering title", body: "Internal investigation notes" });
  issue.comments = 4;
  await requestStatusRefresh(stage.databases.shared, 42, issue.id, now);
  await tick();
  const items = await list(installation);
  expect(items).toEqual([expect.objectContaining({ id: request.id, title: "Checkout fails", description: "Private report text", status: "closed" })]);
  expect(JSON.stringify(items)).not.toMatch(/Internal|comments/);
  expect(github.requests.filter(call => call.path.includes("/comments"))).toHaveLength(0);
  expect(logs.join("\n")).not.toContain("Internal investigation notes");
});
const scriptRead = (script: import("./fake-github.ts").Script) => {
  // A new invocation has a new read-only token cache.
  github.next((request) => { expect(request.path).toContain("/access_tokens"); return undefined; });
  github.next(script);
};

it.each([301, 404])("ends tracking after a transfer (%s) without moving the request", async (status) => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  const mutationsBefore = mutations().length;
  await due();
  scriptRead(() => new Response(null, { status, headers: { location: "https://api.github.com/repos/Elsewhere/project/issues/9" } }));
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
  // Lost is terminal even if an old repository listing still contains the issue.
  advance(2 * 24 * 60 * MINUTE);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
  expect(mutations()).toHaveLength(mutationsBefore);
  expect(logs.join("\n")).toContain("Support status tracking lost");
});

it("conditionally observes an unchanged issue without changing Reporter text or status", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  const first = await list(installation);
  const count = reads().length;
  advance(MINUTE);
  await due();
  await tick();
  expect(reads()).toHaveLength(count + 1);
  expect(reads().at(-1)!.headers.get("if-none-match")).toBe('"open-14-1"');
  expect(await list(installation)).toEqual(first);
  await tick();
  expect(reads()).toHaveLength(count + 1);
  expect(await statusOf(installation, request.id)).toBe("open");
});

it("does not lose a same-millisecond refresh requested during a fetch", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  await due();
  let notification: Promise<unknown> | undefined;
  scriptRead(() => { notification = due(); return undefined; });
  await tick();
  await notification;
  github.edit(issueOf(), { state: "closed" }, now + MINUTE);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
});

it("recovers a cancelled refresh on the next minute tick", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  await due();
  const before = reads().length;
  scriptRead(() => "hang");
  const fiber = Effect.runFork(tickEffect());
  await vi.waitFor(() => expect(reads()).toHaveLength(before + 1));
  await Effect.runPromise(Fiber.interrupt(fiber));
  github.edit(issueOf(), { state: "closed" }, now + MINUTE);
  advance(MINUTE);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
});

it.each([500, 502, 503, 504, 403, 429, "reset", "timeout"])("paces retryable %s failures and eventually refreshes", async (failure) => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  advance(MINUTE);
  github.edit(issueOf(), { state: "closed" });
  await due();
  scriptRead(() => failure === "reset" ? "reset" : failure === "timeout" ? "hang"
    : Response.json({ message: "rate limit exceeded" }, { status: Number(failure),
      headers: failure === 403 || failure === 429 ? { "retry-after": "120" } : {} }));
  const run = tick();
  await run;
  const before = reads().length;
  await tick();
  expect(reads()).toHaveLength(before);
  expect(await statusOf(installation, request.id)).toBe("open");
  advance(2 * MINUTE);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
}, 20_000);

it("honours the primary rate-limit reset and alerts for repeated failures and old due work", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  await due();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    scriptRead(() => Response.json({ message: "API rate limit exceeded" }, { status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 2 * MINUTE) / 1000) } }));
    await tick();
    const count = reads().length;
    advance(MINUTE);
    await tick();
    expect(reads()).toHaveLength(count);
    advance(60 * MINUTE);
  }
  expect(logs.join("\n")).toContain('"attempts":5');
  expect(logs.map((line) => JSON.parse(line)).some((log) => log.annotations.metric === "support.status.refresh.oldest_due_age_ms" && log.annotations.alert)).toBe(true);
  github.edit(issueOf(), { state: "closed" });
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
  expect(logs.join("\n")).not.toMatch(/Private report text|ghs_|Bearer/);
});

it("resumes a daily pass after the per-tick cut-off and visits every open request", async () => {
  const installation = await enroll(production);
  const requests: { id: string }[] = [];
  for (let n = 0; n < 4; n += 1) {
    requests.push(await accept(installation, `Report ${n}`));
    await tick();
    advance(MINUTE);
  }
  for (const issue of github.issues) issue.deleted = true;
  advance(24 * 60 * MINUTE);
  const before = reads().length;
  for (let tickNumber = 0; tickNumber < 4; tickNumber += 1) {
    await tick({ dailyBatchSize: 1, readsPerTick: 1 });
    expect(reads().length - before).toBe(tickNumber + 1);
    advance(MINUTE);
  }
  expect((await list(installation)).map((r) => r.status)).toEqual(["closed", "closed", "closed", "closed"]);
  await tick({ dailyBatchSize: 1, readsPerTick: 1 });
  expect(reads().length - before).toBe(4);
});

it("keeps the newer status when two refreshes finish in reverse order", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  await due();
  const old = Response.json({ ...issueOf(), state: "open" }, { headers: { etag: '"old"' } });
  let release!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { release = resolve; });
  const before = reads().length;
  scriptRead(() => response);
  const first = tick();
  await vi.waitFor(() => expect(reads()).toHaveLength(before + 1));
  advance(MINUTE);
  github.edit(issueOf(), { state: "closed" });
  await due();
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
  release(old);
  await first;
  expect(await statusOf(installation, request.id)).toBe("closed");
  const count = reads().length;
  await tick();
  expect(reads()).toHaveLength(count);
});

it("queues an individual refresh for a changed sweep observation", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  advance(SWEEP);
  github.edit(issueOf(), { state: "closed" });
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  await Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings, botLogin: BOT, now: () => now })
    .pipe(Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer))), Effect.provide(Logger.layer([]))));
  const before = reads().length;
  await tick();
  expect(reads()).toHaveLength(before + 1);
  expect(await statusOf(installation, request.id)).toBe("closed");
});

it("adds jitter to backoff without holding other due requests behind the failing request", async () => {
  const installation = await enroll(production);
  const requests: { id: string }[] = [];
  for (let n = 0; n < 3; n += 1) {
    requests.push(await accept(installation, `Fair report ${n}`));
    await tick();
    advance(MINUTE);
  }
  for (const issue of github.issues) {
    github.edit(issue, { state: "closed" });
    await requestStatusRefresh(stage.databases.shared, 42, issue.id, now);
  }
  const before = reads().length;
  let failedPath = "";
  scriptRead((request) => { failedPath = request.path; return new Response(null, { status: 503 }); });
  await Effect.runPromise(tickEffect({ readsPerTick: 1 }, () => 0.5));
  await tick({ readsPerTick: 1 });
  await tick({ readsPerTick: 1 });
  expect(new Set(reads().slice(before).map((r) => r.path)).size).toBe(3);
  advance(MINUTE);
  await tick();
  expect(reads().slice(before).filter((r) => r.path === failedPath)).toHaveLength(1);
  advance(MINUTE / 2);
  await tick();
  expect(reads().slice(before).filter((r) => r.path === failedPath)).toHaveLength(2);
  expect((await list(installation)).every((r) => r.status === "closed")).toBe(true);
});

it("retains queued work when execution ends before the first daily fetch", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  issueOf().deleted = true;
  advance(24 * 60 * MINUTE);
  const before = reads().length;
  await tick({ executionMs: 0, dailyBatchSize: 1 });
  expect(reads()).toHaveLength(before);
  await tick({ dailyBatchSize: 1 });
  expect(await statusOf(installation, request.id)).toBe("closed");
});

it("ignores an expired loss result after a newer refresh succeeds", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  await due();
  let release!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => { release = resolve; });
  const before = reads().length;
  scriptRead(() => response);
  const first = tick();
  await vi.waitFor(() => expect(reads()).toHaveLength(before + 1));
  advance(MINUTE);
  await due();
  await tick();
  release(new Response(null, { status: 410 }));
  await first;
  expect(await statusOf(installation, request.id)).toBe("open");
});

it("retries aged work ahead of newly arriving daily refreshes", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  advance(MINUTE);
  github.edit(issueOf(), { state: "closed" });
  await due();
  scriptRead(() => new Response(null, { status: 503 }));
  await tick();
  advance(2 * MINUTE);
  // A short daily interval discovers newly delivered work in the same tick.
  await accept(installation, "New arrival");
  await tick({ dailyIntervalMs: MINUTE, readsPerTick: 1 });
  expect(await statusOf(installation, request.id)).toBe("closed");
});
