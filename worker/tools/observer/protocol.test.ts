import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classes, decodeBatch, evaluate, receiptView, type Class, type Context, type Read, type Source, type State } from "./protocol.ts";
import { projectAnalytics } from "./analytics-wire.ts";

const canary = () => "gqcanary_" + randomBytes(16).toString("hex");
const privateCanary = canary();
const M = 60_000, NOW = 120 * M, SHA = "a".repeat(40), OTHER = "b".repeat(40);
const clock = (offset = 0): Context => ({ now: NOW + offset, stage: "staging", account: "8f38791a8c37b182239af2a385ab3c31",
  candidate: SHA, activation: 0, generation: 1, exclusions: [], expected: [] });
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const transport = (source: Source, value: unknown, options: Partial<Read> = {}, c = clock()): Read => ({
  source, observed: 1, at: c.now, from: c.now - 20 * M, to: c.now, account: c.account,
  stage: c.stage, candidate: c.candidate, generation: c.generation, status: "ok", coverage: "complete", pages: 0,
  body: encode(source === "http" ? {} : value),
  ...(source === "http" ? { vantage: (value as { result: "available" | "unavailable" }).result } : {}), ...options,
});
const phases = { delivery: "ok", cleanup: "ok", refresh: "ok", sweep: "ok", drain: "ok" };
const tick = (slot = NOW - 5 * M, extra = {}) => ({ slot, attempt: 1, start: slot, terminal: slot + 1000, phases, ...extra });
const snapshot = (ticks: unknown[], extra = {}, c = clock()) => ({ generated: c.now, stage: c.stage,
  candidate: c.candidate, activation: c.activation, generation: c.generation, from: c.now - 20 * M, to: c.now,
  storage: "ok", ticks, ...extra });
const ring = () => Array.from({ length: 10 }, (_, i) => tick(NOW - (12 - i) * M));
const run = (reads: Read[], c = clock(), state?: State) => evaluate(c, decodeBatch(c, reads), state);
const verdict = (key: Class, reads: Read[], c = clock(), state?: State) => run(reads, c, state).public.classes.find(x => x.class === key)!;
const expectation = (extra = {}) => ({ repo: "Quick-Release/gq-support" as const, workflow: "deploy-worker.yml" as const,
  event: "workflow_dispatch" as const, run: 123, attempt: 1, head: SHA, stage: "staging" as const, candidate: SHA, ...extra });
const workflow = (conclusion: string | null, extra = {}) => ({ expectation: expectation(), created: 0,
  started: 1000, updated: NOW - M, status: conclusion ? "completed" : "in_progress", conclusion, ...extra });

