// Trusted launcher library only. No ambient fetch, credentials, persistence or CLI.
import { createHash } from "node:crypto";
import { exact, finiteInt, release } from "../../src/observer-snapshot.ts";
import type { ApprovalPolicy } from "../../deploy/github-candidate-approval.ts";
import { observeGitHubActions, validateActionsInput, type ActionsResult, type TrackedRun } from "./github-actions.ts";
import { decodeBatch, evaluate, type Context, type State } from "./protocol.ts";

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
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}
const denied = (): ActionsResult => ({ public: { coverage: "unknown", verdict: null }, reads: [] });
// Includes ALL verification calls; source retains its independent #130 bounds.
export const actionsReviewLimits = { requests: 100, bytes: 32_768, totalBytes: 3_276_800, ms: budget } as const;

/** Public grammar: exactly one ASCII line, no private target/session material.
 * The digest binds ALL private bytes, including operation and session pins. */
export function actionsReadCommand(sha256: string): string {
  return `approve-observer-actions-read sha256:${digest(sha256)}`;
}
export interface ReadSessionPins {
  stage: Context["stage"]; candidate: string; session: string; nonce: string;
  readyAt: number; expiresAt: number; sha256: string;
}
export interface PrivateActionsManifest extends Omit<ReadSessionPins, "sha256"> {
  schema: 1; purpose: "observer_actions_reads";
  repositoryId: number; context: Context; tracked: readonly TrackedRun[]; observation: number;
}
export interface ActionsReviewIO {
  github: typeof fetch; source: typeof fetch; now: () => number; signal?: AbortSignal;
}
export interface ActionsReviewRequest {
  manifest: Uint8Array; commentId: number; actionsReadToken: string; previous?: State;
}

/** SOURCE-reviewed numeric IDs, exactly as the deployment verifier requires.
 * No live IDs are configured in this repository. Never derive them from manifest,
 * API response, fixture, login alone or a caller approval flag. Fresh session/nonce
 * and exact digest are launcher-owned. Private delivery claims durable replay first. */
