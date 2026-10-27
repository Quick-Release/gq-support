import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { observeGitHubActions, actionsLimits, type ActionsInput } from "./github-actions.ts";
import { decodeBatch, evaluate, type Context } from "./protocol.ts";

const root = "https://api.github.com/repos/Quick-Release/gq-support";
const now = Date.parse("2026-10-27T12:00:00Z"), sha = "a".repeat(40);
const canary = () => `gqcanary_${randomBytes(24).toString("hex")}`;
const token = canary(), privateText = canary();
const iso = (n: number) => new Date(n).toISOString();
function input(): ActionsInput {
  const expectation = { repo: "Quick-Release/gq-support" as const, workflow: "deploy-worker.yml" as const,
    event: "workflow_dispatch" as const, run: 30433642, attempt: 1, head: sha, stage: "staging" as const, candidate: sha };
  const context: Context = { now, stage: "staging", candidate: sha, account: "8f38791a8c37b182239af2a385ab3c31",
    generation: 1, activation: 0, exclusions: [], expected: [expectation] };
  return { context, tracked: [{ identity: "b".repeat(64), expectation, ref: "refs/heads/main" }],
    repositoryId: 1296269, observation: 1, actionsReadToken: token, expiresAt: now + 60_000 };
}
// GitHub's documented object envelopes (not the proposed normalized fixture).
function workflow() {
  return { id: 159038, node_id: privateText, name: "Deploy prod spoof", path: ".github/workflows/deploy-worker.yml",
    state: "active", created_at: "2020-01-08T23:48:37Z", updated_at: "2020-01-08T23:50:21Z",
    url: `${root}/actions/workflows/159038`, html_url: `https://github.com/${privateText}`, badge_url: privateText };
}
function run() {
  const repository = { id: 1296269, full_name: "Quick-Release/gq-support", url: root, private: true };
  return { id: 30433642, name: "prod malicious stage", display_title: privateText, path: ".github/workflows/ci.yml@evil",
    head_branch: "main", head_sha: sha, run_number: 562, event: "workflow_dispatch", status: "completed", conclusion: "failure",
    workflow_id: 159038, run_attempt: 1, url: `${root}/actions/runs/30433642`, workflow_url: `${root}/actions/workflows/159038`,
    created_at: iso(now - 3 * 86_400_000), updated_at: iso(now - 2 * 86_400_000), run_started_at: iso(now - 3 * 86_400_000 + 1000),
    repository, head_repository: { ...repository }, actor: { login: privateText }, logs_url: privateText,
    artifacts_url: privateText, cancel_url: privateText, pull_requests: [] };
}
function response(url: string, value: unknown, init: ResponseInit = {}) {
  const r = new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" }, ...init });
  Object.defineProperty(r, "url", { value: url }); return r;
}
function fixture(values: unknown[] = [workflow(), run()], clock = () => now, signal?: AbortSignal) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init }); return response(String(url), values[calls.length - 1]);
  });
  return { calls, io: { fetch: fetcher as typeof fetch, now: clock, signal } };
}
const cell = (r: Awaited<ReturnType<typeof observeGitHubActions>>, key = "workflow_failure") => r.public.verdict?.classes.find(x => x.class === key);
afterEach(() => vi.useRealTimers());

