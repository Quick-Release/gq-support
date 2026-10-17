import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { scheduledTick } from "../src/scheduled.ts";
import type { SweepConfig } from "../src/status-sweep.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { BOT, CLIENT_ID, makeFakeGitHub, SLUG, type FakeIssue } from "./fake-github.ts";

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
const tick = (sweep: Partial<SweepConfig> = {}) => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  return Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings, botLogin: BOT, now: () => now, random: () => 0, sweep })
    .pipe(Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer))),
      Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => { logs.push(line); })]))));
};
const issueOf = (title = "Checkout fails") => github.issues.find((issue) => issue.title === title)!;
const mutations = () => github.requests.filter((request) => request.method !== "GET" && !request.path.endsWith("/access_tokens"));

it("shows a GitHub close, then a reopen, to the Reporter after the next sweep", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("open");
  const created = mutations().length;

  advance(MINUTE);
  github.edit(issueOf(), { state: "closed" });
  await tick();
  expect(await statusOf(installation, request.id)).toBe("open"); // not due yet: no webhook in this slice

  advance(SWEEP);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");

  advance(MINUTE);
  github.edit(issueOf(), { state: "open" });
  advance(SWEEP);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("open");
  expect(mutations()).toHaveLength(created);
});

const lists = () => github.requests.filter((request) => request.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues$/.test(request.path));
const iso = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
/** An issue the App created that no Support request here owns, such as another installation's. */
const appIssue = (repositoryId: number, number: number, updatedAt: number): FakeIssue => ({
  id: 8_000_000 + repositoryId * 1000 + number, node_id: `I_noise_${repositoryId}_${number}`, number, title: `Other ${number}`, body: "Other",
  state: "open", created_at: iso(START), updated_at: iso(updatedAt), user: { login: BOT, type: "Bot" }, labels: [], assignees: [], repositoryId,
});

it("sweeps with read-only tokens scoped to one repository, listing App issues updated since the last sweep minus skew", async () => {
  const installation = await enroll(production);
  await accept(installation);
  await tick();
  const sweptAt = now;
  advance(SWEEP);
  await tick();
  const [, second] = lists();
  expect(Object.fromEntries(second!.query)).toEqual({ creator: BOT, state: "all", sort: "updated", direction: "asc",
    since: iso(sweptAt - 5 * MINUTE), per_page: "100", page: "1" });
  const sweepMints = github.requests.filter((request) => request.path.endsWith("/access_tokens") &&
    (request.body as { permissions: Record<string, string> }).permissions.issues === "read");
  expect(sweepMints.length).toBeGreaterThan(0);
  for (const mint of sweepMints) {
    expect(mint.body).toEqual({ repository_ids: [42], permissions: { issues: "read", metadata: "read" } });
  }
  // The only write in GitHub is the delivery's own create.
  expect(mutations().map((request) => `${request.method} ${request.path}`)).toEqual(["POST /repos/Quick-Release/repo-42/issues"]);
});

it("never lets an older GitHub observation overwrite a newer one", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  advance(MINUTE);
  const issue = issueOf();
  const stale = { ...issue, labels: [...issue.labels], assignees: [...issue.assignees] };
  github.edit(issue, { state: "closed" });
  advance(SWEEP);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
  advance(SWEEP);
  github.next(() => undefined); // read-only token
  const { repositoryId: _r, ...body } = stale;
  github.next(() => Response.json([body])); // a lagging replica's list: still open, older updated_at
  await tick();
  expect(lists().length).toBeGreaterThanOrEqual(3);
  expect(await statusOf(installation, request.id)).toBe("closed");
});

it("refreshes a production and a staging Slot that share a repository, each seeing only its own requests", async () => {
  const staging: RepositoryMapping = { ...production, slot: "shop/staging", environment: "staging" };
  mappings = [production, staging];
  const live = await enroll(production, "installation-a");
  const test = await enroll(staging, "installation-b");
  const mine = await accept(live, "Production report");
  await tick();
  advance(10_000); // the fleet-wide mutation interval
  const theirs = await accept(test, "Staging report");
  await tick();
  expect(github.issues).toHaveLength(2);
  advance(MINUTE);
  for (const issue of github.issues) github.edit(issue, { state: "closed" });
  advance(SWEEP);
  await tick();
  expect((await list(live)).map((item) => [item.id, item.status])).toEqual([[mine.id, "closed"]]);
  expect((await list(test)).map((item) => [item.id, item.status])).toEqual([[theirs.id, "closed"]]);
  expect(lists().filter((request) => request.query.get("since") !== null).length).toBe(lists().length);
});

