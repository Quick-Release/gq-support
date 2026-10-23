import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../contract/fixtures/status-change.json";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { requestStatusRefresh } from "../src/status-refresh.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { BOT, CLIENT_ID, makeFakeGitHub, SLUG, type FakeIssue } from "./fake-github.ts";

// Reporter close and reopen (#28, ADR 0020): ordered, idempotent status-change
// intents delivered to the mapped issue, with GitHub authoritative for status.
const START = Date.parse("2026-10-17T10:00:00Z");
const MINUTE = 60_000;
const production: RepositoryMapping = { slot: "shop/production", client: "shop", project: "shop", environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
const staging: RepositoryMapping = { ...production, slot: "shop/staging", environment: "staging" };
const REPORTER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let installation: Installation;
let now: number;
let logs: string[];
beforeEach(async () => {
  logs = [];
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared"]);
  installation = await harness(stage.databases.shared, [production, staging]).enroll(production.slot, "installation-a");
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7 });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const tick = () => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem, requestTimeoutMs: 1_000 };
  return Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings: [production, staging], botLogin: BOT, now: () => now,
    random: () => 0, sweep: { pagesPerTick: 0 } }).pipe(
    Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer))),
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => { logs.push(line); })]))));
};
const accept = async (subject = REPORTER, client = installation) => {
  const response = await client.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary: "Checkout fails", description: "Private report text" }));
  expect(response.status).toBe(202);
  return (await response.json() as { id: string }).id;
};
/** An accepted request whose create has been delivered, with the next mutation slot free. */
const delivered = async (subject = REPORTER) => {
  const id = await accept(subject);
  await tick();
  advance(MINUTE);
  return id;
};
interface Change { change_id: string; status: string; delivery: string }
interface Resource { id: string; status: string | null; delivery: string; status_change: Change | null; reporter_subject: string }
const change = (id: string, fields: Record<string, unknown>, subject = REPORTER, scope = "mine", client = installation) =>
  client.send("POST", `/v1/requests/${id}/status`, JSON.stringify({ reporter_subject: subject, scope, ...fields }));
const close = (id: string, changeId: string = crypto.randomUUID(), subject = REPORTER, scope = "mine") =>
  change(id, { change_id: changeId, status: "closed" }, subject, scope);
const reopen = (id: string, changeId: string = crypto.randomUUID()) => change(id, { change_id: changeId, status: "open" });
const read = async (id: string, subject = REPORTER, scope = "mine") =>
  (await installation.send("GET", `/v1/requests/${id}?reporter_subject=${subject}&scope=${scope}`)).json() as Promise<Resource>;
const listed = async (subject = REPORTER) =>
  ((await (await installation.send("GET", `/v1/requests?reporter_subject=${subject}&scope=mine`)).json()) as { items: Resource[] }).items;
const issue = () => github.issues[0] as FakeIssue;
const patches = () => github.requests.filter((request) => request.method === "PATCH");
const intents = async () => (await stage.databases.shared.prepare(
  "SELECT kind, seq, state, change_id, github_installation_id FROM delivery_intent ORDER BY seq").all()).results;

