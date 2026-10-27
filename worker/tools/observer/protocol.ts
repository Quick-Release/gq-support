import { decodeObserverSnapshot, observerOutcomes, terminalOutcomes } from "../../src/observer-snapshot.ts";
/** Offline only. Original normalized fixture contracts remain proposals. The v1
 * snapshot branch adapts the actual producer wire; other sources still require
 * wire/transport adapters. Provenance is independent of all body assertions. */
export const classes = ["http_unavailable", "worker_errors", "cron_start_missing", "cron_incomplete",
  "workflow_failure", "deployment_drift", "telemetry_unavailable", "alert_route_unavailable"] as const;
export type Class = typeof classes[number];
export type Stage = "staging" | "prod";
export type Source = "http" | "analytics" | "snapshot" | "workflow" | "deployment" | "route";
export type Coverage = "complete" | "partial" | "unknown";
export type Verdict = "incident" | "clear" | "unknown" | "excluded";
const minute = 60_000;
// All windows are proposals, not approved SLOs. HTTP confirmation window: 15 min.
export const proposals = { freshness: 2 * minute, completion: 3 * minute, httpWindow: 15 * minute,
  workflowStall: 30 * minute, ring: 60 * minute } as const;
export interface Expectation {
  repo: "Quick-Release/gq-support";
  workflow: "deploy-worker.yml" | "ci.yml" | "release-plugin.yml";
  event: "workflow_dispatch" | "push";
  run: number; attempt: number; head: string; stage: Stage; candidate: string;
}
/** Reviewed private context, never populated from response fields. Times are UTC ms. */
export interface Context {
  now: number; stage: Stage; account: "8f38791a8c37b182239af2a385ab3c31";
  candidate: string; activation: number; generation: number;
  exclusions: readonly { from: number; to: number; generation: number }[];
  expected: readonly Expectation[];
}
/** Trusted adapter/transport observation. This interface makes no TLS claim.
 * observed identifies one independent runner observation; replay is not a new run.
 * coverage includes pagination, source entitlement, sampling/lag and truncation. */
export interface Read {
  source: Source; observed: number; at: number; from: number; to: number;
  account: string; stage: Stage; candidate: string; generation: number;
  status: "ok" | "denied" | "unavailable"; coverage: Coverage;
  pages: number; body: Uint8Array;
  /** Set by a future fixed-route transport, never by JSON health assertions. */
  vantage?: "available" | "unavailable";
}
const outcomes = ["ok", "failed", "timed_out", "contained", "not_run"] as const;
type Outcome = typeof outcomes[number];
type Phases = { delivery: Outcome; cleanup: Outcome; refresh: Outcome; sweep: Outcome; drain: Outcome };
interface Tick { slot: number; attempt: number; start: number; terminal: number | null; phases: Phases | null; outcome?: "settled" | "failed" | "interrupted" | null }
interface Snapshot {
  generated: number; stage: Stage; candidate: string; activation: number | null; generation: number;
  from: number; to: number; storage: "ok" | "unavailable"; ticks: Tick[]; coverageUnknown?: boolean;
}
interface Workflow extends Expectation {
  created: number; started: number | null; updated: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "timed_out" | "action_required" | "cancelled" | "skipped" | null;
}
interface Analytics { rows: { at: number; requests: number; errors: number }[] }
type Payload = Snapshot | Workflow | Analytics | { result: "available" | "unavailable" }
  | { candidate: string } | { state: "disabled" | "ready" | "blocked_unknown" | "rate_limited" };