it("never applies another Client's repository listing to this Client's requests", async () => {
  const other: RepositoryMapping = { slot: "other/production", client: "other", project: "other", environment: "production",
    repositoryId: 43, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
  github.repository({ id: 43, installationId: 7 });
  mappings = [production, other];
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  advance(10_000);
  await accept(await enroll(other, "installation-b"), "Other Client's report");
  await tick();
  advance(SWEEP);
  // A misrouted page: repository 43's listing carries this Client's issue as closed.
  const issue = issueOf();
  const { repositoryId: _r, ...forged } = { ...issue, state: "closed" as const, updated_at: iso(now) };
  github.next(() => undefined); // token for the first due repository
  github.next((recorded) => recorded.path.includes("/repo-43/") ? Response.json([forged]) : undefined);
  github.next(() => undefined);
  github.next((recorded) => recorded.path.includes("/repo-43/") ? Response.json([forged]) : undefined);
  await tick();
  expect(lists().some((recorded) => recorded.path.includes("/repo-43/"))).toBe(true);
  expect(await statusOf(installation, request.id)).toBe("open");
});

it("ignores Engineering issues in the same repository", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  github.issues.push({ ...appIssue(42, 2, now), user: { login: "developer", type: "User" }, title: "Refactor checkout" });
  advance(MINUTE);
  github.edit(github.issues[1]!, { state: "closed" });
  advance(SWEEP);
  // Even if one were listed, it is not the App's and changes nothing.
  github.next(() => undefined);
  github.next(() => { const { repositoryId: _r, ...engineering } = github.issues[1]!; return Response.json([engineering]); });
  await tick();
  expect(await list(installation)).toEqual([expect.objectContaining({ id: request.id, status: "open", title: "Checkout fails" })]);
  expect(await stage.databases.shared.prepare("SELECT COUNT(*) AS n FROM support_request").first("n")).toBe(1);
});

it("creates nothing for erased requests and leaves unbound requests unbound", async () => {
  const installation = await enroll(production);
  const erased = await accept(installation, "Erased report");
  await tick();
  advance(10_000); // the fleet-wide mutation interval
  github.onCreate((issue) => { issue.state = "closed"; return new Response(null, { status: 502 }); });
  const unbound = await accept(installation);
  await tick();
  // Erasure removes the record; its App issue stays behind in GitHub.
  const db = stage.databases.shared;
  await db.batch([db.prepare("DELETE FROM delivery_attempt WHERE intent_id IN (SELECT id FROM delivery_intent WHERE request_id = ?)").bind(erased.id),
    db.prepare("DELETE FROM delivery_intent WHERE request_id = ?").bind(erased.id),
    db.prepare("DELETE FROM support_request WHERE id = ?").bind(erased.id)]);
  await db.prepare("UPDATE delivery_control SET enabled = 0").run(); // keep reconciliation from binding the other
  advance(SWEEP);
  github.edit(issueOf("Checkout fails"), { state: "closed" });
  for (const issue of github.issues) github.edit(issue, { state: "closed" });
  await tick();
  expect(await list(installation)).toEqual([expect.objectContaining({ id: unbound.id, status: null })]);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM support_request").first("n")).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM support_request WHERE issue_id IS NOT NULL").first("n")).toBe(0);
});

it("keeps sweeping the repository pinned on delivered rows after their mapping changes", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  mappings = [{ ...production, repositoryId: 99 }]; // the Slot is remapped; its history stays in repository 42
  advance(MINUTE);
  github.edit(issueOf(), { state: "closed" });
  advance(SWEEP);
  await tick();
  expect(lists().at(-1)!.path).toBe("/repos/Quick-Release/repo-42/issues");
  expect(await statusOf(installation, request.id)).toBe("closed");
});