describe("bounded proposed protocol", () => {
  it("returns eight fixed classes and no whole-MVP-ready verdict", () => {
    const p = run([]).public;
    expect(p.classes.map(x => x.class)).toEqual(classes);
    expect(p.classes.every(x => x.verdict !== "clear")).toBe(true);
    expect(verdict("telemetry_unavailable", []).verdict).toBe("incident");
  });
  it.each([null, {}, { healthy: true }, { rows: [], email: privateCanary }])("rejects malformed/injected normalized input %#", value => {
    const read = transport("analytics", value);
    expect(decodeBatch(clock(), [read]).invalid).toBe(true);
    expect(JSON.stringify(run([read]).public)).not.toContain(privateCanary);
  });
  it.each([{ status: "denied" }, { status: "unavailable" }, { stage: "prod" }, { candidate: OTHER },
    { account: "wrong" }, { generation: 2 }, { at: NOW + 1 }, { coverage: "partial" } ] as Partial<Read>[])("never accepts unavailable provenance %#", options => {
    expect(verdict("cron_start_missing", [transport("snapshot", snapshot([]), options)]).verdict).toBe("unknown");
  });
  it("rejects invalid UTF-8 and JSON without reflecting body", () => {
    for (const body of [new Uint8Array([255]), encode(privateCanary), new TextEncoder().encode('{"rows":')]) {
      expect(decodeBatch(clock(), [transport("analytics", null, { body })]).invalid).toBe(true);
    }
  });
  it("bounds response bytes before JSON and the total batch before per-response decoding", () => {
    expect(decodeBatch(clock(), [transport("analytics", null, { body: new Uint8Array(65537) })]).invalid).toBe(true);
    expect(decodeBatch(clock(), Array.from({ length: 17 }, () => transport("analytics", null, { body: new Uint8Array(65536) }))).evidence).toEqual([]);
  });
  it("bounds rows, pages and outstanding expectations without silent eviction", () => {
    expect(decodeBatch(clock(), [transport("analytics", { rows: Array(101).fill({ at: NOW, requests: 1, errors: 0 }) })]).invalid).toBe(true);
    const c = { ...clock(), expected: Array.from({ length: 21 }, (_, i) => expectation({ run: i + 1 })) };
    expect(decodeBatch(c, []).invalid).toBe(true);
    expect(verdict("workflow_failure", [], c).verdict).toBe("unknown");
    expect(verdict("telemetry_unavailable", [], c).verdict).toBe("incident");
    const w = { ...clock(), expected: [expectation()] };
    expect(decodeBatch(w, [transport("workflow", workflow("success"), { pages: 2 }), transport("workflow", workflow("success"), { pages: 2 })]).invalid).toBe(true);
  });
  it("keeps public data fixed and below 2 KiB", () => {
    const s = run([]).state;
    const output = run([], clock(M), s).public;
    expect(encode(output).length).toBeLessThanOrEqual(2048);
    expect(Object.keys(output)).toEqual(["stage", "at", "classes"]);
    for (const item of output.classes) expect(Object.keys(item)).toEqual(["class", "verdict", "count", "first", "last", "coverage"]);
    expect(JSON.stringify(output)).not.toMatch(/canary|https:|candidate|account|human|ready|head/);
  });
});


  it("rejects HTTP body assertions: vantage availability comes only from trusted transport context", () => {
    const r = transport("http", { result: "available" }, { body: encode({ healthy: true, account: clock().account }) });
    expect(decodeBatch(clock(), [r]).invalid).toBe(true);
    expect(verdict("http_unavailable", [r, r]).verdict).toBe("unknown");
  });
  it("fresh source coverage can close telemetry gaps, while unknown input cannot", () => {
    const state = run([]).state;
    const c = { ...clock(M), expected: [expectation()] };
    const reads = [transport("http", { result: "available" }, {}, c),
      transport("snapshot", snapshot(ring(), {}, c), {}, c),
      transport("analytics", { rows: [] }, {}, c),
      transport("workflow", workflow("success", { updated: NOW }), {}, c),
      transport("deployment", { candidate: SHA }, {}, c), transport("route", { state: "ready" }, {}, c)];
    expect(verdict("telemetry_unavailable", reads, c, state).verdict).toBe("clear");
    expect(verdict("worker_errors", reads, c, state).verdict).toBe("unknown");
    expect(verdict("cron_incomplete", [], c, state).verdict).toBe("unknown");
  });
  it("rejects impossible analytics counts and future bucket times", () => {
    for (const row of [{ at: NOW + 1, requests: 2, errors: 1 }, { at: NOW, requests: 0, errors: 1 },
      { at: NOW, requests: -1, errors: 0 }, { at: NOW, requests: 2.5, errors: 1 }])
      expect(decodeBatch(clock(), [transport("analytics", { rows: [row] })]).invalid).toBe(true);
  });

