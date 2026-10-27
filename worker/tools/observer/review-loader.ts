// Trusted launcher library only. No ambient fetch, credentials, persistence or CLI.
import { createHash } from "node:crypto";
import { exact, finiteInt, release } from "../../src/observer-snapshot.ts";
import type { ApprovalPolicy } from "../../deploy/github-candidate-approval.ts";
import { observeHTTPS, type ReviewedTarget, type TransportResult } from "./https-transport.ts";
import type { Context, State } from "./protocol.ts";
import { validateSnapshotReview } from "./snapshot-evidence.ts";

const root = "https://api.github.com/repos/Quick-Release/gq-support";
const budget = 10_000, window = 5 * 60_000, maxBytes = 32_768;
const refuse = (): never => { throw new Error("observer_review_refused"); };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) refuse();
  return value as string;
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}
function parse(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}
const denied = (): TransportResult => ({ public: { readiness: "unknown", snapshot: "unavailable",
  review: "unknown", continuity: "unknown", verdict: null } });

/** Public grammar: exactly one ASCII line, no private target/session material.
 * The digest binds ALL private bytes, including operation and session pins. */
export function observerReadCommand(sha256: string): string {
  return `approve-observer-read sha256:${digest(sha256)}`;
}
export interface ReadSessionPins {
  stage: Context["stage"]; candidate: string; session: string; nonce: string;
  readyAt: number; expiresAt: number; sha256: string;
}
export interface PrivateObserverManifest extends Omit<ReadSessionPins, "sha256"> {
  schema: 1; purpose: "observer_reads"; target: ReviewedTarget; context: Context;
  observation: number;
  /** Exact UTF-8 JSON text of optional #125 review; included in outer digest.
   * Actor attests its facts externally; GitHub cannot verify CF ownership. */
  snapshotReview: string | null;
}
export interface ObserverReviewIO {
  github: typeof fetch; worker: typeof fetch; now: () => number; signal?: AbortSignal;
}
export interface ObserverReviewRequest {
  manifest: Uint8Array; commentId: number; snapshotToken?: string; previous?: State;
}

/** SOURCE-reviewed numeric IDs, exactly as the deployment verifier requires.
 * No live IDs are configured in this repository. Never derive them from manifest,
 * API response, fixture, login alone or a caller approval flag. Fresh session/nonce
 * and exact digest are launcher-owned; durable replay refusal is still absent. */
