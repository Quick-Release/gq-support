import { exact, finiteInt, release, decodeObserverSnapshot } from "../../src/observer-snapshot.ts";
import { decodeBatch, evaluate, proposals, type Context, type Read, type State, type PublicVerdict } from "./protocol.ts";
import { consumeSnapshotReview, type SnapshotReview } from "./snapshot-evidence.ts";

/** PRIVATE trusted input, supplied by an independent reviewed target loader.
 * Lexical checks below prove neither DNS/TLS/account ownership nor current
 * deployment/version identity. This library does not implement that loader.
 * Only the reviewed workers.dev origin is supported; custom routes need review. */
export interface ReviewedTarget {
  account: Context["account"]; stage: Context["stage"]; worker: string; origin: string;
  candidate: string; deployment: string; version: string; generation: number;
}
export interface PrivateReadInput {
  target: ReviewedTarget; context: Context;
  /** Independent runner identity. Replays/equal-time runs cannot confirm HTTP. */
  observation: number;
  /** Dedicated stage snapshot-read token only. Omit for readiness-only reads. */
  snapshotToken?: string;
  review?: SnapshotReview;
  previous?: State;
}
export interface TransportIO {
  /** Trusted standard fetch implementation, without ambient proxy/auth wrappers.
   * Required injection: there is no ambient fetch/env/profile entry point. */
  fetch: typeof fetch;
  now: () => number;
  signal?: AbortSignal;
}
type Availability = "available" | "unavailable" | "unknown";
type Acceptance = "accepted" | "denied" | "invalid" | "unavailable" | "not_requested";
export interface TransportResult {
  /** Only this finite, bounded object is publishable. */
  public: { readiness: Availability; snapshot: Acceptance;
    review: "reviewed_external_input" | "unknown"; continuity: "unknown"; verdict: PublicVerdict | null };
  /** Private request-local carry; never an artifact/RPC/public verdict. */
  state?: State;
}
const readiness = "/internal/observer/v1/readiness", snapshot = "/internal/observer/v1/snapshot";
const budget = 10_000, maxBytes = 65_536, maxChunks = 1024;
class ReadUnavailable extends Error {}
const refuse = (): never => { throw new Error("observer_transport_refused"); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validateTarget(t: ReviewedTarget, c: Context): void {
  exact(t, ["account", "stage", "worker", "origin", "candidate", "deployment", "version", "generation"]);
  for (const key of ["account", "stage", "candidate", "generation"] as const) if (t[key] !== c[key]) refuse();
  release(t.candidate); finiteInt(t.generation);
  if (!uuid.test(t.deployment) || !uuid.test(t.version) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(t.worker)) refuse();
  // Exact lexical comparison refuses URL parser normalization: ports (even 443),
  // userinfo, slash/query/fragment, escapes, case, trailing dot, IPs/private hosts.
  if (typeof t.origin !== "string" || t.origin.length > 180 ||
    !/^https:\/\/[a-z0-9-]+\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/.test(t.origin)) refuse();
  const u = new URL(t.origin);
  if (u.origin !== t.origin || u.hostname.split(".")[0] !== t.worker) refuse();
  if (decodeBatch(c, []).invalid) refuse();
}
function cancel(body: ReadableStream<Uint8Array> | null): void {
  // Request cancellation; never claim remote cancellation or wait on a fake
  // noncooperative cancel promise. Rejection text must never escape.
  try { void body?.cancel().catch(() => {}); } catch { /* fixed refusal only */ }
}

/** At most two sequential fixed GETs, one cooperative 10s TOTAL budget, no retry.
 * No scheduler, source discovery, provider API, loader, persistence or send.
 * Caller must independently authenticate reviewed inputs before invoking this. */
export async function observeHTTPS(input: PrivateReadInput, io: TransportIO): Promise<TransportResult> {
  const result: TransportResult = { public: { readiness: "unknown", snapshot: "not_requested",
    review: "unknown", continuity: "unknown", verdict: null } };
  // A planned snapshot attempt owns (and consumes) review BEFORE config, clock,
  // credential, target or response validation, including readiness failures.
  const review = input.snapshotToken !== undefined ? consumeSnapshotReview(input.review) : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const controller = new AbortController();
  let stopped = false;
  const externalSignal = io.signal;
  try {
    // Copy all private mutable inputs synchronously, before the first await.
    const t = structuredClone(input.target), c = structuredClone(input.context);
    const previous = input.previous === undefined ? undefined : structuredClone(input.previous);
    const observed = finiteInt(input.observation), token = input.snapshotToken;
    const transport = io.fetch, clock = io.now, signal = externalSignal;
    validateTarget(t, c);
    if (token !== undefined && (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))) refuse();
    const started = finiteInt(clock());
    if (started < c.now || started - c.now > proposals.freshness) refuse();
    let last = started;
    const check = () => {
      const at = finiteInt(clock());
      if (stopped || signal?.aborted || at < last || at - started >= budget) {
        stopped = true; controller.abort(); return refuse();
      }
      last = at; return at;
    };
    // Validate private carry before dispatch, without accepting persistence input.
    evaluate(c, decodeBatch(c, []), previous);
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => { stopped = true; controller.abort(); reject(new Error("observer_transport_unavailable")); };
      timer = setTimeout(stop, budget);
    });
    void interrupted.catch(() => {});
    signal?.addEventListener("abort", stop!, { once: true });
    const bounded = async <T>(p: Promise<T>): Promise<T> => {
      const value = await Promise.race([p, interrupted]); check(); return value;
    };
    const reads: Read[] = [];
    let readinessDispatched = false;
    const provenance = (source: Read["source"], at: number): Read => ({
      source, observed, at, from: Math.max(0, at - proposals.ring), to: at,
      account: t.account, stage: t.stage, candidate: t.candidate, generation: t.generation,
      deployment: t.deployment, version: t.version, status: "ok", coverage: "complete", pages: 1,
      body: new Uint8Array(),
    });
    async function read(path: typeof readiness | typeof snapshot): Promise<{ bytes: Uint8Array; status: number }> {
      check();
      const url = t.origin + path;
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let complete = false;
      try {
        const headers: Record<string, string> = { Accept: "application/json", "Accept-Encoding": "identity" };
        if (path === snapshot) headers.Authorization = `Bearer ${token}`;
        const init = { method: "GET", redirect: "error", credentials: "omit",
          cache: "no-store", signal: controller.signal,
          headers } as const;
        if (path === readiness) readinessDispatched = true;
        const pending = transport(url, init);
        // A noncooperative injected transport may settle after our deadline. Do
        // not inspect or decode it, only request stream disposal; never retry.
        void pending.then(r => {
          // Capture ownership before bounded() can reject at its post-await
          // clock check, even if the timeout callback has not run yet.
          response = r;
          if (stopped) cancel(r.body);
        }, () => {});
        try { response = await bounded(pending); } catch { throw new ReadUnavailable(); }
        if (response.url !== url || response.redirected || String(response.type) === "opaqueredirect")
          return { bytes: new Uint8Array(), status: 0 };
        if (response.status < 200 || response.status >= 300)
          return { bytes: new Uint8Array(), status: response.status };
        if (response.status !== 200 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "") ||
          response.headers.has("set-cookie") ||
          ![null, "identity"].includes(response.headers.get("content-encoding"))) refuse();
        const length = response.headers.get("content-length");
        if (length !== null && (!/^(0|[1-9][0-9]{0,5})$/.test(length) || Number(length) > maxBytes)) refuse();
        const body = response.body;
        if (!body) return refuse();
        reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (let n = 0; n <= maxChunks; n++) {
          const part = await bounded(reader.read());
          if (part.done) { complete = true; break; }
          if (n === maxChunks || !(part.value instanceof Uint8Array) || part.value.byteLength > maxBytes - size) refuse();
          size += part.value.byteLength; chunks.push(part.value.slice());
        }
        if (!complete || (length !== null && Number(length) !== size)) refuse();
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        check(); return { bytes, status: 200 };
      } finally {
        if (!complete) {
          if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* no raw errors */ } }
          else if (response) cancel(response.body);
        }
      }
    }
    try {
      const r = await read(readiness), at = check();
      if (r.status === 200) {
        const o = exact(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(r.bytes)), ["version", "check", "result"]);
        if (o.version !== 1 || o.check !== "route_runtime" || o.result !== "available") refuse();
        result.public.readiness = "available";
      } else if (r.status >= 400 && r.status <= 599) result.public.readiness = "unavailable";
      if (result.public.readiness !== "unknown") reads.push({ ...provenance("http", at),
        body: new TextEncoder().encode("{}"), vantage: result.public.readiness });
    } catch (error) {
      // Malformed readiness cannot clear incidents. DNS/TLS/timeout/error text
      // is not classified into a platform cause, nor ever returned/logged.
      result.public.readiness = error instanceof ReadUnavailable || stopped || signal?.aborted ? "unavailable" : "unknown";
      if (result.public.readiness === "unavailable" && readinessDispatched) {
        const at = finiteInt(clock());
        reads.push({ ...provenance("http", at), body: new TextEncoder().encode("{}"), vantage: "unavailable" });
      }
    }
    if (result.public.readiness !== "available") { stopped = true; controller.abort(); }
    if (token !== undefined) {
      result.public.snapshot = "unavailable";
      try {
        check();
        const r = await read(snapshot), at = check();
        if (r.status === 401 || r.status === 403) result.public.snapshot = "denied";
        else if (r.status === 200) {
          const wire = decodeObserverSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(r.bytes)), at);
          if (wire.stage !== t.stage || wire.candidate !== t.candidate || wire.generation !== t.generation || wire.generated < at - proposals.freshness) refuse();
          reads.push({ ...provenance("snapshot", at), body: r.bytes });
          result.public.snapshot = "accepted";
        } else if (r.status < 400 || r.status > 599) result.public.snapshot = "invalid";
      } catch (error) { result.public.snapshot = error instanceof ReadUnavailable || stopped || signal?.aborted ? "unavailable" : "invalid"; }
    }
    const at = finiteInt(clock());
    if (at < last) refuse();
    const context = { ...c, now: at };
    const batch = decodeBatch(context, reads, review);
    for (const e of batch.evidence) if (e.payload && "claims" in e.payload && e.payload.claims?.activation === "reviewed_external_input")
      result.public.review = "reviewed_external_input";
    const evaluated = evaluate(context, batch, previous);
    result.state = evaluated.state; result.public.verdict = evaluated.public;
    if (new TextEncoder().encode(JSON.stringify(result.public)).byteLength > 2048) refuse();
    return result;
  } catch {
    return { public: { readiness: "unknown", snapshot: "unavailable", review: "unknown", continuity: "unknown", verdict: null } };
  } finally {
    clearTimeout(timer);
    if (stop) externalSignal?.removeEventListener("abort", stop);
    stopped = true; controller.abort();
  }
}