describe("Cron logical absence versus unavailable telemetry", () => {
  it("valid fresh covering empty ring is missing-start evidence, never proven nonexecution", () => {
    const reads = [transport("snapshot", snapshot([]))];
    expect(verdict("cron_start_missing", reads).verdict).toBe("incident");
    expect(verdict("cron_incomplete", reads).verdict).toBe("unknown");
    expect(verdict("cron_start_missing", [transport("snapshot", null)]).verdict).toBe("unknown");
  });
  it.each([{ generated: NOW - 3 * M, to: NOW - 3 * M }, { generated: NOW + 1 }, { storage: "unavailable" },
    { from: NOW - 5 * M }, { activation: M }, { generation: 2 }, { stage: "prod" }, { candidate: OTHER }])("rejects stale/wrong/uncovering rings %#", extra => {
    const s = snapshot([], extra);
    expect(verdict("cron_start_missing", [transport("snapshot", s, { from: s.from, to: s.to })]).verdict).toBe("unknown");
  });
  it("does not infer completion from a start; grace is proposed three minutes", () => {
    const old = [transport("snapshot", snapshot([tick(undefined, { terminal: null, phases: null })]))];
    expect(verdict("cron_incomplete", old).verdict).toBe("incident");
    const young = [transport("snapshot", snapshot([tick(NOW - 2 * M, { terminal: null, phases: null })]))];
    expect(verdict("cron_incomplete", young).verdict).toBe("unknown");
  });
  it.each(["failed", "timed_out"])("keeps explicit %s even with a later successful attempt", outcome => {
    const t = tick(undefined, { phases: { ...phases, delivery: outcome } });
    expect(verdict("cron_incomplete", [transport("snapshot", snapshot([t, tick(undefined, { attempt: 2 })]))]).verdict).toBe("incident");
  });
  it("containment needs explicit exclusion and cannot mask an earlier failure", () => {
    const c = { ...clock(), exclusions: [{ from: NOW - 10 * M, to: NOW, generation: 1 }] };
    const contained = tick(undefined, { phases: { ...phases, delivery: "contained" } });
    expect(verdict("cron_incomplete", [transport("snapshot", snapshot([contained]))]).verdict).toBe("unknown");
    expect(verdict("cron_incomplete", [transport("snapshot", snapshot([contained]))], c).verdict).toBe("excluded");
    const failure = tick(NOW - 6 * M, { phases: { ...phases, cleanup: "failed" } });
    expect(verdict("cron_incomplete", [transport("snapshot", snapshot([failure, contained]))], c).verdict).toBe("incident");
  });
  it.each([ { attempt: 0 }, { attempt: 5 }, { slot: NOW - 1 }, { start: NOW + 1 },
    { start: NOW - 6 * M }, { terminal: NOW - 6 * M }, { terminal: null }, { phases: { ...phases, delivery: "healthy" } } ])("rejects invalid tick ordering/phase/attempt %#", extra => {
    expect(decodeBatch(clock(), [transport("snapshot", snapshot([tick(undefined, extra)]))]).invalid).toBe(true);
  });

  it("valid partial Cron failures remain positive evidence without proving missing starts", () => {
    const r = transport("snapshot", snapshot([tick(undefined, { phases: { ...phases, drain: "failed" } })]), { coverage: "partial" });
    expect(verdict("cron_incomplete", [r]).verdict).toBe("incident");
    expect(verdict("cron_start_missing", [r]).verdict).toBe("unknown");
  });
  it("explicit maintenance exclusions can exclude absence, but never recover a latched failure", () => {
    const state = run([transport("snapshot", snapshot([]))]).state;
    const c = { ...clock(M), exclusions: [{ from: NOW - 20 * M, to: NOW + M, generation: 1 }] };
    const r = transport("snapshot", snapshot([], {}, c), {}, c);
    expect(verdict("cron_start_missing", [r], c).verdict).toBe("excluded");
    expect(verdict("cron_start_missing", [r], c, state).verdict).toBe("incident");
  });

  it("rejects duplicate slots/attempts and rings over sixty minutes", () => {
    expect(decodeBatch(clock(), [transport("snapshot", snapshot([tick(), tick()]))]).invalid).toBe(true);
    const s = snapshot([], { from: NOW - 61 * M });
    expect(decodeBatch(clock(), [transport("snapshot", s, { from: s.from })]).invalid).toBe(true);
  });
  it("does not recover on unknown, stale, duplicate, out-of-order or newer generation evidence", () => {
    const failed = transport("snapshot", snapshot([tick(undefined, { phases: { ...phases, sweep: "failed" } })]));
    const first = run([failed]);
    const oldSuccess = transport("snapshot", snapshot(ring(), { generated: NOW - M, to: NOW - M }), { at: NOW - M, to: NOW - M });
    expect(verdict("cron_incomplete", [oldSuccess], clock(), first.state).verdict).toBe("incident");
    expect(verdict("cron_incomplete", [], clock(M), first.state).verdict).toBe("incident");
    const next = clock(M);
    expect(verdict("cron_incomplete", [transport("snapshot", snapshot(ring(), {}, next), {}, next)], next, first.state).verdict).toBe("incident");
    const c = { ...clock(M), generation: 2 };
    expect(verdict("cron_incomplete", [transport("snapshot", snapshot(ring(), {}, c), {}, c)], c, first.state).verdict).toBe("incident");
    expect(verdict("cron_incomplete", [failed], clock(), first.state).count).toBe(1);
  });
  it("explicit failure supersedes an incomplete-start latch and cannot become same-attempt success", () => {
    const state = run([transport("snapshot", snapshot([tick(undefined, { terminal: null, phases: null })]))]).state;
    const c = clock(M);
    const failed = tick(undefined, { terminal: NOW + 1000, phases: { ...phases, delivery: "failed" } });
    const next = run([transport("snapshot", snapshot([failed], {}, c), {}, c)], c, state).state;
    const c2 = clock(2 * M);
    const ticks = [...ring().filter(t => t.slot !== NOW - 5 * M), tick(undefined, { terminal: NOW + M }), tick(NOW - 2 * M), tick(NOW - M)];
    expect(verdict("cron_incomplete", [transport("snapshot", snapshot(ticks, {}, c2), {}, c2)], c2, next).verdict).toBe("incident");
  });
  it("late affirmative terminal completion resolves an incomplete start of the same attempt", () => {
    const state = run([transport("snapshot", snapshot([tick(undefined, { terminal: null, phases: null })]))]).state;
    const c = clock(M);
    const ticks = [...ring().filter(t => t.slot !== NOW - 5 * M), tick(undefined, { terminal: NOW + 1000 }), tick(NOW - 2 * M)];
    expect(verdict("cron_incomplete", [transport("snapshot", snapshot(ticks, {}, c), {}, c)], c, state).verdict).toBe("clear");
  });
  it("permits fresh affirmative covering recovery without resetting the incident count", () => {
    const state = run([transport("snapshot", snapshot([tick(undefined, { phases: { ...phases, drain: "failed" } })]))]).state;
    const c = clock(M);
    const ticks = [...ring().filter(t => t.slot !== NOW - 5 * M), tick(undefined, { attempt: 2, start: NOW, terminal: NOW + 1000 }), tick(NOW - 2 * M)];
    const v = verdict("cron_incomplete", [transport("snapshot", snapshot(ticks, {}, c), {}, c)], c, state);
    expect(v.verdict).toBe("clear"); expect(v.count).toBe(1);
  });
});

