// Staging only (#57). Acts as one enrolled WordPress installation (the Reporter)
// over the public installation API, and as the Developer through the
// authenticated `gh` CLI. Never prints keys, signatures or request text. The
// state file holds the probe's private key: keep it 0600 outside the
// repository, and revoke the probe Slot when done.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { STAGING_WEBHOOK } from "./github-webhook-spike.ts";

export const STAGING_ORIGIN = new URL(STAGING_WEBHOOK).origin;
const SANDBOX = "Quick-Release/gq-support-sandbox";
const SANDBOX_ID = 1424354303;
const BOT = "getquick-support-staging[bot]";
/** Inside the Reporter read budget of 120 per 10 minutes, with room for retries. */
const POLL_MS = 10_000;

export interface Transition {
  readonly state: "open" | "closed";
  /** GitHub's `updated_at` for the change, the start of the freshness measurement. */
  readonly githubUpdatedAt: string;
  readonly observedAt: string | null;
  readonly lagMs: number | null;
}
export interface ProbeState {
  readonly installationId: string;
  readonly subject: string;
  readonly keyId: string;
  readonly privateKey: JsonWebKey;
  readonly requestId?: string;
  readonly summary?: string;
  readonly issueNumber?: number;
  readonly transitions: readonly Transition[];
}
export interface ProbeDeps {
  readonly fetch: typeof fetch;
  /** Runs `gh` with JSON on stdin and returns parsed JSON stdout. */
  readonly gh: (args: readonly string[], stdin?: unknown) => unknown;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly load: () => ProbeState;
  readonly save: (state: ProbeState) => void;
  readonly print: (line: string) => void;
}

const base64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");
const encoder = new TextEncoder();

/** The WordPress signer's wire format (docs/support-api-contract.md, transport). */
const send = async (deps: ProbeDeps, key: CryptoKey, identity: { installationId: string; keyId: string }, method: string, path: string, body = "") => {
  const digest = `sha-256=:${base64(await crypto.subtle.digest("SHA-256", encoder.encode(body)))}:`;
  const timestamp = String(Math.floor(deps.now() / 1000));
  const requestId = crypto.randomUUID();
  const canonical = ["gq-support-v1", method, path, identity.keyId, identity.installationId, timestamp, requestId, digest].join("\n");
  const signature = base64(await crypto.subtle.sign("Ed25519", key, encoder.encode(canonical)));
  return deps.fetch(`${STAGING_ORIGIN}${path}`, { method, body: body || undefined, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json", "GQ-Support-Key-Id": identity.keyId, "GQ-Support-Installation-Id": identity.installationId,
      "GQ-Support-Timestamp": timestamp, "GQ-Support-Request-Id": requestId, "Content-Digest": digest, "GQ-Support-Signature": signature } });
};
export const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest rank: the smallest value with at least p% of observations at or below it.
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

export const summarize = (transitions: readonly Transition[]) => {
  const lags = transitions.flatMap((transition) => transition.lagMs === null ? [] : [transition.lagMs]);
  return { transitions: transitions.length, observed: lags.length, p50Ms: percentile(lags, 50), p95Ms: percentile(lags, 95),
    maxMs: lags.length ? Math.max(...lags) : null };
};

/** Polls until `ready` returns a value, or the deadline passes. */
const poll = async <A>(deps: ProbeDeps, deadline: number, ready: () => Promise<A | undefined>): Promise<A | undefined> => {
  for (;;) {
    const value = await ready();
    if (value !== undefined || deps.now() >= deadline) return value;
    await deps.sleep(POLL_MS);
  }
};

