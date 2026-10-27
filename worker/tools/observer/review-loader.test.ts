import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createObserverReadSession, observerReadCommand } from "./review-loader.ts";
import { observerRequest } from "../../src/observer-http.ts";

const root = "https://api.github.com/repos/Quick-Release/gq-support";
const now = Date.UTC(2026, 8, 16, 12), head = "a".repeat(40);
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const canary = () => `gqcanary_${randomBytes(24).toString("hex")}`;
function fixture() {
  let time = now;
  const pins = { stage: "staging" as const, candidate: head, session: randomBytes(32).toString("hex"),
    nonce: randomBytes(32).toString("hex"), readyAt: now - 2000, expiresAt: now + 60_000 };
  const target = { account: "8f38791a8c37b182239af2a385ab3c31" as const, stage: pins.stage, candidate: head, generation: 1,
    worker: "synthetic-staging", origin: "https://synthetic-staging.synthetic.workers.dev",
    deployment: "11111111-1111-1111-1111-111111111111", version: "22222222-2222-2222-2222-222222222222" };
  const manifest = { schema: 1, purpose: "observer_reads", ...pins, target,
    context: { now, account: target.account, stage: pins.stage, candidate: head, generation: 1, activation: 0, exclusions: [], expected: [] },
    observation: 1, snapshotReview: null };
  const bytes = encode(manifest);
  // Same reviewed-metadata pattern as deployment verifier; synthetic IDs only.
  const policy = { approvers: { vvaz: 11, gmarques: 22 } };
  const githubToken = canary(), snapshotToken = randomBytes(32).toString("hex");
  const comment = { id: 789, url: `${root}/issues/comments/789`, issue_url: `${root}/issues/20`,
    html_url: "https://github.com/Quick-Release/gq-support/issues/20#issuecomment-789",
    user: { login: "vvaz", id: 11, type: "User" }, body: observerReadCommand(hash(bytes)),
    created_at: new Date(now - 1000).toISOString(), updated_at: new Date(now - 1000).toISOString() };
  const response = (url: string, body: unknown, status = 200) => Object.defineProperty(
    new Response(encode(body), { status, headers: { "content-type": "application/json" } }), "url", { value: url });
  const github = vi.fn<typeof fetch>(async url => {
    const u = String(url);
    if (u === `${root}/issues/comments/789`) return response(u, comment);
    if (u === "https://api.github.com/users/vvaz") return response(u, comment.user);
    if (u === `${root}/collaborators/vvaz/permission`) return response(u, { permission: "write", user: comment.user });
    throw new Error(canary());
  });
  const worker = vi.fn<typeof fetch>(async url => response(String(url), String(url).endsWith("readiness")
    ? { version: 1, check: "route_runtime", result: "available" }
    : { version: 1, generated: time, stage: pins.stage, candidate: head, generation: 1,
      maintenance: "open", watermark: time, partial: false, activation: null, coverage: "unknown", route: "disabled", ticks: [] }));
  const controller = new AbortController();
  const io = { github, worker, now: () => time, signal: controller.signal };
  const start = (supplied = bytes) => createObserverReadSession(policy, { ...pins, sha256: hash(bytes) }, githubToken)
    .observe({ manifest: supplied, commentId: 789, snapshotToken }, io);
  function startManifest(value: unknown) {
    const supplied = encode(value), sha256 = hash(supplied);
    comment.body = observerReadCommand(sha256);
    return createObserverReadSession(policy, { ...pins, sha256 }, githubToken)
      .observe({ manifest: supplied, commentId: 789, snapshotToken }, io);
  }
  return { pins, manifest, bytes, policy, githubToken, snapshotToken, comment, response, github, worker, controller, io, start, startManifest,
    setTime: (t: number) => { time = t; } };
}
afterEach(() => vi.useRealTimers());