describe("analytics corroboration", () => {
  it.each([{ rows: [] }, { rows: [{ at: NOW - M, requests: 0, errors: 0 }] }, { rows: [{ at: NOW - M, requests: 10, errors: 0 }] }])("zero/empty cannot prove health %#", ({ rows }) => {
    expect(verdict("worker_errors", [transport("analytics", { rows })]).verdict).toBe("unknown");
  });
  it("preserves positive partial errors and deduplicates overlapping bucket watermarks", () => {
    const a = transport("analytics", { rows: [{ at: NOW - M, requests: 10, errors: 1 }] }, { coverage: "partial" });
    const state = run([a]).state;
    expect(verdict("worker_errors", [a]).verdict).toBe("incident");
    expect(verdict("worker_errors", [a], clock(), state).count).toBe(1);
    expect(verdict("worker_errors", [transport("analytics", { rows: [] })], clock(), state).verdict).toBe("incident");
  });
  it("projects real selected GraphQL shape separately; HTTP 200 errors/sampling never complete", () => {
    const body = encode({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ dimensions: {
      datetime: new Date(NOW - M).toISOString(), scriptName: "reviewed-worker", status: "exception", private: privateCanary },
      sum: { requests: 10, errors: 1 } }] }] } }, errors: [{ message: privateCanary }] });
    const p = projectAnalytics(body, "reviewed-worker")!;
    expect(p.coverage).toBe("partial"); expect(new TextDecoder().decode(p.body)).not.toContain(privateCanary);
    expect(verdict("worker_errors", [transport("analytics", null, p)]).verdict).toBe("incident");
    expect(projectAnalytics(encode({ data: { viewer: { accounts: [] } } }), "reviewed-worker")).toBeNull();
  });
});