export const runProbe = async (command: string, options: { transitions?: number; timeoutMinutes?: number; code?: string }, deps: ProbeDeps) => {
  const timeout = (options.timeoutMinutes ?? 5) * 60_000;
  if (command === "enroll") {
    if (!/^[A-Z2-7-]{26,40}$/.test(options.code ?? "")) throw new Error("enrollment_code");
    const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
    const installationId = `gq-status-probe-${crypto.randomUUID()}`;
    const body = JSON.stringify({ code: options.code, installation_id: installationId, origin: "https://status-probe.invalid",
      public_key: base64(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer) });
    const response = await send(deps, pair.privateKey, { installationId, keyId: "" }, "POST", "/v1/enroll", body);
    if (response.status !== 200) throw new Error(`enroll_${response.status}`);
    const { key_id: keyId } = await response.json() as { key_id: string };
    deps.save({ installationId, keyId, subject: crypto.randomUUID(), transitions: [],
      privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey });
    return { enrolled: true, keyId };
  }
  let state = deps.load();
  let key: CryptoKey | undefined;
  const call = async (method: string, path: string, body?: string) =>
    send(deps, key ??= await crypto.subtle.importKey("jwk", state.privateKey, "Ed25519", false, ["sign"]), state, method, path, body);
  const request = async () => {
    const response = await call("GET", `/v1/requests/${state.requestId}?reporter_subject=${state.subject}&scope=mine`);
    if (response.status !== 200) throw new Error(`read_${response.status}`);
    return await response.json() as { delivery: string; status: "open" | "closed" | null };
  };
  if (command === "submit") {
    const summary = `GQ status sync probe ${crypto.randomUUID().slice(0, 8)}`;
    const response = await call("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
      reporter_subject: state.subject, scope: "mine", summary, description: "Synthetic staging probe (#57). No client data." }));
    if (response.status !== 202) throw new Error(`submit_${response.status}`);
    state = { ...state, requestId: (await response.json() as { id: string }).id, summary };
    deps.save(state);
    const delivered = await poll(deps, deps.now() + timeout, async () => (await request()).status ?? undefined);
    if (delivered !== "open") throw new Error("not_delivered");
    const issues = deps.gh(["api", `repos/${SANDBOX}/issues?creator=${encodeURIComponent(BOT)}&state=all&per_page=100`]) as
      { number: number; title: string; pull_request?: unknown }[];
    const issue = issues.find((candidate) => candidate.title === summary && !candidate.pull_request);
    if (!issue) throw new Error("issue_not_found");
    state = { ...state, issueNumber: issue.number };
    deps.save(state);
    return { submitted: true, issueNumber: issue.number };
  }
  if (command === "measure") {
    if (!state.issueNumber) throw new Error("submit_first");
    const repository = deps.gh(["api", `repos/${SANDBOX}`]) as { id: number; private: boolean };
    if (repository.id !== SANDBOX_ID) throw new Error("sandbox_identity");
    const started = deps.now();
    for (let index = 0; index < (options.transitions ?? 1); index += 1) {
      const current = (await request()).status;
      const next = current === "open" ? "closed" : "open";
      // The Developer's change. Its response's `updated_at` starts the clock.
      const changed = deps.gh(["api", `repos/${SANDBOX}/issues/${state.issueNumber}`, "--method", "PATCH", "--input", "-"],
        { state: next }) as { state: string; updated_at: string };
      if (changed.state !== next) throw new Error("github_state");
      const observed = await poll(deps, deps.now() + timeout, async () => (await request()).status === next ? deps.now() : undefined);
      const transition: Transition = { state: next, githubUpdatedAt: changed.updated_at, observedAt: observed === undefined ? null : new Date(observed).toISOString(),
        lagMs: observed === undefined ? null : observed - Date.parse(changed.updated_at) };
      state = { ...state, transitions: [...state.transitions, transition] };
      deps.save(state);
      deps.print(JSON.stringify(transition));
    }
    // Observing must never write to GitHub: no App events or comments after the Developer's first change.
    const issue = `repos/${SANDBOX}/issues/${state.issueNumber}`;
    // Page by page: `gh api --paginate --slurp` needs gh 2.48 or later, and plain `--paginate` prints one array per page.
    const pages = <A>(path: string) => {
      const items: A[] = [];
      for (let page = 1; ; page += 1) {
        const batch = deps.gh(["api", `${path}?per_page=100&page=${page}`]) as A[];
        items.push(...batch);
        if (batch.length < 100) return items;
      }
    };
    const events = pages<{ actor: { login: string } | null; created_at: string }>(`${issue}/events`);
    const comments = pages<{ user: { login: string } | null }>(`${issue}/comments`);
    // GitHub reports whole seconds: compare instants, floored to the second the measurement started in.
    const appWrites = events.filter((event) => event.actor?.login === BOT && Date.parse(event.created_at) >= Math.floor(started / 1000) * 1000).length +
      comments.filter((comment) => comment.user?.login === BOT).length;
    return { ...summarize(state.transitions), appWrites };
  }
  if (command === "watch-suspension") {
    // The Operator makes the sandbox public separately; this measures from when the probe starts.
    const started = deps.now();
    const suspended = await poll(deps, started + timeout, async () => {
      const response = await call("GET", "/v1/installation");
      if (response.status !== 200) throw new Error(`installation_${response.status}`);
      return (await response.json() as { mapping_state: string }).mapping_state === "suspended" ? deps.now() : undefined;
    });
    if (suspended === undefined) return { suspended: false, afterMs: null, createRefused: null };
    // What the Reporter's form then gets: a create refused as not configured, with nothing written.
    const refused = await call("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(), reporter_subject: state.subject,
      scope: "mine", summary: "GQ status sync probe while suspended", description: "Synthetic staging probe (#57). No client data." }));
    const code = refused.status === 403 ? (await refused.json() as { code?: string }).code : undefined;
    return { suspended: true, afterMs: suspended - started, createRefused: code === "gq_support_not_configured" };
  }
  if (command === "report") return summarize(state.transitions);
  throw new Error("command");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    state: { type: "string" }, transitions: { type: "string" }, "timeout-minutes": { type: "string" } } });
  const path = values.state;
  try {
    if (!path) throw new Error("state");
    const result = await runProbe(positionals[0] ?? "", {
      transitions: values.transitions ? Number(values.transitions) : undefined,
      timeoutMinutes: values["timeout-minutes"] ? Number(values["timeout-minutes"]) : undefined,
      // The enrollment code is a credential: read it from stdin, never argv.
      code: positionals[0] === "enroll" ? readFileSync(0, "utf8").trim().toUpperCase() : undefined,
    }, {
      fetch, now: Date.now, sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      load: () => JSON.parse(readFileSync(path, "utf8")) as ProbeState,
      save: (state) => writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }),
      print: (line) => console.log(line),
      gh: (args, stdin) => {
        const result = spawnSync("gh", args, { input: stdin === undefined ? undefined : JSON.stringify(stdin), encoding: "utf8" });
        // CLI errors may contain request data. Never echo captured output.
        if (result.status !== 0) throw new Error("gh_failed");
        return JSON.parse(result.stdout);
      },
    });
    console.log(`GQ_STATUS_PROBE=${JSON.stringify(result)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason = /^[a-z_]+(_[0-9]{3})?$/.test(message) ? message : "unexpected";
    console.error(`Status sync probe failed (${reason}); keys, signatures and request text suppressed`);
    process.exitCode = 1;
  }
}