it("authenticates exact GitHub record and revalidates before real126 dispatch; credentials stay isolated", async () => {
  const f = fixture(), result = await f.start();
  expect(result.public).toMatchObject({ readiness: "available", snapshot: "accepted", review: "unknown", continuity: "unknown" });
  expect(f.github).toHaveBeenCalledTimes(16);
  expect(f.worker).toHaveBeenCalledTimes(2);
  for (const [url, init] of f.github.mock.calls) {
    expect(String(url).startsWith("https://api.github.com/")).toBe(true);
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { Authorization: `Bearer ${f.githubToken}` } });
    expect(JSON.stringify(init)).not.toContain(f.snapshotToken);
  }
  for (const [url, init] of f.worker.mock.calls) {
    expect(String(url).startsWith(f.manifest.target.origin)).toBe(true);
    expect(JSON.stringify(init)).not.toContain(f.githubToken);
  }
  expect(f.worker.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
  expect(f.worker.mock.calls[1][1]?.headers).toHaveProperty("Authorization", `Bearer ${f.snapshotToken}`);
  for (const privateValue of [f.githubToken, f.snapshotToken, f.manifest.target.origin, f.pins.session])
    expect(JSON.stringify(result.public)).not.toContain(privateValue);
});

it.each(["missing", "issue", "repo", "id", "login", "type", "edited", "future", "old", "grammar", "hash", "reviewer", "revoked"])("refuses %s proof before Worker calls", async fault => {
  const f = fixture();
  if (fault === "issue") f.comment.issue_url = `${root}/issues/29`;
  if (fault === "repo") f.comment.url = "https://api.github.com/repos/other/repo/issues/comments/789";
  if (fault === "id") f.comment.user.id++;
  if (fault === "login") f.comment.user.login = "outsider";
  if (fault === "type") f.comment.user.type = "Bot";
  if (fault === "edited") f.comment.updated_at = new Date(now).toISOString();
  if (fault === "future") f.comment.created_at = f.comment.updated_at = new Date(now + 1000).toISOString();
  if (fault === "old") f.comment.created_at = f.comment.updated_at = new Date(f.pins.readyAt).toISOString();
  if (fault === "grammar") f.comment.body += "\n";
  if (fault === "hash") f.comment.body = observerReadCommand("0".repeat(64));
  if (fault === "reviewer") Object.assign(f.comment, { reviewer: "vvaz", approved: true, digest: hash(f.bytes), user: {} });
  if (["missing", "revoked"].includes(fault)) f.github.mockImplementation(async url => f.response(String(url), {}, 404));
  expect((await f.start()).public.verdict).toBeNull();
  expect(f.worker).not.toHaveBeenCalled();
});

it.each(["deletion", "edit", "permission", "cancel", "expiry"])("fences %s between readiness and nested credential forwarding", async fault => {
  const f = fixture();
  if (fault === "expiry") f.pins.expiresAt = f.manifest.expiresAt = now + 1000;
  f.worker.mockImplementationOnce(async url => {
    if (fault === "deletion") f.github.mockImplementation(async u => f.response(String(u), {}, 404));
    if (fault === "edit") f.comment.body = f.comment.body.replace("approve-", "revoke-");
    if (fault === "permission") f.github.mockImplementation(async u => f.response(String(u), { permission: "read", user: f.comment.user }));
    if (fault === "cancel") f.controller.abort();
    if (fault === "expiry") f.setTime(f.pins.expiresAt);
    return f.response(String(url), { version: 1, check: "route_runtime", result: "available" });
  });
  expect((await f.startManifest(f.manifest)).public.verdict).toBeNull();
  expect(f.worker).toHaveBeenCalledTimes(1);
});

it("consumes the session BEFORE malformed manifest decoding, including second concurrent use", async () => {
  const f = fixture(), session = createObserverReadSession(f.policy, { ...f.pins, sha256: hash(f.bytes) }, f.githubToken);
  const request = { manifest: encode("bad"), commentId: 789, snapshotToken: f.snapshotToken };
  expect((await session.observe(request, f.io)).public.verdict).toBeNull();
  request.manifest = f.bytes;
  expect((await session.observe(request, f.io)).public.verdict).toBeNull();
  expect(f.github).not.toHaveBeenCalled(); expect(f.worker).not.toHaveBeenCalled();
});

it.each(["session", "nonce", "stage", "candidate", "purpose", "expiresAt", "readyAt", "extra", "target", "context"])("digest approval cannot override independent %s operation pins", async key => {
  const f = fixture(), m = structuredClone(f.manifest);
  if (key === "session" || key === "nonce") m[key] = "b".repeat(64);
  if (key === "stage") Object.assign(m, { stage: "prod" });
  if (key === "candidate") m.candidate = "b".repeat(40);
  if (key === "purpose") m.purpose = "deploy";
  if (key === "expiresAt" || key === "readyAt") m[key]++;
  if (key === "extra") Object.assign(m, { approved: true, reviewer: "vvaz" });
  if (key === "target" || key === "context") m[key].candidate = "c".repeat(40);
  expect((await f.startManifest(m)).public.verdict).toBeNull();
  expect(f.worker).not.toHaveBeenCalled();
});