interface Evidence { read: Omit<Read, "body">; payload: Payload | null }
export interface Batch { readonly evidence: readonly Evidence[]; readonly invalid: boolean }
const bad = () => { throw new Error("invalid_observer_input"); };
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) return bad();
  return r;
}
function integer(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max) return bad();
  return v;
}
function choice<const T extends readonly string[]>(v: unknown, values: T): T[number] {
  if (typeof v !== "string" || !values.includes(v)) return bad();
  return v;
}
function sha(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v)) return bad();
  return v;
}
function time(v: unknown, now: number): number {
  const n = integer(v); if (n > now) return bad(); return n;
}
function rows(v: unknown, max = 100): unknown[] {
  if (!Array.isArray(v) || v.length > max) return bad(); return v;
}
function expectation(v: unknown): Expectation {
  const r = object(v, ["repo", "workflow", "event", "run", "attempt", "head", "stage", "candidate"]);
  const e = { repo: choice(r.repo, ["Quick-Release/gq-support"]),
    workflow: choice(r.workflow, ["deploy-worker.yml", "ci.yml", "release-plugin.yml"]),
    event: choice(r.event, ["workflow_dispatch", "push"]), run: integer(r.run), attempt: integer(r.attempt),
    head: sha(r.head), stage: choice(r.stage, ["staging", "prod"]), candidate: sha(r.candidate) };
  if (!e.run || !e.attempt || (e.workflow === "deploy-worker.yml" && e.event !== "workflow_dispatch") ||
    (e.workflow === "ci.yml" && e.event !== "push")) return bad();
  return e;
}
function context(c: Context): void {
  time(c.now, c.now); time(c.activation, c.now); integer(c.generation); sha(c.candidate);
  choice(c.stage, ["staging", "prod"]);
  if (c.account !== "8f38791a8c37b182239af2a385ab3c31") bad();
  const expected = rows(c.expected, 20).map(expectation);
  if (new Set(expected.map(e => `${e.run}/${e.attempt}`)).size !== expected.length) bad();
  for (const e of expected) if (e.stage !== c.stage || e.candidate !== c.candidate) bad();
  for (const x of rows(c.exclusions, 60)) {
    const r = object(x, ["from", "to", "generation"]);
    if (time(r.from, c.now) >= time(r.to, c.now) || integer(r.generation) > c.generation) bad();
  }
}
function decode(source: Source, v: unknown, c: Context, r: Read): Payload {
  if (source === "http") {
    object(v, []);
    return { result: choice(r.vantage, ["available", "unavailable"]) };
  }
  if (source === "deployment") {
    const o = object(v, ["candidate"]); return { candidate: sha(o.candidate) };
  }
  if (source === "route") {
    const o = object(v, ["state"]);
    return { state: choice(o.state, ["disabled", "ready", "blocked_unknown", "rate_limited"]) };
  }
  if (source === "analytics") {
    const o = object(v, ["rows"]);
    return { rows: rows(o.rows).map(v => {
      const a = object(v, ["at", "requests", "errors"]);
      const at = time(a.at, r.at), requests = integer(a.requests, 999999), errors = integer(a.errors, 999999);
      if (at < r.from || at > r.to || errors > requests) return bad();
      return { at, requests, errors };
    }) };
  }
  if (source === "workflow") {
    const o = object(v, ["expectation", "created", "started", "updated", "status", "conclusion"]);
    const e = expectation(o.expectation);
    if (!c.expected.some(x => sameExpectation(x, e))) return bad();
    const created = time(o.created, r.at), updated = time(o.updated, r.at);
    const started = o.started === null ? null : time(o.started, updated);
    const status = choice(o.status, ["queued", "in_progress", "completed"]);
    const conclusion = o.conclusion === null ? null : choice(o.conclusion,
      ["success", "failure", "timed_out", "action_required", "cancelled", "skipped"]);
    if (created > updated || (started !== null && started < created) ||
      (status === "completed") !== (conclusion !== null) || (status === "in_progress" && started === null)) bad();
    return { ...e, created, started, updated, status, conclusion };
  }
  // Actual v1 wire adapter. Body cannot grant transport provenance or activation.
  if (v && typeof v === "object" && Object.hasOwn(v, "version")) {
    const wire = decodeObserverSnapshot(v, r.at);
    if (wire.stage !== c.stage || wire.candidate !== c.candidate || wire.generation !== c.generation) return bad();
    const ticks: Tick[] = wire.ticks.filter(t => t[0] === c.stage && t[1] === c.candidate && t[2] === c.generation).map(t => ({
      slot: t[3], attempt: t[4], start: t[5], terminal: t[6], outcome: t[7] === null ? null : terminalOutcomes[t[7]],
      phases: { delivery: observerOutcomes[t[8]], cleanup: observerOutcomes[t[9]],
        refresh: observerOutcomes[t[10]], sweep: observerOutcomes[t[11]], drain: observerOutcomes[t[12]] },
    }));
    // The producer has no activation/continuous-coverage witness. Always unknown,
    // even when a caller accidentally labels transport coverage complete.
    return { generated: wire.generated, stage: wire.stage, candidate: wire.candidate, activation: null,
      generation: wire.generation, from: r.from, to: r.to, storage: "ok", ticks, coverageUnknown: true };
  }
  const o = object(v, ["generated", "stage", "candidate", "activation", "generation", "from", "to", "storage", "ticks"]);
  const generated = time(o.generated, r.at), from = time(o.from, generated), to = time(o.to, generated);
  if (o.stage !== c.stage || o.candidate !== c.candidate || o.activation !== c.activation ||
    o.generation !== c.generation || from > to || to - from > proposals.ring || from !== r.from || to !== r.to) bad();
  const ticks = rows(o.ticks).map(v => {
    const t = object(v, ["slot", "attempt", "start", "terminal", "phases"]);
    const slot = time(t.slot, generated), attempt = integer(t.attempt, 4), start = time(t.start, generated);
    const terminal = t.terminal === null ? null : time(t.terminal, generated);
    if (slot % minute || !attempt || slot < from || slot >= to || slot < c.activation || start < slot ||
      (terminal !== null && terminal < start) || (terminal === null) !== (t.phases === null)) bad();
    let phases: Phases | null = null;
    if (t.phases !== null) {
      const p = object(t.phases, ["delivery", "cleanup", "refresh", "sweep", "drain"]);
      phases = { delivery: choice(p.delivery, outcomes), cleanup: choice(p.cleanup, outcomes),
        refresh: choice(p.refresh, outcomes), sweep: choice(p.sweep, outcomes), drain: choice(p.drain, outcomes) };
    }
    return { slot, attempt, start, terminal, phases };
  });
  if (new Set(ticks.map(t => `${t.slot}/${t.attempt}`)).size !== ticks.length) bad();
  return { generated, from, to, stage: c.stage, candidate: c.candidate, activation: c.activation,
    generation: c.generation, storage: choice(o.storage, ["ok", "unavailable"]), ticks };
}
function sameExpectation(a: Expectation, b: Expectation): boolean {
  return a.repo === b.repo && a.workflow === b.workflow && a.event === b.event && a.run === b.run &&
    a.attempt === b.attempt && a.head === b.head && a.stage === b.stage && a.candidate === b.candidate;
}
/** Check bytes BEFORE JSON. Batch/row/page bounds are hard stops, with fixed errors.
 * Partial positive error observations survive, but partial input cannot prove health. */