describe("independent HTTP vantage and workflow expectations", () => {
  it("requires two distinct failures and two distinct successes; duplicate input is one", () => {
    const f = transport("http", { result: "unavailable" });
    const s = run([f]);
    expect(verdict("http_unavailable", [f, f]).verdict).toBe("unknown");
    const c = clock(M), f2 = transport("http", { result: "unavailable" }, { observed: 2 }, c);
    const failed = run([f2], c, s.state);
    expect(failed.public.classes[0].verdict).toBe("incident");
    const c2 = clock(2 * M), ok = transport("http", { result: "available" }, { observed: 3 }, c2);
    const one = run([ok, ok], c2, failed.state);
    expect(one.public.classes[0].verdict).toBe("incident");
    const c3 = clock(3 * M);
    expect(verdict("http_unavailable", [transport("http", { result: "available" }, { observed: 4 }, c3)], c3, one.state).verdict).toBe("clear");
  });
  it("expired HTTP failures do not manufacture a pair", () => {
    const s = run([transport("http", { result: "unavailable" })]).state;
    const c = clock(16 * M);
    expect(verdict("http_unavailable", [transport("http", { result: "unavailable" }, { observed: 2 }, c)], c, s).verdict).toBe("unknown");
  });
  it.each(["failure", "timed_out", "action_required"])("retains direct outstanding %s run older than 24h", conclusion => {
    const c = { ...clock(), now: 48 * 60 * M, expected: [expectation()] };
    const w = workflow(conclusion, { updated: c.now - M });
    expect(verdict("workflow_failure", [transport("workflow", w, {}, c)], c).verdict).toBe("incident");
  });
  it.each(["cancelled", "skipped", null])("%s is reconciliation/queue unknown, never terminal failure or health", conclusion => {
    const c = { ...clock(), expected: [expectation()] };
    expect(verdict("workflow_failure", [transport("workflow", workflow(conclusion))], c).verdict).toBe("unknown");
  });
  it.each([{ repo: "other/repo" }, { workflow: "ci.yml" }, { event: "push" }, { run: 124 }, { attempt: 2 },
    { head: OTHER }, { stage: "prod" }, { candidate: OTHER }])("joins all expectation fields exactly %#", extra => {
    const c = { ...clock(), expected: [expectation()] };
    expect(decodeBatch(c, [transport("workflow", workflow("success", { expectation: expectation(extra) }))]).invalid).toBe(true);
  });
  it("rejects workflow display text as a stage source", () => {
    const c = { ...clock(), expected: [expectation()] };
    expect(decodeBatch(c, [transport("workflow", { ...workflow("success"), display_title: "prod canary" })]).invalid).toBe(true);
  });
  it("HTTP availability cannot clear independent workflow failure or establish readiness", () => {
    const c = { ...clock(), expected: [expectation()] };
    const r = run([transport("http", { result: "available" }, { at: NOW - M, to: NOW - M }), transport("http", { result: "available" }, { observed: 2 }),
      transport("workflow", workflow("failure"))], c);
    expect(r.public.classes[0].verdict).toBe("clear"); expect(r.public.classes[4].verdict).toBe("incident");
    expect(r.public.classes[3].verdict).toBe("unknown");
  });
  it("new successful run cannot erase unresolved failed run/attempt", () => {
    const c = { ...clock(), expected: [expectation()] };
    const state = run([transport("workflow", workflow("failure"))], c).state;
    const next = { ...clock(M), expected: [expectation({ run: 124 })] };
    const w = workflow("success", { expectation: next.expected[0], updated: NOW });
    expect(verdict("workflow_failure", [transport("workflow", w, {}, next)], next, state).verdict).toBe("incident");
  });

  it("partial workflow failure remains evidence, but partial success cannot recover", () => {
    const c = { ...clock(), expected: [expectation()] };
    const failed = transport("workflow", workflow("failure"), { coverage: "partial" });
    const state = run([failed], c).state;
    expect(verdict("workflow_failure", [failed], c).verdict).toBe("incident");
    const next = { ...clock(M), expected: [expectation({ attempt: 2 })] };
    const success = transport("workflow", workflow("success", { expectation: next.expected[0], updated: NOW }), { coverage: "partial" }, next);
    expect(verdict("workflow_failure", [success], next, state).verdict).toBe("incident");
    expect(verdict("workflow_failure", [{ ...success, coverage: "complete" }], next, state).verdict).toBe("clear");
  });

  it("deployment mismatch and disabled route are separate finite evidence, no approval", () => {
    expect(verdict("deployment_drift", [transport("deployment", { candidate: OTHER })]).verdict).toBe("incident");
    expect(verdict("alert_route_unavailable", [transport("route", { state: "disabled" })]).verdict).toBe("excluded");
    expect(decodeBatch(clock(), [transport("route", { state: "ready", approved: true })]).invalid).toBe(true);
  });
});

describe("receipt negative vectors only; no custody implementation", () => {
  it.each(["dispatching", "blocked_unknown"] as const)("%s remains uncertain despite response/restart/recovery", previous => {
    for (const observed of ["none", "dispatching", "blocked_unknown", "transport_confirmed"] as const)
      expect(receiptView(previous, observed)).toEqual({ receipt: "blocked_unknown", human: "unknown" });
  });
  it("transport confirmation is never human acknowledgment", () => {
    expect(receiptView("none", "transport_confirmed")).toEqual({ receipt: "transport_confirmed", human: "unknown" });
  });
});