describe("acceptance", () => {
  it("accepts a Reporter's close of their own delivered request as an ordered, pinned intent", async () => {
    const id = await delivered();
    const changeId = crypto.randomUUID();
    const response = await close(id, changeId);
    expect(response.status).toBe(202);
    const body = await response.json() as Resource;
    // The Support status stays GitHub's until delivery; the change has its own outcome.
    expect(body).toMatchObject({ id, delivery: "delivered", status: "open",
      status_change: { change_id: changeId, status: "closed", delivery: "accepted-pending" } });
    expect(await intents()).toEqual([
      expect.objectContaining({ kind: "create", seq: 0, state: "delivered" }),
      { kind: "close", seq: 1, state: "pending", change_id: changeId, github_installation_id: 7 },
    ]);
    expect(patches()).toHaveLength(0);
  });

  // A browser-named identity is WordPress's to refuse; here those fields are the attested ones.
  const payloads = fixtures.payloads.filter((fixture) => !("reporter_subject" in fixture.payload) && !("scope" in fixture.payload));
  it.each(payloads.map((fixture) => [fixture.name, fixture] as const))("validates the shared payload: %s", async (_, fixture) => {
    const id = await delivered();
    const response = await installation.send("POST", `/v1/requests/${id}/status`,
      JSON.stringify({ ...fixture.payload, reporter_subject: REPORTER, scope: "mine" }));
    expect(response.status).toBe(fixture.valid ? 202 : 400);
    if (!fixture.valid) expect(await response.json()).toEqual({ code: "gq_support_invalid_request" });
    expect((await intents()).length).toBe(fixture.valid ? 2 : 1);
  });

  it("rejects fields WordPress never sends, and a query, without recording anything", async () => {
    const id = await delivered();
    for (const extra of [{ slot: staging.slot }, { repository_id: 77 }, { issue_number: 1 }, { installation_id: "installation-b" }]) {
      expect((await change(id, { change_id: crypto.randomUUID(), status: "closed", ...extra })).status).toBe(400);
    }
    const body = JSON.stringify({ reporter_subject: REPORTER, scope: "mine", change_id: crypto.randomUUID(), status: "closed" });
    expect((await installation.send("POST", `/v1/requests/${id}/status?scope=site`, body)).status).toBe(400);
    expect((await installation.send("PUT", `/v1/requests/${id}/status`, body)).status).toBe(404);
    expect(await intents()).toHaveLength(1);
  });

  it("hides another Reporter's request and every other installation's, unless a Support manager acts in this one", async () => {
    const id = await delivered();
    const unknown = await close("req_00000000000000000000000000", crypto.randomUUID());
    const hidden = await close(id, crypto.randomUUID(), OTHER);
    expect([unknown.status, hidden.status]).toEqual([404, 404]);
    expect(await hidden.json()).toEqual({ code: "gq_support_not_found" });
    const other = await harness(stage.databases.shared, [production, staging]).enroll(staging.slot, "installation-b");
    const elsewhere = await change(id, { change_id: crypto.randomUUID(), status: "closed" }, OTHER, "site", other);
    expect(elsewhere.status).toBe(404);
    expect(await intents()).toHaveLength(1);
    // The explicit installation scope: another Reporter with a fresh view-site grant.
    const managed = await close(id, crypto.randomUUID(), OTHER, "site");
    expect(managed.status).toBe(202);
    expect(await managed.json()).toMatchObject({ reporter_subject: REPORTER, status_change: { status: "closed" } });
  });

  it("refuses a change before the create is delivered, and after its issue was lost", async () => {
    const id = await accept();
    const early = await close(id);
    expect([early.status, await early.json()]).toEqual([409, { code: "gq_support_change_not_allowed" }]);
    await tick();
    await stage.databases.shared.prepare("UPDATE support_request SET tracking = 'lost', status = 'closed'").run();
    expect((await reopen(id)).status).toBe(409);
    expect(await intents()).toHaveLength(1);
  });

  it("replays a repeated action and refuses another action until the earlier one resolves", async () => {
    const id = await delivered();
    const changeId = crypto.randomUUID();
    expect((await close(id, changeId)).status).toBe(202);
    const repeated = await close(id, changeId);
    expect(repeated.status).toBe(202);
    expect((await repeated.json() as Resource).status_change).toMatchObject({ change_id: changeId, delivery: "accepted-pending" });
    const conflicting = await reopen(id, changeId);
    expect([conflicting.status, await conflicting.json()]).toEqual([409, { code: "gq_support_idempotency_conflict" }]);
    const queued = await reopen(id);
    expect([queued.status, await queued.json()]).toEqual([409, { code: "gq_support_change_pending" }]);
    expect(await intents()).toHaveLength(2);
    await tick();
    // Once delivered, a replay reports 200 and no second PATCH is sent.
    const settled = await close(id, changeId);
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({ status: "closed", status_change: { delivery: "delivered" } });
    expect(patches()).toHaveLength(1);
  });

  it("accepts exactly one of two concurrent actions", async () => {
    const id = await delivered();
    const responses = await Promise.all([close(id), reopen(id), close(id)]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409, 409]);
    expect(await intents()).toHaveLength(2);
  });

  it("refuses a change on a Suspended mapping", async () => {
    const id = await delivered();
    await stage.databases.shared.prepare("UPDATE repository_state SET suspended_reason = 'public', suspended_at = ? WHERE repository_id = 42")
      .bind(now).run();
    const response = await close(id);
    expect([response.status, await response.json()]).toEqual([403, { code: "gq_support_not_configured" }]);
  });

  it("bounds repeated actions per Reporter, separately from report intake", async () => {
    const id = await delivered();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await (attempt % 2 ? reopen(id) : close(id));
      statuses.push(response.status);
      // Resolve each change at once, so only the quota can refuse the next.
      await stage.databases.shared.prepare("UPDATE delivery_intent SET state = 'failed', next_attempt_at = NULL WHERE seq > 0").run();
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(202));
    expect(statuses[10]).toBe(429);
    // Intake has its own budget.
    expect((await accept()).startsWith("req_")).toBe(true);
  });
});