export function decodeBatch(c: Context, reads: readonly Read[]): Batch {
  try { context(c); } catch { return { evidence: [], invalid: true }; }
  if (reads.length > 32 || reads.reduce((n, r) => n + r.body.byteLength, 0) > 1024 * 1024)
    return { evidence: [], invalid: true };
  let invalid = false;
  const evidence: Evidence[] = [];
  if (reads.filter(r => r.source === "workflow").length > 20) return { evidence: [], invalid: true };
  const pages = new Map<Source, number>();
  for (const r of reads) {
    const { body, ...provenance } = r;
    let payload: Payload | null = null;
    try {
      choice(r.source, ["http", "analytics", "snapshot", "workflow", "deployment", "route"]);
      choice(r.status, ["ok", "denied", "unavailable"]); choice(r.coverage, ["complete", "partial", "unknown"]);
      time(r.at, c.now); integer(r.observed); integer(r.pages, 3);
      if (r.from > r.to || time(r.to, r.at) < time(r.from, r.at) || r.account !== c.account ||
        r.stage !== c.stage || r.candidate !== c.candidate || r.generation !== c.generation) bad();
      pages.set(r.source, (pages.get(r.source) ?? 0) + r.pages);
      if (r.source === "workflow" && (pages.get(r.source) ?? 0) > 3) bad();
      if (body.byteLength > 65536 || r.status !== "ok") bad();
      payload = decode(r.source, JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body)), c, r);
    } catch { invalid = true; }
    evidence.push({ read: provenance, payload });
  }
  return { evidence, invalid };
}
interface Cell {
  active: boolean; count: number; first: number; last: number; watermark: number; observedAt: number;
  candidate: string; generation: number;
}
interface CronFailure { slot: number; attempt: number; terminal: number; open: boolean }
interface HttpSample { observed: number; at: number; failed: boolean; candidate: string; generation: number }
/** In-memory carry only. No persistence, durable ownership, send permission or receipt. */
export interface State {
  stage: Stage; cells: readonly Cell[]; http: readonly HttpSample[];
  workflowFailures: readonly Expectation[]; workflowOverflow: boolean;
  cronFailures: readonly CronFailure[]; cronOverflow: boolean;
}
export interface PublicVerdict {
  stage: Stage; at: number;
  classes: readonly { class: Class; verdict: Verdict; count: number; first: number; last: number; coverage: Coverage }[];
}
export interface Evaluation { state: State; public: PublicVerdict }
interface Signal { verdict: Verdict; at: number; from: number; observedAt: number; coverage: Coverage }
const unknown = (): Signal => ({ verdict: "unknown", at: 0, from: 0, observedAt: 0, coverage: "unknown" });
function fresh(e: Evidence, c: Context): boolean {
  return e.payload !== null && e.read.at >= c.now - proposals.freshness;
}
function complete(e: Evidence, c: Context): boolean {
  return fresh(e, c) && e.read.coverage === "complete";
}
/** Unknown NEVER recovers an incident. A clear requires affirmative fresh covering
 * source evidence newer than its failure watermark, for the same candidate and
 * maintenance generation. Failures at equal watermarks win over success. */