describe("review regressions for advancing evidence and late failure ownership", () => {
  it("cannot recover HTTP failure with different IDs at the same time", () => {
    const failed = run([
      transport("http", { result: "unavailable" }, { observed: 1, at: NOW - M, to: NOW - M }),
      transport("http", { result: "unavailable" }, { observed: 2 }),
    ]);
    expect(failed.public.classes[0].verdict).toBe("incident");
    const c = clock(M);
    const recovered = run([
      transport("http", { result: "available" }, { observed: 3 }, c),
      transport("http", { result: "available" }, { observed: 4 }, c),
    ], c, failed.state);
    expect(recovered.public.classes[0].verdict).toBe("incident");
    expect(recovered.state.cells[0].active).toBe(true);
  });
  it.each(["candidate", "generation"] as const)("does not pair HTTP samples across %s pins", (pin) => {
    const state = run([transport("http", { result: "available" })]).state;
    const c = { ...clock(M), ...(pin === "candidate" ? { candidate: OTHER } : { generation: 2 }) };
    const next = run([transport("http", { result: "available" }, { observed: 2 }, c)], c, state);
    expect(next.public.classes[0].verdict).toBe("unknown");
    expect(next.state.http).toHaveLength(1);
  });
  it("retains a late older Cron failure after a previous incident recovered", () => {
    const initial = run([transport("snapshot", snapshot([tick(undefined, { phases: { ...phases, drain: "failed" } })]))]);
    const c = clock(M);
    const recoveredTicks = [...ring().filter(t => t.slot !== NOW - 5 * M),
      tick(undefined, { attempt: 2, start: NOW, terminal: NOW + 1000 }), tick(NOW - 2 * M)];
    const recovered = run([transport("snapshot", snapshot(recoveredTicks, {}, c), {}, c)], c, initial.state);
    expect(recovered.public.classes[3].verdict).toBe("clear");
    const c2 = clock(2 * M);
    const late = tick(NOW - 10 * M, { phases: { ...phases, delivery: "failed" } });
    const discovered = run([transport("snapshot", snapshot([late], {}, c2), {}, c2)], c2, recovered.state);
    expect(discovered.public.classes[3].verdict).toBe("incident");
    expect(discovered.state.cronFailures).toHaveLength(1);
    expect(discovered.state.cells[3].watermark).toBeGreaterThanOrEqual(recovered.state.cells[3].watermark);
    expect(verdict("cron_incomplete", [], clock(3 * M), discovered.state).verdict).toBe("incident");
  });
});

describe("actual wire retained failure identity", () => {
  const wire = (c: Context, candidate = OTHER, generation = 0) => ({ version: 1, generated: c.now,
    stage: c.stage, candidate: c.candidate, generation: c.generation, maintenance: "open", watermark: NOW,
    partial: false, activation: null, coverage: "unknown", route: "disabled",
    ticks: [[c.stage, candidate, generation, NOW - 5 * M, 1, NOW - 5 * M, NOW - 4 * M, 0, 2, 1, 1, 1, 0]] });
  it("retains an explicit previous-candidate/generation failure on a fresh read", () => {
    expect(verdict("cron_incomplete", [transport("snapshot", wire(clock()))]).verdict).toBe("incident");
  });
  it("does not age out an explicit stale failure when the read itself is fresh", () => {
    const c = clock(120 * M);
    const body = { ...wire(c, SHA, 1), generated: NOW };
    expect(verdict("cron_incomplete", [transport("snapshot", body, {}, c)], c).verdict).toBe("incident");
  });
});

it("new coverage, candidate, generation and exclusions cannot reconcile an older failure identity", () => {
  const initial = run([transport("snapshot", snapshot([tick(undefined, { phases: { ...phases, cleanup: "failed" } })]))]);
  const c = { ...clock(M), candidate: OTHER, generation: 2, exclusions: [{ from: NOW - 20 * M, to: NOW, generation: 2 }] };
  const successful = snapshot(ring().map(t => ({ ...t, attempt: 2, terminal: NOW + 1 })), {}, c);
  const next = run([transport("snapshot", successful, {}, c)], c, initial.state);
  expect(next.public.classes[3].verdict).toBe("incident");
  expect(next.state.cronFailures).toMatchObject([{ candidate: SHA, generation: 1 }]);
});