it.each(["cancel", "expiry", "clock", "timeout"])("rechecks %s after pending verification without Worker dispatch", async fault => {
  vi.useFakeTimers(); const f = fixture();
  if (fault === "expiry") f.pins.expiresAt = f.manifest.expiresAt = now + 1000;
  let release!: (r: Response) => void;
  f.github.mockImplementationOnce(async () => new Promise(r => { release = r; }));
  const run = f.startManifest(f.manifest);
  if (fault === "cancel") f.controller.abort();
  if (fault === "expiry") f.setTime(f.pins.expiresAt);
  if (fault === "clock") f.setTime(now - 1);
  if (fault === "timeout") await vi.advanceTimersByTimeAsync(10_001);
  release(f.response(`${root}/issues/comments/789`, f.comment));
  expect((await run).public.verdict).toBeNull();
  expect(f.worker).not.toHaveBeenCalled(); expect(f.github).toHaveBeenCalledTimes(1);
});

it.each(["redirect", "url", "large-length", "large-stream", "chunks", "length", "json", "utf8", "encoding", "cookie", "links", "non200", "content-type", "timeout-body", "error"])("bounds/refuses GitHub %s without leaking provider errors", async fault => {
  vi.useFakeTimers(); const f = fixture(), cancelled = vi.fn();
  f.github.mockImplementationOnce(async url => {
    if (fault === "error") throw new Error(f.githubToken + f.snapshotToken + f.manifest.target.origin);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (fault === "content-type") headers["content-type"] = "text/html";
    if (fault === "large-length") headers["content-length"] = "32769";
    if (fault === "length") headers["content-length"] = "1";
    if (fault === "encoding") headers["content-encoding"] = "gzip";
    if (fault === "cookie") headers["set-cookie"] = canary();
    if (fault === "links") headers.link = '<https://untrusted.invalid>; rel="next"';
    const body = new ReadableStream<Uint8Array>({ start(c) {
      if (fault === "timeout-body") return;
      if (fault === "large-stream") c.enqueue(new Uint8Array(32769));
      else if (fault === "chunks") for (let n = 0; n < 1025; n++) c.enqueue(new Uint8Array());
      else c.enqueue(fault === "json" ? encode("bad") : fault === "utf8" ? new Uint8Array([255]) : encode(f.comment));
      // Deliberately leave the refused stream cancellable.
      if (!["large-stream", "chunks"].includes(fault)) c.close();
    }, cancel: cancelled });
    const r = new Response(body, { status: fault === "redirect" ? 302 : fault === "non200" ? 403 : 200, headers });
    Object.defineProperty(r, "url", { value: fault === "url" ? "https://untrusted.invalid" : String(url) });
    return r;
  });
  const run = f.start(); await vi.advanceTimersByTimeAsync(10_001); const result = await run;
  expect(result.public.verdict).toBeNull(); expect(f.worker).not.toHaveBeenCalled();
  expect(f.github).toHaveBeenCalledTimes(1);
  for (const value of [f.githubToken, f.snapshotToken, f.manifest.target.origin]) expect(JSON.stringify(result)).not.toContain(value);
  if (["large-stream", "chunks", "timeout-body"].includes(fault)) expect(cancelled).toHaveBeenCalledTimes(1);
});

it("copies bytes, metadata, token and IO before awaits, refusing a concurrent second use", async () => {
  const f = fixture(); let release!: (r: Response) => void;
  const session = createObserverReadSession(f.policy, { ...f.pins, sha256: hash(f.bytes) }, f.githubToken);
  f.github.mockImplementationOnce(async () => new Promise(r => { release = r; }));
  const request = { manifest: f.bytes.slice(), commentId: 789, snapshotToken: f.snapshotToken };
  const run = session.observe(request, f.io);
  expect((await session.observe(request, f.io)).public.verdict).toBeNull();
  request.manifest.fill(0); request.commentId++; request.snapshotToken = canary(); f.policy.approvers.vvaz++;
  f.io.github = vi.fn(async () => { throw new Error(canary()); });
  f.io.worker = vi.fn(async () => { throw new Error(canary()); });
  release(f.response(`${root}/issues/comments/789`, f.comment));
  expect((await run).public.snapshot).toBe("accepted");
  expect(f.worker).toHaveBeenCalledTimes(2); expect(f.io.worker).not.toHaveBeenCalled();
});