export function createObserverReadSession(policy: Pick<ApprovalPolicy, "approvers">, pins: ReadSessionPins, githubToken: string) {
  let approvers: ApprovalPolicy["approvers"], sealed: ReadSessionPins;
  try { approvers = structuredClone(policy.approvers); sealed = structuredClone(pins); }
  catch { return Object.freeze({ observe: async (_request: ObserverReviewRequest, _io: ObserverReviewIO) => denied() }); }
  const token = githubToken;
  let consumed = false;
  return Object.freeze({ async observe(request: ObserverReviewRequest, io: ObserverReviewIO): Promise<TransportResult> {
    if (consumed) return denied();
    consumed = true; // BEFORE copying, hashing, decoding, mismatches or awaits.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    let stopped = false;
    try {
      // Copy every mutable input and capture all custody functions before awaits.
      if (!(request.manifest instanceof Uint8Array) || request.manifest.byteLength > maxBytes) refuse();
      const bytes = request.manifest.slice(), commentId = finiteInt(request.commentId);
      const snapshotToken = request.snapshotToken;
      const previous = request.previous === undefined ? undefined : structuredClone(request.previous);
      const github = io.github, worker = io.worker, clock = io.now;
      signal = io.signal;
      exact(approvers, ["vvaz", "gmarques"]);
      if (finiteInt(approvers.vvaz) === 0 || finiteInt(approvers.gmarques) === 0 || approvers.vvaz === approvers.gmarques ||
        typeof token !== "string" || token.length === 0 || token.length > 4096 || /\s/.test(token) ||
        snapshotToken === token || commentId === 0) refuse();
      exact(sealed, ["stage", "candidate", "session", "nonce", "readyAt", "expiresAt", "sha256"]);
      if (!["prod", "staging"].includes(sealed.stage)) refuse();
      release(sealed.candidate); digest(sealed.session); digest(sealed.nonce); digest(sealed.sha256);
      finiteInt(sealed.readyAt); finiteInt(sealed.expiresAt);
      if (sealed.expiresAt <= sealed.readyAt || sealed.expiresAt - sealed.readyAt > window || hash(bytes) !== sealed.sha256) refuse();
      const m = exact(parse(bytes), ["schema", "purpose", "stage", "candidate", "session", "nonce", "readyAt", "expiresAt",
        "target", "context", "observation", "snapshotReview"]);
      if (m.schema !== 1 || m.purpose !== "observer_reads") refuse();
      for (const key of ["stage", "candidate", "session", "nonce", "readyAt", "expiresAt"] as const)
        if (m[key] !== sealed[key]) refuse();
      const manifest = m as unknown as PrivateObserverManifest;
      if (manifest.target.stage !== sealed.stage || manifest.target.candidate !== sealed.candidate ||
        manifest.context.stage !== sealed.stage || manifest.context.candidate !== sealed.candidate ||
        (manifest.snapshotReview !== null && typeof manifest.snapshotReview !== "string")) refuse();
      finiteInt(manifest.observation);
      const started = finiteInt(clock());
      let last = started;
      const fresh = () => {
        const at = finiteInt(clock());
        if (stopped || signal?.aborted || at < last || at < sealed.readyAt || at >= sealed.expiresAt || at - started >= budget) refuse();
        last = at; return at;
      };
      fresh();
      const interrupted = new Promise<never>((_, reject) => {
        stop = () => { stopped = true; controller.abort(); reject(new Error("observer_review_refused")); };
        timer = setTimeout(stop, budget);
      });
      void interrupted.catch(() => {});
      signal?.addEventListener("abort", stop!, { once: true });
      const bounded = async <T>(pending: Promise<T>): Promise<T> => {
        const value = await Promise.race([pending, interrupted]); fresh(); return value;
      };
      let requests = 0;
      async function get(url: string): Promise<Record<string, unknown>> {
        fresh();
        if (++requests > 16) refuse();
        let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let complete = false;
        const cancel = (r: Response) => { try { void r.body?.cancel().catch(() => {}); } catch { /* no raw output */ } };
        try {
          const init = { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Accept-Encoding": "identity",
              "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gq-support-observer-review" } } as const;
          const pending = github(url, init);
          void pending.then(r => { response = r; if (stopped) cancel(r); }, () => {});
          response = await bounded(pending);
          if (response.status !== 200 || response.url !== url || response.redirected || String(response.type) === "opaqueredirect" ||
            !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "") ||
            response.headers.has("link") || response.headers.has("set-cookie") ||
            ![null, "identity"].includes(response.headers.get("content-encoding"))) refuse();
          const length = response.headers.get("content-length");
          if (length !== null && (!/^(0|[1-9][0-9]{0,5})$/.test(length) || Number(length) > maxBytes)) refuse();
          if (!response.body) refuse();
          reader = response.body!.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (let n = 0; n <= 1024; n++) {
            const part = await bounded(reader.read());
            if (part.done) { complete = true; break; }
            if (n === 1024 || !(part.value instanceof Uint8Array) || part.value.byteLength > maxBytes - size) refuse();
            size += part.value.byteLength; chunks.push(part.value.slice());
          }
          if (!complete || (length !== null && Number(length) !== size)) refuse();
          const body = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
          fresh(); return obj(parse(body));
        } finally {
          if (!complete) {
            if (reader) { try { void reader.cancel().catch(() => {}); } catch { /* no raw output */ } }
            else if (response) cancel(response);
          }
        }
      }
      const commentURL = `${root}/issues/comments/${commentId}`;
      const command = observerReadCommand(sealed.sha256);
      let actor: "vvaz" | "gmarques" | undefined, original: string | undefined;
      function comment(c: Record<string, unknown>) {
        const user = obj(c.user), login = user.login;
        if (login !== "vvaz" && login !== "gmarques") refuse();
        if (c.id !== commentId || c.url !== commentURL || c.issue_url !== `${root}/issues/20` ||
          c.html_url !== `https://github.com/Quick-Release/gq-support/issues/20#issuecomment-${commentId}` ||
          user.type !== "User" || user.id !== approvers[login as "vvaz" | "gmarques"] || c.body !== command ||
          typeof c.created_at !== "string" || c.created_at !== c.updated_at ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$|^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(c.created_at)) refuse();
        const created = Date.parse(c.created_at as string), at = fresh();
        if (!Number.isFinite(created) || created <= sealed.readyAt || created > at || created >= sealed.expiresAt || at - created > window) refuse();
        const identity = JSON.stringify([c.id, c.url, c.issue_url, c.body, user.id, login, user.type, c.created_at, c.updated_at]);
        if (original !== undefined && original !== identity) refuse();
        original = identity; actor = login as "vvaz" | "gmarques";
      }
      async function verify() {
        try {
          comment(await get(commentURL));
          const login = actor!;
          const identity = await get(`https://api.github.com/users/${login}`);
          if (identity.login !== login || identity.id !== approvers[login] || identity.type !== "User") refuse();
          const permission = await get(`${root}/collaborators/${login}/permission`), user = obj(permission.user);
          // Documented legacy permission maps maintain to write; no role-name guess.
          if (!["admin", "write"].includes(String(permission.permission)) || user.login !== login ||
            user.id !== approvers[login] || user.type !== "User") refuse();
          comment(await get(commentURL)); // exact record reread after asynchronous checks
          fresh();
        } catch {
          // observeHTTPS catches transport errors. Make any authentication failure
          // terminal here too, so that catch cannot resume verification/dispatch.
          stopped = true; controller.abort(); return refuse();
        }
      }
      await verify();
      const t = manifest.target;
      const review = manifest.snapshotReview === null ? undefined : validateSnapshotReview(
        new TextEncoder().encode(manifest.snapshotReview), {
          account: t.account, stage: t.stage, candidate: t.candidate, deployment: t.deployment, version: t.version, generation: t.generation,
          sha256: hash(new TextEncoder().encode(manifest.snapshotReview)), reviewer: actor!,
          record: hash(new TextEncoder().encode(commentURL)) }, fresh());
      const result = await bounded(observeHTTPS({ target: manifest.target, context: manifest.context,
        observation: manifest.observation, snapshotToken, previous, review }, {
        now: clock, signal: controller.signal,
        fetch: async (url, init) => {
          // No reusable bool/capability escapes: this closure owns the revalidation
          // and credential dispatch. No await between the final fresh check and GET.
          await verify(); fresh();
          return worker(url, init);
        },
      }));
      await verify(); fresh(); // no stale review claims after pending Worker I/O
      return result;
    } catch { return denied(); }
    finally {
      stopped = true; controller.abort(); clearTimeout(timer);
      if (stop) signal?.removeEventListener("abort", stop);
    }
  } });
}
