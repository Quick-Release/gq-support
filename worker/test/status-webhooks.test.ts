import { createHmac } from "node:crypto";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { createGitHubWebhookReceiver } from "../src/github-webhooks.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import type { QueryDatabase } from "../src/storage.ts";
import { refreshStatus } from "../src/status-refresh.ts";
import { scheduledTick } from "../src/scheduled.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { BOT, CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";

const production: RepositoryMapping = { slot: "shop/production", client: "shop", project: "shop", environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
const subject = "00000000-0000-4000-8000-000000000001";
const secret = "test-webhook-secret";
let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let mappings: RepositoryMapping[];
let background: Promise<void>[];
let accesses: number;
let failDatabase: boolean;
let failWrite: boolean;
let skipBackground: boolean;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-17T10:00:00Z") });
  stage = await localStage(["shared"]);
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7 });
  mappings = [production]; background = []; accesses = 0; failDatabase = false; failWrite = false; skipBackground = false;
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
});
afterEach(async () => { await Promise.all(background); await stage.dispose(); vi.useRealTimers(); });
const config = () => ({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem });
const tick = () => Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings, botLogin: BOT })
  .pipe(Effect.provide(Layer.mergeAll(GitHubGateway.layer(config()), GitHubReader.layer(config())).pipe(Layer.provide(github.layer))),
    Effect.provide(Logger.layer([]))));
const enroll = (mapping = production, id = "installation-a") => harness(stage.databases.shared, mappings).enroll(mapping.slot, id);
const accept = async (installation: Installation) => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary: "Checkout fails", description: "Reporter text" }));
  expect(response.status).toBe(202);
};
const list = async (installation: Installation) => {
  const response = await installation.send("GET", `/v1/requests?reporter_subject=${subject}&scope=mine`);
  return await response.json() as { items: { status: string }[] };
};
const mutations = () => github.requests.filter((r) => r.method !== "GET" && !r.path.endsWith("/access_tokens"));
const payload = () => ({ action: "closed", repository: { id: 42 }, installation: { id: 7 },
  issue: { id: github.issues[0]!.id, number: github.issues[0]!.number, user: { login: BOT, type: "Bot" }, state: "closed" } });