it.each(["identity-id", "identity-type", "permission-id", "permission-type", "permission-read"])("requires current %s as well as comment identity", async fault => {
  const f = fixture(), original = f.github.getMockImplementation()!;
  f.github.mockImplementation(async (url, init) => {
    const u = String(url), user = { ...f.comment.user };
    if (u.includes("/users/") && fault.startsWith("identity")) {
      if (fault === "identity-id") user.id++;
      else user.type = "Bot";
      return f.response(u, user);
    }
    if (u.endsWith("/permission") && fault.startsWith("permission")) {
      if (fault === "permission-id") user.id++;
      if (fault === "permission-type") user.type = "Bot";
      return f.response(u, { user, permission: fault === "permission-read" ? "read" : "write" });
    }
    return original(url, init);
  });
  expect((await f.start()).public.verdict).toBeNull(); expect(f.worker).not.toHaveBeenCalled();
});

it("authenticates gmarques independently with equal authority", async () => {
  const f = fixture(); f.comment.user = { login: "gmarques", id: 22, type: "User" };
  f.github.mockImplementation(async url => f.response(String(url), String(url).endsWith("/789") ? f.comment :
    String(url).endsWith("/permission") ? { permission: "admin", user: f.comment.user } : f.comment.user));
  expect((await f.start()).public.snapshot).toBe("accepted");
});

it("does not accept locally self-reported review custody as actor authentication", async () => {
  const f = fixture();
  f.github.mockImplementation(async u => f.response(String(u), { ...f.manifest, approved: true, reviewer: "vvaz", digest: hash(f.bytes) }));
  expect((await f.start()).public.verdict).toBeNull(); expect(f.worker).not.toHaveBeenCalled();
});

it("integrates authenticated handoff with actual endpoint readiness without enabling business health", async () => {
  const f = fixture();
  // Readiness never acquires the ledger or a credential. The real aggregate
  // endpoint denies absent runtime configuration; authentication isn't health.
  f.worker.mockImplementation(async (url, init) => {
    const r = await observerRequest(new Request(String(url), init), { SUPPORT_OBSERVER_ENABLED: "true" }, async () => { throw new Error(canary()); });
    Object.defineProperty(r, "url", { value: String(url) }); return r;
  });
  const result = await f.start();
  expect(result.public.readiness).toBe("available"); expect(result.public.snapshot).toBe("denied");
  expect(result.public.continuity).toBe("unknown"); expect(result.public.review).toBe("unknown");
});

it.each(["valid", "reviewer", "record", "snapshot", "version", "generation"])("binds optional #125 %s review to authenticated actor and all private bytes", async fault => {
  const f = fixture();
  const wire = { version: 1, generated: now, stage: f.pins.stage, candidate: head, generation: 1,
    maintenance: "open", watermark: now, partial: false, activation: null, coverage: "unknown", route: "disabled", ticks: [] };
  const review = { schema: 1, proof: "reviewed_business_activation", account: f.manifest.target.account, stage: f.pins.stage,
    candidate: head, deployment: f.manifest.target.deployment, version: f.manifest.target.version, generation: 1,
    activatedAt: 0, validFrom: now - 60_000, validTo: now + 60_000, issued: now, evidenceObserved: now,
    reviewer: fault === "reviewer" ? "gmarques" : "vvaz",
    record: fault === "record" ? "b".repeat(64) : hash(new TextEncoder().encode(`${root}/issues/comments/789`)),
    notification: "disabled", exclusions: [], snapshotSha256: fault === "snapshot" ? "b".repeat(64) : hash(encode(wire)),
    observation: 1, readAt: now };
  if (fault === "version") review.version = f.manifest.target.deployment;
  if (fault === "generation") review.generation++;
  const m = { ...f.manifest, snapshotReview: JSON.stringify(review) };
  const result = await f.startManifest(m);
  expect(result.public.review).toBe(fault === "valid" ? "reviewed_external_input" : "unknown");
  expect(result.public.continuity).toBe("unknown");
  if (["reviewer", "record", "version", "generation"].includes(fault)) expect(f.worker).not.toHaveBeenCalled();
  if (fault === "valid") {
    expect(result.public.verdict?.classes.find(c => c.class === "cron_start_missing")?.verdict).toBe("unknown");
    expect(result.public.verdict?.classes.find(c => c.class === "cron_incomplete")?.verdict).toBe("unknown");
  }
});