export function evaluate(c: Context, batch: Batch, previous?: State): Evaluation {
  // Overflow is unavailable coverage, never silent expectation eviction.
  if (c.expected.length > 20) return evaluate({ ...c, expected: [] }, { evidence: [], invalid: true }, previous);
  context(c);
  if (previous && (previous.stage !== c.stage || previous.cells.length !== classes.length || previous.http.length > 32 || previous.workflowFailures.length > 20 || previous.cronFailures.length > 100)) bad();
  const signals = classes.map(unknown);
  const put = (key: Class, verdict: Verdict, e: Evidence, at = e.read.to, from = e.read.from) => {
    const index = classes.indexOf(key), old = signals[index];
    // Failure evidence always dominates successful evidence in the same batch.
    if (old.verdict === "incident" && verdict !== "incident") return;
    if (at < old.at && old.verdict === verdict) return;
    if (verdict !== "incident" && at < old.at) return;
    signals[index] = { verdict, at, from, observedAt: e.read.at, coverage: e.read.coverage };
  };
  const excluded = (slot: number) => c.exclusions.some(x => slot >= x.from && slot < x.to);
  let httpEvidence = false;
  const http = new Map<number, HttpSample>();
  for (const h of previous?.http ?? []) if (h.at >= c.now - proposals.httpWindow && h.candidate === c.candidate && h.generation === c.generation) http.set(h.observed, { ...h });
  let telemetryUnknown = batch.invalid || batch.evidence.length === 0;
  const seen = new Set<Source>();
  const workflows: { e: Evidence; w: Workflow }[] = [];
  const workflowFailures = [...previous?.workflowFailures ?? []];
  let workflowOverflow = previous?.workflowOverflow ?? false;
  const cronFailures = [...previous?.cronFailures ?? []];
  let cronOverflow = previous?.cronOverflow ?? false;
  for (const e of batch.evidence) {
    const { read: r, payload: p } = e;
    seen.add(r.source);
    if (!complete(e, c)) telemetryUnknown = true;
    if (!p) continue;
    if (r.source === "http" && complete(e, c)) {
      httpEvidence = true;
      const failed = (p as { result: string }).result === "unavailable";
      const old = http.get(r.observed);
      if (!old || (old.at === r.at && failed)) http.set(r.observed, { observed: r.observed, at: old?.at ?? r.at, failed: old?.failed || failed, candidate: c.candidate, generation: c.generation });
    }
    if (r.source === "analytics") {
      // Sampling/lag unknown does not invalidate positive corroboration.
      const a = p as Analytics;
      if (fresh(e, c) && a.rows.some(x => x.errors > 0))
        put("worker_errors", "incident", e, Math.max(...a.rows.filter(x => x.errors > 0).map(x => x.at)));
      // Zero, even with complete coverage, is never affirmative recovery.
    }
    if (r.source === "snapshot") {
      const s = p as Snapshot;
      if (!fresh(e, c) || s.generated < c.now - proposals.freshness || s.storage !== "ok") { telemetryUnknown = true; continue; }
      let incomplete = false, contained = false;
      for (const t of s.ticks) {
        const values = t.phases && Object.values(t.phases);
        if (t.outcome === "failed" || t.outcome === "interrupted" || values?.some(v => v === "failed" || v === "timed_out") ||
          (t.terminal === null && c.now - t.start >= proposals.completion)) {
          put("cron_incomplete", "incident", e, t.slot); incomplete = true;
          const known = cronFailures.findIndex(x => x.slot === t.slot && x.attempt === t.attempt);
          const failure = { slot: t.slot, attempt: t.attempt, terminal: t.terminal ?? r.at, open: t.terminal === null };
          if (known < 0) {
            if (cronFailures.length === 100) cronOverflow = true;
            else cronFailures.push(failure);
          } else if (t.terminal !== null && cronFailures[known].open) cronFailures[known] = failure;
        } else if (values?.some(v => v === "contained" || v === "not_run")) contained = true;
      }
      if (s.coverageUnknown || !complete(e, c)) { telemetryUnknown = true; continue; }
      const end = Math.floor(c.now / minute) * minute - 2 * minute, start = end - 10 * minute;
      const covered = s.from <= start && s.to >= end && c.activation <= start;
      const expected = Array.from({ length: 10 }, (_, i) => start + i * minute).filter(t => !excluded(t));
      if (covered && expected.length && !s.ticks.some(t => expected.includes(t.slot))) put("cron_start_missing", "incident", e, end, start);
      else if (covered && expected.length && expected.every(slot => s.ticks.some(t => t.slot === slot))) put("cron_start_missing", "clear", e, end, start);
      else if (covered && !expected.length) put("cron_start_missing", "excluded", e);
      const allOk = s.ticks.length > 0 && s.ticks.every(t => t.terminal !== null && t.phases && Object.values(t.phases).every(v => v === "ok"));
      const reconciled = !cronOverflow && cronFailures.every(f => s.ticks.some(t =>
        t.slot === f.slot && (t.attempt > f.attempt || (f.open && t.attempt === f.attempt)) && t.terminal !== null && t.terminal > f.terminal &&
        t.phases && Object.values(t.phases).every(v => v === "ok")));
      if (!incomplete && reconciled && allOk && covered && expected.length > 0 && expected.every(slot => s.ticks.some(t => t.slot === slot))) put("cron_incomplete", "clear", e);
      else if (!incomplete && covered && expected.length === 0) put("cron_incomplete", "excluded", e);
      else if (!incomplete && contained && s.ticks.every(t => excluded(t.slot))) put("cron_incomplete", "excluded", e);
    }
    if (r.source === "workflow" && fresh(e, c)) workflows.push({ e, w: p as Workflow });
    if (r.source === "deployment" && complete(e, c)) put("deployment_drift", (p as { candidate: string }).candidate === c.candidate ? "clear" : "incident", e);
    if (r.source === "route" && complete(e, c)) {
      const state = (p as { state: string }).state;
      put("alert_route_unavailable", state === "ready" ? "clear" : state === "disabled" ? "excluded" : "incident", e);
    }
  }
  // A failed tracked attempt remains visible even if outside 24 h discovery.
  for (const { e, w } of workflows) {
    if (["failure", "timed_out", "action_required"].includes(w.conclusion ?? "")) {
      put("workflow_failure", "incident", e, w.updated, w.created);
      if (!workflowFailures.some(x => sameExpectation(x, w))) {
        if (workflowFailures.length === 20) workflowOverflow = true;
        else workflowFailures.push({ repo: w.repo, workflow: w.workflow, event: w.event, run: w.run,
          attempt: w.attempt, head: w.head, stage: w.stage, candidate: w.candidate });
      }
    }
  }
  if (!workflowOverflow && workflowFailures.every(x => workflows.some(({ w }) => sameExpectation({ ...w, attempt: x.attempt }, x) && w.attempt > x.attempt && w.conclusion === "success")) &&
    c.expected.length && c.expected.every(x => workflows.some(({ w }) => sameExpectation(w, x) && w.conclusion === "success")) &&
    workflows.every(({ e, w }) => complete(e, c) && w.conclusion === "success")) {
    const e = workflows.reduce((a, b) => a.w.updated < b.w.updated ? a : b).e;
    put("workflow_failure", "clear", e, Math.min(...workflows.map(x => x.w.updated)), Math.min(...workflows.map(x => x.w.created)));
  } else if (c.expected.length && !signals[4].at) telemetryUnknown = true;
  const samples = [...http.values()].sort((a, b) => b.at - a.at || Number(b.failed) - Number(a.failed)).slice(0, 32);
  const pair = samples.slice(0, 2);
  if (httpEvidence && pair.length === 2 && pair[0].at > pair[1].at && pair[0].at >= c.now - proposals.freshness && pair.every(h => h.failed === pair[0].failed) && pair[1].at >= c.now - proposals.httpWindow) {
    signals[0] = { verdict: pair[0].failed ? "incident" : "clear", at: pair[0].at, from: pair[1].at, observedAt: pair[0].at, coverage: "complete" };
  }
  if (["http", "analytics", "snapshot", "workflow", "deployment", "route"].some(s => !seen.has(s as Source))) telemetryUnknown = true;
  signals[6] = { verdict: telemetryUnknown ? "incident" : "clear", at: c.now, from: 0, observedAt: c.now, coverage: telemetryUnknown ? "unknown" : "complete" };
  const cells = classes.map((_, i): Cell => {
    const old = previous?.cells[i] ?? { active: false, count: 0, first: 0, last: 0, watermark: 0, observedAt: 0, candidate: c.candidate, generation: c.generation };
    const s = signals[i];
    // A newly discovered unresolved attempt may precede a recovered coverage
    // watermark. Its identity still owns an incident; coverage is not a ledger
    // of all failures that could arrive later.
    if (s.verdict === "incident" && (s.at >= old.watermark || (i === 3 && cronFailures.length > 0))) return {
      active: true, count: Math.min(999999, old.count + Number(!old.active || s.at > old.watermark)),
      first: old.active ? old.first : s.at, last: Math.max(old.last, s.at), watermark: Math.max(old.watermark, s.at), observedAt: Math.max(old.observedAt, s.observedAt),
      candidate: old.active ? old.candidate : c.candidate, generation: old.active ? old.generation : c.generation,
    };
    if (!batch.invalid && s.verdict === "clear" && s.at > old.watermark && s.observedAt > old.observedAt &&
      (i === 0 || i === 4 || i === 5 || i === 7 || s.from <= old.first) &&
      old.candidate === c.candidate && old.generation === c.generation) return { ...old, active: false, watermark: s.at, observedAt: s.observedAt };
    return { ...old };
  });
  const result: PublicVerdict = { stage: c.stage, at: c.now, classes: classes.map((key, i) => ({ class: key,
    verdict: cells[i].active ? "incident" : signals[i].verdict, count: cells[i].count,
    first: cells[i].first, last: cells[i].last, coverage: signals[i].coverage })) };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 2048) bad();
  return { state: { stage: c.stage, cells, http: samples,
    workflowFailures: cells[4].active ? workflowFailures : [], workflowOverflow,
    cronFailures: cells[3].active ? cronFailures : [], cronOverflow }, public: result };
}

export type Receipt = "none" | "dispatching" | "blocked_unknown" | "transport_confirmed";
/** Negative-vector model only: no journal/authenticated human reconciliation.
 * An uncertain prior send cannot be reconciled by a later response or evaluator.
 * Discord confirmation never implies human acknowledgment. */
export function receiptView(previous: Receipt, observed: Receipt): { receipt: Receipt; human: "unknown" } {
  choice(previous, ["none", "dispatching", "blocked_unknown", "transport_confirmed"]);
  choice(observed, ["none", "dispatching", "blocked_unknown", "transport_confirmed"]);
  return { receipt: previous === "dispatching" || previous === "blocked_unknown" || observed === "dispatching"
    ? "blocked_unknown" : previous === "transport_confirmed" && observed === "none" ? previous : observed,
  human: "unknown" };
}