it("joins metadata + exact old attempt into real evaluator evidence; titles cannot supply stage", async () => {
  const i = input(), f = fixture(), result = await observeGitHubActions(i, f.io);
  expect(result.public.coverage).toBe("complete"); expect(cell(result)?.verdict).toBe("incident");
  expect(result.state?.workflowFailures).toEqual(i.context.expected);
  expect(decodeBatch(i.context, result.reads).invalid).toBe(false);
  expect(evaluate(i.context, decodeBatch(i.context, result.reads)).public).toEqual(result.public.verdict);
  expect(cell(result, "http_unavailable")?.verdict).toBe("unknown");
  expect(f.calls.map(x => x.url)).toEqual([`${root}/actions/workflows/deploy-worker.yml`, `${root}/actions/runs/30433642/attempts/1`]);
  for (const call of f.calls) {
    expect(call.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Accept-Encoding": "identity", "User-Agent": "gq-support-observer", "X-GitHub-Api-Version": "2026-03-10" } });
    expect(new URL(call.url).origin).toBe("https://api.github.com");
  }
  const published = JSON.stringify(result.public);
  for (const s of [token, privateText, sha, "30433642", root, "repository", "identity"]) expect(published).not.toContain(s);
  expect(new TextEncoder().encode(published).length).toBeLessThan(2200);
});

it.each(["failure", "timed_out", "action_required"])("accepts terminal %s only as workflow failure", async conclusion => {
  const f = fixture([workflow(), { ...run(), conclusion }]);
  expect(cell(await observeGitHubActions(input(), f.io))?.verdict).toBe("incident");
});
it.each([
  { id: 2 }, { run_attempt: 2 }, { head_sha: "c".repeat(40) }, { event: "push" }, { head_branch: "feature" },
  { workflow_id: 99 }, { workflow_url: `${root}/actions/workflows/99` }, { url: "https://evil.invalid" },
  { repository: { id: 1296269, full_name: "attacker/gq-support", url: root } },
  { head_repository: { id: 99, full_name: "Quick-Release/gq-support", url: root } },
  { updated_at: iso(now + 1) }, { created_at: iso(now) }, { run_started_at: iso(now) },
  { created_at: "2026-02-30T00:00:00Z" }, { status: "completed", conclusion: null },
  { status: "in_progress", conclusion: "failure" }, { status: "completed", run_started_at: null },
  { status: "success" }, { conclusion: "neutral" }, { conclusion: ["success"] }, { status: ["queued"], conclusion: null },
])("rejects wrong identity/state/timestamp join %#", async patch => {
  const f = fixture([workflow(), { ...run(), ...patch }]), r = await observeGitHubActions(input(), f.io);
  expect(r.reads).toHaveLength(0); expect(cell(r)?.verdict).toBe("unknown");
});
it.each([{ id: 0 }, { path: ".github/workflows/ci.yml" }, { url: `${root}/actions/workflows/9` }, { state: "unsupported" }])("refuses authoritative metadata mismatch %#", async patch => {
  const f = fixture([{ ...workflow(), ...patch }]);
  expect((await observeGitHubActions(input(), f.io)).reads).toHaveLength(0); expect(f.calls).toHaveLength(1);
});
it.each(["queued", "in_progress", "waiting", "pending", "requested"])("%s is unknown, never readiness", async status => {
  const r = await observeGitHubActions(input(), fixture([workflow(), { ...run(), status, conclusion: null }]).io);
  expect(cell(r)?.verdict).toBe("unknown"); expect(r.public.coverage).not.toBe("complete");
});
it.each(["cancelled", "skipped"])("%s cannot recover retained failure", async conclusion => {
  const i = input(); i.previous = (await observeGitHubActions(i, fixture().io)).state;
  const r = await observeGitHubActions(i, fixture([workflow(), { ...run(), conclusion }]).io);
  expect(cell(r)?.verdict).toBe("incident"); expect(r.public.coverage).toBe("partial");
});
it("requires approved higher attempt AND newer affirmative source evidence for recovery", async () => {
  const i = input(), failed = await observeGitHubActions(i, fixture().io); i.previous = failed.state;
  const success = { ...run(), conclusion: "success", updated_at: iso(now - 1000) };
  expect(cell(await observeGitHubActions(i, fixture([workflow(), success]).io))?.verdict).toBe("incident");
  expect(cell(await observeGitHubActions(i, fixture([workflow(), { ...success, run_attempt: 2 }]).io))?.verdict).toBe("incident");
  i.context.now++; i.observation++; i.context.expected[0].attempt = 2;
  const r = await observeGitHubActions(i, fixture([workflow(), { ...success, run_attempt: 2 }], () => now + 1).io);
  expect(cell(r)?.verdict).toBe("clear"); expect(r.state?.workflowFailures).toEqual([]);
  const stale = await observeGitHubActions(i, fixture([workflow(), { ...success, run_attempt: 2, updated_at: run().updated_at }], () => now + 1).io);
  expect(cell(stale)?.verdict).toBe("incident");
});
it("keeps newly discovered old failure below recovered watermark", async () => {
  const i = input();
  const cleared = await observeGitHubActions(i, fixture([workflow(), { ...run(), conclusion: "success", updated_at: iso(now - 1000) }]).io);
  i.previous = cleared.state; i.context.now++; i.observation++;
  expect(cell(await observeGitHubActions(i, fixture(undefined, () => now + 1).io))?.verdict).toBe("incident");
});
it("preserves positive failure and private carry after missing later source; no later requests", async () => {
  const i = input();
  for (let n = 1; n <= 2; n++) {
    const e = { ...i.context.expected[0], run: 30433642 + n };
    i.context.expected = [...i.context.expected, e]; i.tracked = [...i.tracked, { identity: String(n).repeat(64), expectation: e, ref: "refs/heads/main" }];
  }
  const f = fixture([workflow(), run(), {}]), r = await observeGitHubActions(i, f.io);
  expect(f.calls).toHaveLength(3); expect(r.reads).toHaveLength(1);
  expect(cell(r)).toMatchObject({ verdict: "incident", coverage: "partial" });
  const later = await observeGitHubActions({ ...i, previous: r.state }, fixture([{}]).io);
  expect(cell(later)?.verdict).toBe("incident");
});
it.each(["ci.yml", "release-plugin.yml"] as const)("accepts approved main semantics for %s", async workflowFile => {
  const i = input(), e = { ...i.context.expected[0], workflow: workflowFile, event: workflowFile === "ci.yml" ? "push" as const : "workflow_dispatch" as const };
  i.context.expected = [e]; i.tracked = [{ ...i.tracked[0], expectation: e }];
  const f = fixture([{ ...workflow(), path: `.github/workflows/${workflowFile}` }, { ...run(), event: e.event }]);
  expect(cell(await observeGitHubActions(i, f.io))?.verdict).toBe("incident");
});
it("allows only approved release plugin-v tag push, matching head branch and commit", async () => {
  const i = input(), e = { ...i.context.expected[0], workflow: "release-plugin.yml" as const, event: "push" as const };
  i.context.expected = [e]; i.tracked = [{ ...i.tracked[0], expectation: e, ref: "refs/tags/plugin-v0.1.10" }];
  const values = [{ ...workflow(), path: ".github/workflows/release-plugin.yml" }, { ...run(), event: "push", head_branch: "plugin-v0.1.10" }];
  expect(cell(await observeGitHubActions(i, fixture(values).io))?.verdict).toBe("incident");
  expect((await observeGitHubActions(i, fixture([values[0], { ...values[1], head_branch: "main" }]).io)).reads).toHaveLength(0);
  i.tracked[0].ref = "refs/tags/plugin-vbad";
  const f = fixture(values); await observeGitHubActions(i, f.io); expect(f.calls).toHaveLength(0);
});
it.each(["identity", "ref", "context", "limit", "token", "repository"])("refuses invalid trusted pins before HTTP: %s", async kind => {
  const i = input();
  if (kind === "identity") i.tracked[0].identity = "bad";
  if (kind === "ref") i.tracked[0].ref = "refs/tags/plugin-v1.2.3";
  if (kind === "context") i.tracked[0].expectation = { ...i.tracked[0].expectation, stage: "prod" };
  if (kind === "limit") i.tracked = Array(21).fill(i.tracked[0]);
  if (kind === "token") i.actionsReadToken = "\n";
  if (kind === "repository") i.repositoryId = 0;
  const f = fixture(); await observeGitHubActions(i, f.io); expect(f.calls).toHaveLength(0);
});
it.each([401, 403, 404, 410, 429, 500, 206, 302, 204])("stops on refused status %i, disposes response", async status => {
  let cancelled = false;
  const f = vi.fn(async (url: string) => {
    const body = [204, 304].includes(status) ? null : new ReadableStream({ cancel() { cancelled = true; } });
    const r = new Response(body, { status }); Object.defineProperty(r, "url", { value: url }); return r;
  });
  const r = await observeGitHubActions(input(), { fetch: f as typeof fetch, now: () => now });
  expect(f).toHaveBeenCalledTimes(1); expect(r.public.coverage).toBe("unknown"); if (status !== 204) expect(cancelled).toBe(true);
});
it.each(["url", "redirect", "type", "cookie", "gzip", "content-type", "length", "truncated", "malformed", "bytes", "chunks"])("bounds and disposes refused wire %s", async kind => {
  let cancelled = false;
  const f = vi.fn(async (url: string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (kind === "cookie") headers["Set-Cookie"] = privateText;
    if (kind === "gzip") headers["Content-Encoding"] = "gzip";
    if (kind === "content-type") headers["Content-Type"] = "text/html";
    if (kind === "length") headers["Content-Length"] = "65537";
    if (kind === "truncated") headers["Content-Length"] = "100";
    let n = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) {
      if (kind === "bytes") { c.enqueue(new Uint8Array(65537)); return; }
      if (kind === "chunks") { c.enqueue(new Uint8Array()); return; }
      if (n++ === 0) c.enqueue(new TextEncoder().encode(kind === "malformed" ? '{"bad":' : '{}')); else c.close();
    }, cancel() { cancelled = true; } });
    const r = new Response(stream, { headers }); Object.defineProperty(r, "url", { value: kind === "url" ? "https://evil.invalid" : url });
    if (kind === "redirect") Object.defineProperty(r, "redirected", { value: true });
    if (kind === "type") Object.defineProperty(r, "type", { value: "opaque" });
    return r;
  });
  expect((await observeGitHubActions(input(), { fetch: f as typeof fetch, now: () => now })).reads).toHaveLength(0);
  expect(f).toHaveBeenCalledTimes(1);
  if (!["truncated", "malformed"].includes(kind)) expect(cancelled).toBe(true);
});
it.each(["abort", "expiry", "deadline"])("disposes noncooperative late response on %s", async mode => {
  vi.useFakeTimers(); let time = now, resolve!: (r: Response) => void, cancelled = false;
  const controller = new AbortController();
  const f = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
  const p = observeGitHubActions(input(), { fetch: f as typeof fetch, now: () => time, signal: controller.signal });
  if (mode === "abort") controller.abort();
  else if (mode === "deadline") await vi.advanceTimersByTimeAsync(10_000);
  else time += 60_000; // Deadline clock check before timer callback (#126).
  const r = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  resolve(r); const result = await p; await Promise.resolve();
  expect(cancelled).toBe(true); expect(f).toHaveBeenCalledTimes(1); expect(result.reads).toHaveLength(0);
});
it("checks cancellation between metadata and exact run read", async () => {
  const controller = new AbortController(); let calls = 0;
  const f = async (url: string) => { calls++; controller.abort(); return response(url, workflow()); };
  await observeGitHubActions(input(), { fetch: f as typeof fetch, now: () => now, signal: controller.signal });
  expect(calls).toBe(1);
});
it("copies expectation, credentials, previous state and transport before awaiting", async () => {
  const i = input(); let resolve!: (r: Response) => void;
  const calls: { url: string; init?: RequestInit }[] = [];
  const io = { now: () => now, fetch: vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/workflows/")) return new Promise<Response>(r => { resolve = r; });
    return Promise.resolve(response(String(url), run()));
  }) as typeof fetch };
  const p = observeGitHubActions(i, io);
  i.context.expected[0].head = "d".repeat(40); i.actionsReadToken = "changed"; io.fetch = vi.fn() as typeof fetch;
  resolve(response(`${root}/actions/workflows/deploy-worker.yml`, workflow()));
  const r = await p; expect(r.public.coverage).toBe("complete"); expect(cell(r)?.verdict).toBe("incident");
  expect(calls[1].init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
});
it("supports twenty exact old expectations with metadata caching and no pagination", async () => {
  const i = input(); i.context.expected = Array.from({ length: 20 }, (_, n) => ({ ...i.context.expected[0], run: 30433642 + n }));
  i.tracked = i.context.expected.map((expectation, n) => ({ expectation, identity: n.toString(16).padStart(64, "0"), ref: "refs/heads/main" }));
  const f = fixture([workflow(), ...i.context.expected.map(e => ({ ...run(), id: e.run, url: `${root}/actions/runs/${e.run}` }))]);
  const r = await observeGitHubActions(i, f.io);
  expect(f.calls).toHaveLength(21); expect(r.reads).toHaveLength(actionsLimits.expectations);
  expect(cell(r)?.verdict).toBe("incident"); expect(decodeBatch(i.context, r.reads).invalid).toBe(false);
});
it.each([null, {}, [], { workflow_runs: [] }, { expectation: input().context.expected[0], created: 0, started: 1, updated: 2, status: "completed", conclusion: "success" }])("does not treat empty/list/proposed normalized envelope as API evidence %#", async value => {
  const r = await observeGitHubActions(input(), fixture([workflow(), value]).io);
  expect(cell(r)?.verdict).toBe("unknown"); expect(r.reads).toHaveLength(0);
});
it("stops on total byte budget without losing earlier positive failures", async () => {
  const i = input(); i.context.expected = Array.from({ length: 20 }, (_, n) => ({ ...i.context.expected[0], run: 30433642 + n }));
  i.tracked = i.context.expected.map((expectation, n) => ({ expectation, identity: n.toString(16).padStart(64, "0"), ref: "refs/heads/main" }));
  const f = fixture([workflow(), ...i.context.expected.map(e => ({ ...run(), id: e.run, url: `${root}/actions/runs/${e.run}`, ignored: "x".repeat(60_000) }))]);
  const r = await observeGitHubActions(i, f.io);
  expect(f.calls.length).toBeLessThan(21); expect(f.calls.length).toBeGreaterThan(2);
  expect(cell(r)).toMatchObject({ verdict: "incident", coverage: "partial" });
});
it("bounds mixed allowlisted workflows to 23 GETs for twenty runs", async () => {
  const i = input();
  i.context.expected = Array.from({ length: 20 }, (_, n) => ({ ...i.context.expected[0], run: 30433642 + n,
    workflow: (["deploy-worker.yml", "ci.yml", "release-plugin.yml"] as const)[n % 3], event: n % 3 === 1 ? "push" : "workflow_dispatch" }));
  i.tracked = i.context.expected.map((expectation, n) => ({ expectation, identity: n.toString(16).padStart(64, "0"), ref: "refs/heads/main" }));
  const fetcher = vi.fn(async (url: string) => {
    const e = i.context.expected.find(e => url.endsWith(`/runs/${e.run}/attempts/1`));
    const w = i.context.expected.find(e => url.endsWith(`/workflows/${e.workflow}`));
    return response(url, w ? { ...workflow(), path: `.github/workflows/${w.workflow}` } : { ...run(), id: e!.run, event: e!.event, url: `${root}/actions/runs/${e!.run}` });
  });
  const r = await observeGitHubActions(i, { fetch: fetcher as typeof fetch, now: () => now });
  expect(fetcher).toHaveBeenCalledTimes(23); expect(r.reads).toHaveLength(20); expect(r.public.coverage).toBe("complete");
});
it("stops after expiry during body read, preserving the prior exact failure", async () => {
  const i = input(), e = { ...i.context.expected[0], run: 30433643 };
  i.context.expected = [...i.context.expected, e]; i.tracked = [...i.tracked, { ...i.tracked[0], identity: "c".repeat(64), expectation: e }];
  let time = now, calls = 0, cancelled = false;
  const f = async (url: string) => {
    calls++;
    if (calls < 3) return response(url, calls === 1 ? workflow() : run());
    const r = new Response(new ReadableStream({ pull(c) { time += 60_000; c.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/json" } });
    Object.defineProperty(r, "url", { value: url }); return r;
  };
  const r = await observeGitHubActions(i, { fetch: f as typeof fetch, now: () => time });
  expect(calls).toBe(3); expect(cancelled).toBe(true); expect(r.reads).toHaveLength(1);
  expect(cell(r)).toMatchObject({ verdict: "incident", coverage: "partial" });
});
it("unrelated success and cross-candidate success cannot recover private retained failures", async () => {
  const i = input(); i.previous = (await observeGitHubActions(i, fixture().io)).state;
  const e = { ...i.context.expected[0], run: 30433643 }; i.context.expected = [e]; i.tracked = [{ ...i.tracked[0], expectation: e }];
  const unrelated = { ...run(), id: e.run, url: `${root}/actions/runs/${e.run}`, conclusion: "success", updated_at: iso(now - 1) };
  expect(cell(await observeGitHubActions(i, fixture([workflow(), unrelated]).io))?.verdict).toBe("incident");
  i.context.candidate = "d".repeat(40); e.candidate = i.context.candidate;
  expect(cell(await observeGitHubActions(i, fixture([workflow(), unrelated]).io))?.verdict).toBe("incident");
});

it.each(["disabled_manually", "disabled_inactivity", "disabled_fork", "deleted"])("still reads an outstanding historical failure when workflow metadata is %s", async state => {
  const f = fixture([{ ...workflow(), state }, run()]);
  const result = await observeGitHubActions(input(), f.io);
  expect(f.calls).toHaveLength(2);
  expect(result.reads).toHaveLength(1);
  expect(cell(result)?.verdict).toBe("incident");
  expect(result.state?.workflowFailures).toEqual(input().context.expected);
});
