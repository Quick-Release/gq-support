// Trusted launcher library only: no ambient auth/fetch, scheduler or write API.
import { finiteInt } from "../../src/observer-snapshot.ts";
import { decodeBatch, evaluate, proposals, type Context, type Expectation, type Read, type State, type PublicVerdict } from "./protocol.ts";
import type { TransportIO } from "./https-transport.ts";

const root = "https://api.github.com/repos/Quick-Release/gq-support";
export const actionsLimits = { expectations: 20, requests: 23, bytes: 65_536, totalBytes: 524_288, chunks: 1024, ms: 10_000 } as const;
const refuse = (): never => { throw new Error("observer_actions_unknown"); };
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
function obj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) refuse();
  return v as Record<string, unknown>;
}
function positive(v: unknown): number { const n = finiteInt(v); if (!n) refuse(); return n; }
function timestamp(v: unknown, now: number): number {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v)) refuse();
  const n = Date.parse(v as string);
  if (!Number.isSafeInteger(n) || n < 0 || n > now || new Date(n).toISOString() !== (v as string).replace(/Z$/, (v as string).includes(".") ? "Z" : ".000Z")) refuse();
  return n;
}
function same(a: Expectation, b: Expectation): boolean {
  return a.repo === b.repo && a.workflow === b.workflow && a.event === b.event && a.run === b.run &&
    a.attempt === b.attempt && a.head === b.head && a.stage === b.stage && a.candidate === b.candidate;
}
export interface TrackedRun {
  /** Private parent-owned identity; never derived from title, path or response. */
  identity: string; expectation: Expectation;
  ref: "refs/heads/main" | `refs/tags/plugin-v${string}`;
}
export interface ActionsInput {
  context: Context; tracked: readonly TrackedRun[]; observation: number;
  /** Independent repository identity, not a response-selected repository. */
  repositoryId: number;
  /** Dedicated explicit Actions:read credential. No existing bundle reuse. */
  actionsReadToken: string; expiresAt: number; previous?: State;
}
export interface ActionsResult {
  public: { coverage: "complete" | "partial" | "unknown"; verdict: PublicVerdict | null };
  /** ALL remaining fields are private request-local material, never artifacts. */
  reads: readonly Read[]; state?: State;
}
function dispose(body: ReadableStream<Uint8Array> | null) {
  try { void body?.cancel().catch(() => {}); } catch { /* never expose error */ }
}
function repository(value: unknown, id: number) {
  const r = obj(value);
  if (r.id !== id || r.full_name !== "Quick-Release/gq-support" || r.url !== root) refuse();
}
function normalize(value: unknown, workflow: Record<string, unknown>, t: TrackedRun, repositoryId: number, now: number) {
  const r = obj(value), e = t.expectation;
  repository(r.repository, repositoryId); repository(r.head_repository, repositoryId);
  if (r.id !== e.run || r.run_attempt !== e.attempt || r.workflow_id !== workflow.id ||
    r.workflow_url !== `${root}/actions/workflows/${workflow.id}` || r.url !== `${root}/actions/runs/${e.run}` ||
    r.event !== e.event || r.head_sha !== e.head || r.head_branch !== t.ref.replace(/^refs\/(heads|tags)\//, "")) refuse();
  const created = timestamp(r.created_at, now), updated = timestamp(r.updated_at, now);
  const started = r.run_started_at === null ? null : timestamp(r.run_started_at, updated);
  if (created > updated || (started !== null && started < created) ||
    (typeof r.status !== "string" || !["queued", "in_progress", "completed"].includes(r.status)) ||
    (r.status === "completed") !== (r.conclusion !== null) ||
    (r.status !== "queued" && started === null) ||
    !(r.conclusion === null || (typeof r.conclusion === "string" && ["success", "failure", "timed_out", "action_required", "cancelled", "skipped"].includes(r.conclusion)))) refuse();
  return { expectation: e, created, started, updated, status: r.status, conclusion: r.conclusion };
}
/** <=3 metadata GETs + <=20 exact attempt GETs, sequential, no list/discovery or
 * retry. Complete means these exact expectations only; never service readiness.
 * Trusted injected context is NOT authenticated custody or human approval. */
export async function observeGitHubActions(input: ActionsInput, io: TransportIO): Promise<ActionsResult> {
  const empty: ActionsResult = { public: { coverage: "unknown", verdict: null }, reads: [] };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined;
  let signal: AbortSignal | undefined, stopped = false;
  try {
    // Snapshot all private mutable inputs and function references before awaits.
    const i = structuredClone(input), c = i.context, transport = io.fetch, clock = io.now;
    signal = io.signal;
    if (decodeBatch(c, []).invalid || !Array.isArray(i.tracked) || i.tracked.length !== c.expected.length ||
      i.tracked.length > actionsLimits.expectations || !i.tracked.length) refuse();
    positive(i.repositoryId); finiteInt(i.observation); finiteInt(i.expiresAt);
    if (typeof i.actionsReadToken !== "string" || !/^[!-~]{1,4096}$/.test(i.actionsReadToken)) refuse();
    const identities = new Set<string>();
    for (const t of i.tracked) {
      const e = t.expectation;
      if (!/^[a-f0-9]{64}$/.test(t.identity) || identities.has(t.identity) || !c.expected.some(x => same(x, e))) refuse();
      identities.add(t.identity);
      if (e.workflow === "release-plugin.yml" && e.event === "push") {
        if (!/^refs\/tags\/plugin-v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/.test(t.ref)) refuse();
      } else if (t.ref !== "refs/heads/main") refuse();
    }
    if (new Set(i.tracked.map(t => `${t.expectation.run}/${t.expectation.attempt}`)).size !== i.tracked.length) refuse();
    evaluate(c, decodeBatch(c, []), i.previous);
    const started = finiteInt(clock()); let last = started;
    if (started < c.now || started - c.now > proposals.freshness || i.expiresAt <= started || i.expiresAt - started > 300_000) refuse();
    const check = () => {
      const now = finiteInt(clock());
      if (stopped || signal?.aborted || now < last || now >= i.expiresAt || now - started >= actionsLimits.ms) {
        stopped = true; controller.abort(); refuse();
      }
      last = now; return now;
    };
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => { stopped = true; controller.abort(); reject(new Error("observer_actions_unknown")); };
      timer = setTimeout(stop, Math.min(actionsLimits.ms, i.expiresAt - started));
    });
    void interrupted.catch(() => {});
    signal?.addEventListener("abort", stop!, { once: true });
    const bounded = async <T>(p: Promise<T>): Promise<T> => { const v = await Promise.race([p, interrupted]); check(); return v; };
    let requests = 0, total = 0;
    async function get(path: string): Promise<unknown> {
      check(); if (++requests > actionsLimits.requests) refuse();
      const url = root + path;
      let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined, done = false;
      try {
        const init = { method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
          signal: controller.signal, headers: { Accept: "application/vnd.github+json", "Accept-Encoding": "identity",
            "User-Agent": "gq-support-observer", "X-GitHub-Api-Version": "2026-03-10", Authorization: `Bearer ${i.actionsReadToken}` } } as const;
        const pending = transport(url, init);
        // Own before post-await deadline check (#126 race), dispose late bodies.
        void pending.then(r => { response = r; if (stopped) dispose(r.body); }, () => {});
        response = await bounded(pending);
        if (response.url !== url || response.redirected || !["basic", "cors", "default"].includes(response.type) || response.status !== 200 ||
          response.headers.has("set-cookie") || ![null, "identity"].includes(response.headers.get("content-encoding")) ||
          !/^application\/(?:json|vnd\.github\+json)(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) refuse();
        const length = response.headers.get("content-length");
        if (length !== null && (!/^(0|[1-9][0-9]{0,5})$/.test(length) || Number(length) > actionsLimits.bytes)) refuse();
        if (!response.body) refuse();
        reader = response.body!.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        for (let n = 0; n <= actionsLimits.chunks; n++) {
          const part = await bounded(reader.read());
          if (part.done) { done = true; break; }
          if (n === actionsLimits.chunks || !(part.value instanceof Uint8Array) ||
            part.value.byteLength > actionsLimits.bytes - size || part.value.byteLength > actionsLimits.totalBytes - total) refuse();
          size += part.value.byteLength; total += part.value.byteLength; chunks.push(part.value.slice());
        }
        if (!done || (length !== null && Number(length) !== size)) refuse();
        const bytes = new Uint8Array(size); let offset = 0;
        for (const b of chunks) { bytes.set(b, offset); offset += b.byteLength; }
        check();
        return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
      } finally {
        if (!done) {
          if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* private */ } }
          else if (response) dispose(response.body);
        }
      }
    }
    const reads: Read[] = [], workflows = new Map<string, Record<string, unknown>>();
    let complete = true;
    try {
      for (const t of i.tracked) {
        const e = t.expectation;
        let w = workflows.get(e.workflow);
        if (!w) {
          w = obj(await get(`/actions/workflows/${e.workflow}`));
          positive(w.id);
          if (w.path !== `.github/workflows/${e.workflow}` || w.url !== `${root}/actions/workflows/${w.id}` || (typeof w.state !== "string" || !["active", "deleted", "disabled_fork", "disabled_inactivity", "disabled_manually"].includes(w.state))) refuse();
          workflows.set(e.workflow, w);
        }
        check();
        const wire = await get(`/actions/runs/${e.run}/attempts/${e.attempt}`);
        const at = check(), normalized = normalize(wire, w, t, i.repositoryId, at);
        if (normalized.status !== "completed" || !["success", "failure", "timed_out", "action_required"].includes(String(normalized.conclusion))) complete = false;
        reads.push({ source: "workflow", observed: i.observation, at, from: normalized.created, to: normalized.updated,
          account: c.account, stage: c.stage, candidate: c.candidate, generation: c.generation,
          status: "ok", coverage: "complete", pages: 0, body: encode(normalized) });
      }
      check();
    } catch { complete = false; stopped = true; controller.abort(); }
    const coverage: Read["coverage"] = complete ? "complete" : reads.length ? "partial" : "unknown";
    const output = reads.map(r => ({ ...r, coverage }));
    // Preserve valid positive failures after missing/denied/malformed later reads.
    const context = { ...c, now: last };
    const evaluated = evaluate(context, decodeBatch(context, output), i.previous);
    return { public: { coverage, verdict: evaluated.public }, reads: output, state: evaluated.state };
  } catch { return empty; }
  finally {
    stopped = true; controller.abort(); clearTimeout(timer);
    if (stop) signal?.removeEventListener("abort", stop);
  }
}