describe("delivery", () => {
  it("closes and reopens the mapped issue in order, reporting the provider's status", async () => {
    const id = await delivered();
    expect((await close(id)).status).toBe(202);
    await tick();
    expect(patches().map((request) => request.body)).toEqual([{ state: "closed" }]);
    expect(issue().state).toBe("closed");
    expect(await read(id)).toMatchObject({ status: "closed", status_change: { status: "closed", delivery: "delivered" } });
    advance(MINUTE);
    expect((await reopen(id)).status).toBe(202);
    await tick();
    expect(issue().state).toBe("open");
    expect((await listed())[0]).toMatchObject({ status: "open", status_change: { status: "open", delivery: "delivered" } });
    expect((await intents()).map((intent) => [intent.seq, intent.kind, intent.state]))
      .toEqual([[0, "create", "delivered"], [1, "close", "delivered"], [2, "reopen", "delivered"]]);
  });

  it("retries after a rate limit proves nothing changed", async () => {
    const id = await delivered();
    await close(id);
    github.next(() => undefined); // installation token, with repository safety
    github.next(() => Response.json({ message: "API rate limit exceeded" }, { status: 429, headers: { "retry-after": "120" } }));
    await tick();
    expect(await read(id)).toMatchObject({ status: "open", status_change: { delivery: "accepted-pending" } });
    advance(2 * MINUTE);
    await tick();
    expect(await read(id)).toMatchObject({ status: "closed", status_change: { delivery: "delivered" } });
    expect(patches()).toHaveLength(2);
  });

  it("reconciles an ambiguous PATCH that took effect by reading, never by sending again", async () => {
    const id = await delivered();
    await close(id);
    github.next(() => undefined);
    github.next(() => { github.edit(issue(), { state: "closed" }, now); return new Response(null, { status: 502 }); });
    await tick();
    expect(await read(id)).toMatchObject({ status: "open", status_change: { delivery: "outcome-unknown" } });
    // Another action waits for the reconciliation.
    expect((await reopen(id)).status).toBe(409);
    advance(MINUTE);
    await tick();
    expect(await read(id)).toMatchObject({ status: "closed", status_change: { delivery: "delivered" } });
    expect(patches()).toHaveLength(1);
  });

  it("sends again only once a read proves an ambiguous PATCH changed nothing", async () => {
    const id = await delivered();
    await close(id);
    github.next(() => undefined);
    github.next(() => "reset");
    await tick();
    expect((await read(id)).status_change).toMatchObject({ delivery: "outcome-unknown" });
    advance(MINUTE);
    await tick(); // the issue has not changed since before the attempt: known not applied
    advance(MINUTE);
    await tick();
    expect(await read(id)).toMatchObject({ status: "closed", status_change: { delivery: "delivered" } });
    expect(patches()).toHaveLength(2);
  });

  it("lets a later GitHub change win over an unconfirmed action", async () => {
    const id = await delivered();
    await close(id);
    github.next(() => undefined);
    github.next(() => new Response(null, { status: 502 }));
    await tick();
    // A Developer touches the issue after the uncertain attempt: the action may or may not have applied.
    advance(30_000);
    github.edit(issue(), { title: "Retitled by a Developer" }, now);
    advance(MINUTE);
    await tick();
    expect(await read(id)).toMatchObject({ status: "open", status_change: { status: "closed", delivery: "failed" } });
    expect(patches()).toHaveLength(1);
    // A failed action is resolved: the Reporter may try again with a new key, and that one is delivered.
    expect((await close(id)).status).toBe(202);
    advance(MINUTE);
    await tick();
    expect(await read(id)).toMatchObject({ status: "closed", status_change: { status: "closed", delivery: "delivered" } });
    expect(patches()).toHaveLength(2);
  });

  it("fails honestly when the issue is gone, without leaking provider text", async () => {
    const id = await delivered();
    await close(id);
    issue().deleted = true;
    await tick();
    const resource = await read(id);
    expect(resource.status_change).toMatchObject({ status: "closed", delivery: "failed" });
    expect(JSON.stringify(resource)).not.toContain("deleted");
  });

  it("shows a direct GitHub close and reopen after refresh, with no competing status", async () => {
    const id = await delivered();
    github.edit(issue(), { state: "closed" }, now);
    await requestStatusRefresh(stage.databases.shared, 42, issue().id, now);
    await tick();
    expect(await read(id)).toMatchObject({ status: "closed", status_change: null });
    // After a delivered Reporter reopen, a Developer closes it again in GitHub.
    advance(MINUTE);
    await reopen(id);
    await tick();
    expect((await read(id)).status).toBe("open");
    advance(MINUTE);
    github.edit(issue(), { state: "closed" }, now);
    await requestStatusRefresh(stage.databases.shared, 42, issue().id, now);
    await tick();
    expect(await read(id)).toMatchObject({ status: "closed", status_change: { status: "open", delivery: "delivered" } });
  });

  it("never lets an Operator resume a failed status change out of turn", async () => {
    const id = await delivered();
    await close(id);
    issue().deleted = true;
    await tick();
    const intent = await stage.databases.shared.prepare("SELECT id FROM delivery_intent WHERE seq = 1").first<{ id: string }>();
    const resume = runOperator(["resume", production.slot, intent!.id, new Date(now + 3_600_000).toISOString(), "operator-1", "provider-recovered"], {
      query: async (sql, parameters) => (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
      recordRevocation: async () => {}, mappings: [production], now,
    });
    await expect(resume).rejects.toThrow("Request cannot be resumed");
    expect((await read(id)).status_change).toMatchObject({ delivery: "failed" });
  });

  it("logs no report text, subject or change key", async () => {
    const id = await delivered();
    const changeId = crypto.randomUUID();
    await close(id, changeId);
    await tick();
    const text = logs.join("\n");
    for (const secret of ["Private report text", REPORTER, changeId]) expect(text).not.toContain(secret);
  });
});