export function createActionsReadSession(policy: Pick<ApprovalPolicy, "approvers">, pins: ReadSessionPins, githubToken: string) {
  let approvers: ApprovalPolicy["approvers"], sealed: ReadSessionPins;
  try { approvers = structuredClone(policy.approvers); sealed = structuredClone(pins); }
  catch { return Object.freeze({ observe: async (_request: ActionsReviewRequest, _io: ActionsReviewIO) => denied() }); }
  const token = githubToken;
  let consumed = false;
  return Object.freeze({ async observe(request: ActionsReviewRequest, io: ActionsReviewIO): Promise<ActionsResult> {
    if (consumed) return denied();
    consumed = true; // BEFORE copying, hashing, decoding, mismatches or awaits.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, stop: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    let stopped = false;
    let retained: ActionsResult | undefined, context: Context | undefined, previousState: State | undefined;
    try {
      // Copy every mutable input and capture all custody functions before awaits.
      if (!(request.manifest instanceof Uint8Array) || request.manifest.byteLength > maxBytes) refuse();
      const bytes = request.manifest.slice(), commentId = finiteInt(request.commentId);
      const actionsReadToken = request.actionsReadToken;
      const previous = request.previous === undefined ? undefined : structuredClone(request.previous);
      const github = io.github, source = io.source, clock = io.now;
      signal = io.signal;
      exact(approvers, ["vvaz", "gmarques"]);
      if (finiteInt(approvers.vvaz) === 0 || finiteInt(approvers.gmarques) === 0 || approvers.vvaz === approvers.gmarques ||
        typeof token !== "string" || !/^[!-~]{1,4096}$/.test(token) ||
        typeof actionsReadToken !== "string" || !/^[!-~]{1,4096}$/.test(actionsReadToken) ||
        /^[a-f0-9]{64}$/.test(actionsReadToken) || actionsReadToken === token || commentId === 0) refuse();
      exact(sealed, ["stage", "candidate", "session", "nonce", "readyAt", "expiresAt", "sha256"]);
      if (!["prod", "staging"].includes(sealed.stage)) refuse();
      release(sealed.candidate); digest(sealed.session); digest(sealed.nonce); digest(sealed.sha256);
      finiteInt(sealed.readyAt); finiteInt(sealed.expiresAt);
      if (sealed.expiresAt <= sealed.readyAt || sealed.expiresAt - sealed.readyAt > window || hash(bytes) !== sealed.sha256) refuse();
      const m = exact(parse(bytes), ["schema", "purpose", "stage", "candidate", "session", "nonce", "readyAt", "expiresAt",
        "repositoryId", "context", "tracked", "observation"]);
      if (m.schema !== 1 || m.purpose !== "observer_actions_reads") refuse();
      for (const key of ["stage", "candidate", "session", "nonce", "readyAt", "expiresAt"] as const)
        if (m[key] !== sealed[key]) refuse();
      const manifest = m as unknown as PrivateActionsManifest;
      exact(manifest.context, ["now", "account", "stage", "candidate", "activation", "generation", "exclusions", "expected"]);
      if (manifest.context.stage !== sealed.stage || manifest.context.candidate !== sealed.candidate || !Array.isArray(manifest.tracked)) refuse();
      for (const t of manifest.tracked) {
        exact(t, ["identity", "expectation", "ref"]);
        exact(t.expectation, ["repo", "workflow", "event", "run", "attempt", "head", "stage", "candidate"]);
      }
      const input = { context: manifest.context, tracked: manifest.tracked, observation: manifest.observation,
        repositoryId: manifest.repositoryId, expiresAt: sealed.expiresAt, actionsReadToken, previous };
      validateActionsInput(input); // ALL joins/refs/identities checked before the first await.
      context = manifest.context; previousState = previous;
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
        timer = setTimeout(stop, Math.min(budget, sealed.expiresAt - started));
      });
      void interrupted.catch(() => {});
      signal?.addEventListener("abort", stop!, { once: true });
      const bounded = async <T>(pending: Promise<T>): Promise<T> => {
        const value = await Promise.race([pending, interrupted]); fresh(); return value;
      };
      let requests = 0, total = 0;
      async function get(url: string): Promise<Record<string, unknown>> {
        fresh();
        if (++requests > actionsReviewLimits.requests) refuse();
        let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let complete = false;
        const cancel = (r: Response) => { try { void r.body?.cancel().catch(() => {}); } catch { /* no raw output */ } };
        try {
          const init = { method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Accept-Encoding": "identity",
              "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "gq-support-observer-review" } } as const;
          const pending = github(url, init);
          void pending.then(r => { response = r; if (stopped) cancel(r); }, () => {});
          response = await bounded(pending);
          if (response.status !== 200 || response.url !== url || response.redirected || !["basic", "cors", "default"].includes(response.type) ||
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
            if (n === 1024 || !(part.value instanceof Uint8Array) || part.value.byteLength > maxBytes - size ||
              part.value.byteLength > actionsReviewLimits.totalBytes - total) refuse();
            size += part.value.byteLength; total += part.value.byteLength; chunks.push(part.value.slice());
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
      const command = actionsReadCommand(sealed.sha256);
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
        if (!Number.isFinite(created) || new Date(created).toISOString() !== (c.created_at as string).replace(/Z$/, (c.created_at as string).includes(".") ? "Z" : ".000Z") || created <= sealed.readyAt || created > at || created >= sealed.expiresAt || at - created > window) refuse();
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
          if ((permission.permission !== "admin" && permission.permission !== "write") || user.login !== login ||
            user.id !== approvers[login] || user.type !== "User") refuse();
          comment(await get(commentURL)); // exact record reread after asynchronous checks
          fresh();
        } catch {
          // The source adapter catches transport errors. Make any authentication failure
          // terminal here too, so that catch cannot resume verification/dispatch.
          stopped = true; controller.abort(); return refuse();
        }
      }
      await verify();
      const allowed = new Set(manifest.tracked.flatMap(t => [
        `${root}/actions/workflows/${t.expectation.workflow}`,
        `${root}/actions/runs/${t.expectation.run}/attempts/${t.expectation.attempt}`,
      ]));
      const pending = observeGitHubActions(input, {
        now: clock, signal: controller.signal,
        fetch: async (url, init) => {
          try {
            await verify(); fresh();
            // Exact source routes/method/header envelope from #130 only. Neither
            // review auth nor source token can be forwarded to a Worker or redirect.
            if (typeof url !== "string" || !allowed.has(url) || !init) refuse();
            const envelope = exact(init, ["method", "redirect", "credentials", "cache", "signal", "headers"]);
            const h = exact(envelope.headers, ["Accept", "Accept-Encoding", "User-Agent", "X-GitHub-Api-Version", "Authorization"]);
            if (envelope.method !== "GET" || envelope.redirect !== "error" || envelope.credentials !== "omit" || envelope.cache !== "no-store" ||
              (envelope.signal as AbortSignal)?.aborted || h.Accept !== "application/vnd.github+json" || h["Accept-Encoding"] !== "identity" ||
              h["User-Agent"] !== "gq-support-observer" || h["X-GitHub-Api-Version"] !== "2026-03-10" ||
              h.Authorization !== `Bearer ${actionsReadToken}`) refuse();
            fresh(); // synchronous dispatch fence; no reusable grant escapes
            return await source(url, init);
          } catch { stopped = true; controller.abort(); return refuse(); }
        },
      });
      void pending.then(r => { retained = r; }, () => {});
      const result = await bounded(pending);
      await verify(); fresh(); // source catch cannot launder a wrapper failure
      return result;
    } catch {
      const result = denied();
      // Withhold authority, and do not let a revoked completed success erase old
      // failures. Request-local positive failures can survive as private carry.
      if (context) {
        try {
          const c = { ...context, now: Math.max(context.now, ...(retained?.reads ?? []).map(r => r.at)) };
          result.state = evaluate(c, decodeBatch(c,
            (retained?.reads ?? []).map(r => ({ ...r, coverage: "partial" }))), previousState).state;
        }
        catch { /* unknown cannot confer recovery */ }
      }
      return result;
    }
    finally {
      stopped = true; controller.abort(); clearTimeout(timer);
      if (stop) signal?.removeEventListener("abort", stop);
    }
  } });
}