it("disposes a late GitHub response after timeout without further verification or dispatch", async () => {
  vi.useFakeTimers(); const f = fixture(), cancelled = vi.fn();
  let release!: (r: Response) => void;
  f.github.mockImplementationOnce(async () => new Promise(r => { release = r; }));
  const run = f.start(); await vi.advanceTimersByTimeAsync(10_001);
  expect((await run).public.verdict).toBeNull();
  release(new Response(new ReadableStream({ cancel: cancelled })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toHaveBeenCalledTimes(1); expect(f.github).toHaveBeenCalledTimes(1); expect(f.worker).not.toHaveBeenCalled();
});

it("refuses approval revoked while the snapshot response is pending and publishes no stale review", async () => {
  const f = fixture(), original = f.worker.getMockImplementation()!;
  f.worker.mockImplementation(async (url, init) => {
    const r = await original(url, init);
    if (String(url).endsWith("snapshot")) f.comment.body = f.comment.body.replace("approve-", "revoke-");
    return r;
  });
  expect((await f.start()).public.verdict).toBeNull(); expect(f.worker).toHaveBeenCalledTimes(2);
});

it.each(["auth", "token", "malformed-snapshot"])("failed %s consumes authority before a corrected second attempt", async fault => {
  const f = fixture(), command = f.comment.body;
  const session = createObserverReadSession(f.policy, { ...f.pins, sha256: hash(f.bytes) }, f.githubToken);
  const request = { manifest: f.bytes, commentId: 789, snapshotToken: f.snapshotToken };
  if (fault === "auth") f.comment.user.id++;
  if (fault === "token") request.snapshotToken = canary();
  if (fault === "malformed-snapshot") f.worker.mockImplementationOnce(async u => f.response(String(u),
    { version: 1, check: "route_runtime", result: "available" })).mockImplementationOnce(async u => f.response(String(u), {}));
  expect((await session.observe(request, f.io)).public.snapshot).not.toBe("accepted");
  const calls = f.github.mock.calls.length, workers = f.worker.mock.calls.length;
  f.comment.user.id = 11; f.comment.body = command; request.snapshotToken = f.snapshotToken;
  expect((await session.observe(request, f.io)).public.verdict).toBeNull();
  expect(f.github).toHaveBeenCalledTimes(calls); expect(f.worker).toHaveBeenCalledTimes(workers);
});

it.each(["expired", "future-window", "wide-window", "same-token", "missing-ids"])("refuses initial %s custody without HTTP", async fault => {
  const f = fixture();
  if (fault === "expired") f.setTime(f.pins.expiresAt);
  if (fault === "future-window") f.setTime(f.pins.readyAt - 1);
  if (fault === "wide-window") f.pins.expiresAt = f.pins.readyAt + 5 * 60_000 + 1;
  if (fault === "missing-ids") f.policy.approvers.vvaz = 0;
  const session = createObserverReadSession(f.policy, { ...f.pins, sha256: hash(f.bytes) }, fault === "same-token" ? f.snapshotToken : f.githubToken);
  expect((await session.observe({ manifest: f.bytes, commentId: 789, snapshotToken: f.snapshotToken }, f.io)).public.verdict).toBeNull();
  expect(f.github).not.toHaveBeenCalled(); expect(f.worker).not.toHaveBeenCalled();
});

it.each(["cancel", "expiry"])("rechecks %s after the final async snapshot dispatch verification", async fault => {
  const f = fixture(), original = f.github.getMockImplementation()!;
  f.pins.expiresAt = f.manifest.expiresAt = now + 1000;
  let calls = 0;
  f.github.mockImplementation(async (url, init) => {
    const r = await original(url, init);
    if (++calls === 12) {
      if (fault === "cancel") f.controller.abort();
      else f.setTime(f.pins.expiresAt);
    }
    return r;
  });
  expect((await f.startManifest(f.manifest)).public.verdict).toBeNull();
  expect(f.worker).toHaveBeenCalledTimes(1); expect(f.github).toHaveBeenCalledTimes(12);
});
