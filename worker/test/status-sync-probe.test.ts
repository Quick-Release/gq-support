import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { percentile, runProbe, STAGING_ORIGIN, type ProbeDeps, type ProbeState } from "../scripts/status-sync-probe.ts";
import { GitHubGateway, GitHubReader } from "../src/github-gateway.ts";
import { handleRequest } from "../src/installation-api.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { suspendRepository } from "../src/repository-suspension.ts";
import { scheduledTick } from "../src/scheduled.ts";
import { localStage } from "./local-d1.ts";
import { BOT, CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";

// The staging probe as the Reporter's installation, against the real installation API,
// local D1, the scheduled entry and fake GitHub, on a simulated clock.
const START = Date.parse("2026-10-17T10:00:00Z");
const SANDBOX = 1424354303;
const iso = (time: number) => new Date(time).toISOString();
const mappings: RepositoryMapping[] = [{ slot: "sandbox/staging", client: "sandbox", project: "sandbox", environment: "staging",
  repositoryId: SANDBOX, githubInstallationId: 172696674, clientOriginLabel: "client-support", defaultDeveloper: "developer" }];
let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let github: ReturnType<typeof makeFakeGitHub>;
let now: number;
let saved: ProbeState | undefined;
let printed: string[];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  saved = undefined;
  printed = [];
  stage = await localStage(["shared"]);
  github = makeFakeGitHub();
  github.installation(172696674);
  github.repository({ id: SANDBOX, installationId: 172696674, owner: "Quick-Release", name: "gq-support-sandbox" });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const tick = () => {
  const config = { clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem };
  return Effect.runPromise(scheduledTick({ db: stage.databases.shared, mappings, botLogin: BOT, now: () => now, random: () => 0 })
    .pipe(Effect.provide(Layer.mergeAll(GitHubGateway.layer(config), GitHubReader.layer(config)).pipe(Layer.provide(github.layer))),
      Effect.provide(Logger.layer([]))));
};
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  query: async (sql, parameters) => (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results });

/** Each poll waits ten simulated seconds, during which the minute Cron runs on the minute. */
const deps = (): ProbeDeps => ({
  fetch: async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe(STAGING_ORIGIN);
    request.headers.set("CF-Connecting-IP", "192.0.2.1");
    return handleRequest(request, stage.databases.shared, mappings);
  },
  gh: (args, stdin) => {
    const path = args[1]!;
    if (path === "repos/Quick-Release/gq-support-sandbox") return { id: SANDBOX, private: true };
    if (path.startsWith("repos/Quick-Release/gq-support-sandbox/issues?")) {
      expect(new URLSearchParams(path.split("?")[1]).get("creator")).toBe(BOT);
      return github.issues.map((issue) => ({ number: issue.number, title: issue.title }));
    }
    // Only the Developer's own changes: the fake records no App events or comments after creation.
    if (path.includes("/events?")) return [{ actor: { login: BOT }, created_at: "2026-10-17T10:00:01Z" }, { actor: { login: "developer" }, created_at: iso(now) }];
    if (path.includes("/comments?")) return [];
    const issue = github.issues.find((candidate) => path.endsWith(`/issues/${candidate.number}`))!;
    github.edit(issue, stdin as { state: "open" | "closed" }, now);
    return { state: issue.state, updated_at: issue.updated_at };
  },
  now: () => now,
  sleep: async (milliseconds) => {
    const before = Math.floor(now / 60_000);
    now += milliseconds;
    vi.setSystemTime(now);
    if (Math.floor(now / 60_000) > before) await tick();
  },
  load: () => saved!,
  save: (state) => { saved = state; },
  print: (line) => { printed.push(line); },
});

it("takes the nearest-rank percentile", () => {
  expect(percentile([], 95)).toBeNull();
  expect(percentile([5, 1, 3], 50)).toBe(3);
  expect(percentile(Array.from({ length: 20 }, (_, index) => index + 1), 95)).toBe(19);
});

it("enrolls, submits, finds its sandbox issue and measures each transition from GitHub's updated_at", async () => {
  const code = await operator("enroll", "sandbox/staging");
  expect(await runProbe("enroll", { code }, deps())).toMatchObject({ enrolled: true });
  expect(JSON.stringify(saved)).not.toContain(code);

  expect(await runProbe("submit", {}, deps())).toEqual({ submitted: true, issueNumber: github.issues[0]!.number });
  const summary = await runProbe("measure", { transitions: 2, timeoutMinutes: 20 }, deps());

  // Sweep-only: no webhook in this test, so each change waits for the 15-minute sweep.
  expect(summary).toMatchObject({ transitions: 2, observed: 2, appWrites: 0 });
  expect(saved!.transitions.map((transition) => transition.state)).toEqual(["closed", "open"]);
  for (const transition of saved!.transitions) {
    expect(transition.lagMs).toBeGreaterThan(0);
    expect(transition.lagMs).toBeLessThanOrEqual(17 * 60_000);
  }
  expect(printed).toHaveLength(2);
  expect(printed.join("\n")).not.toMatch(/Synthetic staging probe|privateKey|"d":/);
}, 60_000);

it("records an unobserved transition as a miss when the timeout passes", async () => {
  await runProbe("enroll", { code: await operator("enroll", "sandbox/staging") }, deps());
  await runProbe("submit", {}, deps());
  const summary = await runProbe("measure", { transitions: 1, timeoutMinutes: 1 }, deps());
  expect(summary).toEqual({ transitions: 1, observed: 0, p50Ms: null, p95Ms: null, maxMs: null, appWrites: 0 });
  expect(saved!.transitions[0]).toMatchObject({ state: "closed", observedAt: null, lagMs: null });
});

it("reports when the Reporter's installation first sees a suspended mapping", async () => {
  await runProbe("enroll", { code: await operator("enroll", "sandbox/staging") }, deps());
  const probe = deps();
  const sleep = probe.sleep;
  let polls = 0;
  const result = await runProbe("watch-suspension", { timeoutMinutes: 5 }, { ...probe, sleep: async (milliseconds) => {
    if (++polls === 3) await Effect.runPromise(suspendRepository(stage.databases.shared, SANDBOX, "public", now).pipe(Effect.provide(Logger.layer([]))));
    await sleep(milliseconds);
  } });
  expect(result).toEqual({ suspended: true, afterMs: 30_000 });
});