const send = async (body: unknown, event = "issues") => {
  const raw = JSON.stringify(body);
  const receiver = createGitHubWebhookReceiver({ appId: "123", secret });
  const status = {
    mappings, botLogin: BOT,
    database: async () => {
      accesses++;
      if (failDatabase) throw new Error("D1 unavailable");
      return failWrite ? {
        prepare: () => { throw new Error("D1 write failed"); },
        batch: stage.databases.shared.batch.bind(stage.databases.shared),
      } : stage.databases.shared;
    },
    refresh: (db: QueryDatabase) => skipBackground ? Promise.resolve() : Effect.runPromise(refreshStatus({ db }).pipe(
      Effect.provide(GitHubReader.layer(config()).pipe(Layer.provide(github.layer))), Effect.provide(Logger.layer([])))),
  };
  const input = new Request("https://support.example/v1/github/webhooks", { method: "POST", body: raw,
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": "same-delivery",
      "x-github-hook-installation-target-type": "integration", "x-github-hook-installation-target-id": "123",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` },
  });
  return Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(input),
    Effect.die("Webhook must bypass installation authentication"), mappings, receiver,
    (task) => { background.push(task); }, status));
};
const settle = () => Promise.all(background);

it("refreshes a close promptly and exposes only status from noisy payload and provider text", async () => {
  const installation = await enroll(); await accept(installation); await tick();
  const before = await list(installation);
  const count = mutations().length;
  github.edit(github.issues[0]!, { state: "closed", title: "Internal title", body: "@staff https://internal.example" });
  const body = { ...payload(), issue: { ...payload().issue, title: "Private edited title",
    body: "@staff https://internal.example", comments: ["Secret comment"], labels: ["internal"], assignees: ["staff"] } };
  expect((await send(body)).status).toBe(202);
  await settle();
  const after = await list(installation);
  expect(after.items[0]!.status).toBe("closed");
  expect(JSON.stringify(after)).toBe(JSON.stringify(before).replace('"status":"open"', '"status":"closed"'));
  expect(mutations()).toHaveLength(count);
});

it.each(["closed", "reopened", "transferred", "deleted"])("accepts %s only as a hint to read GitHub", async (action) => {
  const installation = await enroll(); await accept(installation); await tick();
  const before = await list(installation); const count = mutations().length;
  expect((await send({ ...payload(), action })).status).toBe(202);
  await settle();
  expect(await list(installation)).toEqual(before); // payload says closed; provider still says open
  expect(mutations()).toHaveLength(count);
});

it.each(["opened", "edited", "labeled", "assigned", "future_action"])("drops issues %s without D1", async (action) => {
  expect((await send({ action, issue: { id: 1, user: { login: BOT, type: "Bot" } }, repository: { id: 42 }, installation: { id: 7 } })).status).toBe(204);
  expect(accesses).toBe(0); expect(github.requests).toHaveLength(0);
});

it.each([
  { event: "issue_comment" }, { user: { login: "developer", type: "User" } },
  { user: { login: "another[bot]", type: "Bot" } }, { repository: 99 }, { installation: 8 },
  { repository: "42" }, { installation: "7" }, { issue: "100" },
])("drops foreign or irrelevant delivery %j before D1", async (change) => {
  const body = { action: "closed", repository: { id: change.repository ?? 42 }, installation: { id: change.installation ?? 7 },
    issue: { id: change.issue ?? 100, user: change.user ?? { login: BOT, type: "Bot" } } };
  expect((await send(body, change.event)).status).toBe(204);
  expect(accesses).toBe(0); expect(background).toHaveLength(0); expect(github.requests).toHaveLength(0);
});

it("does not create a request for an unknown App issue", async () => {
  const installation = await enroll();
  expect((await send({ action: "closed", repository: { id: 42 }, installation: { id: 7 },
    issue: { id: 12345, user: { login: BOT, type: "Bot" } } })).status).toBe(204);
  expect((await list(installation)).items).toEqual([]);
  expect(background).toHaveLength(0); expect(github.requests).toHaveLength(0);
});

it("handles duplicate delivery and redelivery after D1 failure or success", async () => {
  const installation = await enroll(); await accept(installation); await tick();
  const count = mutations().length;
  github.edit(github.issues[0]!, { state: "closed" });
  failDatabase = true;
  expect((await send(payload())).status).toBe(503); expect(background).toHaveLength(0);
  failDatabase = false; failWrite = true;
  expect((await send(payload())).status).toBe(503); expect(background).toHaveLength(0);
  failWrite = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    expect((await send(payload())).status).toBe(202); await settle();
    expect((await list(installation)).items[0]!.status).toBe("closed");
  }
  expect(mutations()).toHaveLength(count);
});

it("uses current GitHub state for closed and reopened deliveries in reverse order", async () => {
  const installation = await enroll(); await accept(installation); await tick();
  const count = mutations().length;
  for (const action of ["reopened", "closed"]) {
    expect((await send({ ...payload(), action })).status).toBe(202); await settle();
    expect((await list(installation)).items[0]!.status).toBe("open");
  }
  expect(mutations()).toHaveLength(count);
});

it("leaves durable work for Cron when background refresh does not complete", async () => {
  const installation = await enroll(); await accept(installation); await tick();
  const count = mutations().length;
  github.edit(github.issues[0]!, { state: "closed" }); skipBackground = true;
  expect((await send(payload())).status).toBe(202); await settle();
  expect((await list(installation)).items[0]!.status).toBe("open");
  await tick();
  expect((await list(installation)).items[0]!.status).toBe("closed");
  expect(mutations()).toHaveLength(count);
});

it.each(["deleted", "transferred"])("closes a %s issue through the read-only gateway", async (action) => {
  const installation = await enroll(); await accept(installation); await tick();
  const before = await list(installation); const count = mutations().length;
  if (action === "deleted") github.issues[0]!.deleted = true;
  else github.issues[0]!.movedTo = "https://api.github.com/repos/Elsewhere/project/issues/9";
  expect((await send({ ...payload(), action })).status).toBe(202); await settle();
  expect(JSON.stringify(await list(installation))).toBe(JSON.stringify(before).replace('"status":"open"', '"status":"closed"'));
  expect(mutations()).toHaveLength(count);
});

it("isolates identical issue numbers in two repositories and Slots sharing a repository", async () => {
  const staging = { ...production, slot: "shop/staging", environment: "staging" };
  const other = { ...production, slot: "other/production", repositoryId: 43 };
  mappings.push(staging, other); github.repository({ id: 43, installationId: 7 });
  const installations = [await enroll(), await enroll(staging, "installation-b"), await enroll(other, "installation-c")];
  for (const installation of installations) { vi.setSystemTime(Date.now() + 60_000); await accept(installation); await tick(); }
  const issue = github.issues.find((item) => item.repositoryId === 42)!;
  const otherIssue = github.issues.find((item) => item.repositoryId === 43)!;
  expect(issue.number).toBe(otherIssue.number);
  const before = await Promise.all(installations.map(list)); const count = mutations().length;
  // A valid repository and issue number cannot authorize another repository's issue ID.
  expect((await send({ ...payload(), issue: { ...payload().issue, id: otherIssue.id } })).status).toBe(204);
  expect(background).toHaveLength(0);
  github.edit(issue, { state: "closed" });
  expect((await send({ ...payload(), issue: { ...payload().issue, id: issue.id } })).status).toBe(202); await settle();
  const after = await Promise.all(installations.map(list));
  expect(after[0]!.items[0]!.status).toBe("closed");
  expect(after.slice(1)).toEqual(before.slice(1));
  expect(mutations()).toHaveLength(count);
});

it("drops a close before identity binding and lets the sweep repair it", async () => {
  const installation = await enroll(); await accept(installation);
  let early: Promise<Response> | undefined;
  github.onCreate(async (issue) => {
    github.edit(issue, { state: "closed" });
    early = send(payload());
    await early;
    // Hold the provider response until the early delivery has been handled.
    return undefined;
  });
  await tick();
  expect((await early)!.status).toBe(204);
  expect((await list(installation)).items[0]!.status).toBe("closed");
  expect(background).toHaveLength(0);
});

it.each([undefined, 8])("fails closed for a missing or conflicting installation pin %s", async (pin) => {
  mappings.push({ ...production, slot: "shop/staging", githubInstallationId: pin });
  expect((await send({ action: "closed", repository: { id: 42 }, installation: { id: 7 },
    issue: { id: 100, user: { login: BOT, type: "Bot" } } })).status).toBe(204);
  expect(accesses).toBe(0);
});