it("leaves a request under erasure suppression untouched", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  await stage.databases.shared.prepare("INSERT INTO delivery_suppression VALUES ('request', ?, 'erasure')").bind(request.id).run();
  advance(MINUTE);
  github.edit(issueOf(), { state: "closed" });
  advance(SWEEP);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("open");
});

it("pages through more App issues than one tick allows, resuming where it stopped", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  // 150 App issues changed in one second, then this request's issue just after.
  for (let n = 2; n <= 151; n += 1) github.issues.push(appIssue(42, n, now + MINUTE));
  advance(2 * MINUTE);
  github.edit(issueOf(), { state: "closed" });
  advance(SWEEP);
  const before = lists().length;
  await tick({ pagesPerRepository: 1 });
  await tick({ pagesPerRepository: 1 });
  expect(await statusOf(installation, request.id)).toBe("open");
  await tick({ pagesPerRepository: 1 });
  expect(await statusOf(installation, request.id)).toBe("closed");
  // Keyset by updated_at: page 1 moves the cursor to the shared second, which
  // is re-read once; a page that cannot move the cursor advances the page.
  expect(lists().slice(before).map((recorded) => recorded.query.get("page"))).toEqual(["1", "1", "2"]);
  // Completed: the next tick is not due again until the interval passes.
  await tick({ pagesPerRepository: 1 });
  expect(lists().length).toBe(before + 3);
});

it("catches a change GitHub stamped shortly before the last sweep", async () => {
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  advance(SWEEP);
  await tick();
  // Committed late: GitHub's updated_at is two minutes before that sweep began.
  github.edit(issueOf(), { state: "closed" }, now - 2 * MINUTE);
  advance(SWEEP);
  await tick();
  expect(await statusOf(installation, request.id)).toBe("closed");
});

it("is fair across repositories within the per-tick bound", async () => {
  const other: RepositoryMapping = { slot: "other/production", client: "other", project: "other", environment: "production",
    repositoryId: 43, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
  github.repository({ id: 43, installationId: 7 });
  mappings = [production, other];
  const installation = await enroll(production);
  const request = await accept(installation);
  await tick();
  advance(10_000);
  await accept(await enroll(other, "installation-b"), "Other Client's report");
  await tick();
  for (let n = 2; n <= 500; n += 1) github.issues.push(appIssue(43, n, now));
  advance(SWEEP);
  github.edit(issueOf(), { state: "closed" });
  advance(SWEEP);
  const before = lists().length;
  await tick({ pagesPerTick: 1 });
  await tick({ pagesPerTick: 1 });
  // A large repository with more pages to go does not hold the next tick.
  expect(new Set(lists().slice(before).map((recorded) => recorded.path.split("/")[3]))).toEqual(new Set(["repo-42", "repo-43"]));
  expect(await statusOf(installation, request.id)).toBe("closed");
});

it("shares GitHub's rate-limit cooldown with delivery", async () => {
  const installation = await enroll(production);
  await accept(installation);
  await tick();
  advance(SWEEP);
  github.next(() => undefined); // read-only token
  github.next(() => Response.json({ message: "API rate limit exceeded" }, { status: 429, headers: { "retry-after": "120" } }));
  await tick();
  const second = await accept(installation, "Another report");
  advance(MINUTE);
  const before = github.requests.length;
  await tick();
  expect(github.requests.length).toBe(before);
  advance(MINUTE);
  await tick();
  expect(await statusOf(installation, second.id)).toBe("open");
});

it("reports per-repository sweep lag and alerts after an hour without a completed sweep", async () => {
  const installation = await enroll(production);
  await accept(installation);
  await tick();
  const lag = () => logs.map((line) => JSON.parse(line) as { message: string[] | string; annotations: Record<string, unknown> })
    .filter((log) => log.annotations.metric === "support.status.sweep.lag_ms");
  expect(lag().at(-1)!.annotations).toMatchObject({ repository: 42, lag_ms: 0, alert: false });
  for (let n = 0; n < 5; n += 1) {
    advance(SWEEP);
    github.next(() => new Response(null, { status: 503 })); // token mint fails
    await tick();
  }
  expect(lag().at(-1)!.annotations).toMatchObject({ repository: 42, lag_ms: 5 * SWEEP, alert: true });
  expect(logs.join("\n")).not.toMatch(/Private report text|ghs_|Bearer/);
});
