import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { observeHTTPS, type PrivateReadInput, type TransportIO } from "./https-transport.ts";
import { validateSnapshotReview } from "./snapshot-evidence.ts";
import { decodeBatch } from "./protocol.ts";
import { observerRequest } from "../../src/observer-http.ts";

const M = 60_000, now = 120 * M, candidate = "a".repeat(40);
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const token = () => randomBytes(32).toString("hex");
const canary = () => `gqcanary_${randomBytes(24).toString("hex")}`;
const input = (stage: "staging" | "prod" = "staging"): PrivateReadInput => ({
  target: { account: "8f38791a8c37b182239af2a385ab3c31", stage, candidate, generation: 1,
    worker: `synthetic-${stage}`, origin: `https://synthetic-${stage}.synthetic.workers.dev`,
    deployment: "11111111-1111-1111-1111-111111111111", version: "22222222-2222-2222-2222-222222222222" },
  context: { now, account: "8f38791a8c37b182239af2a385ab3c31", stage, candidate,
    generation: 1, activation: 0, expected: [], exclusions: [] }, observation: 1, snapshotToken: token(),
});
const wire = (i = input()) => ({ version: 1, generated: now, stage: i.target.stage, candidate, generation: 1,
  maintenance: "open", watermark: now, partial: false, activation: null, coverage: "unknown", route: "disabled", ticks: [] });
const ready = { version: 1, check: "route_runtime", result: "available" };
// Response() has an empty URL; fake fetch must supply the final URL just as fetch
// would. This models HTTP semantics only, never TLS/DNS/ownership verification.
function response(url: string, value: unknown, status = 200, headers: Record<string, string> = {}) {
  const r = new Response(encode(value), { status, headers: { "content-type": "application/json", ...headers } });
  Object.defineProperty(r, "url", { value: url }); return r;
}
const fake = (i: PrivateReadInput, f?: (url: string, init?: RequestInit) => Promise<Response>): TransportIO => ({
  now: () => now, fetch: vi.fn(async (url, init) => f ? f(String(url), init) : response(String(url), String(url).endsWith("readiness") ? ready : wire(i))),
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["staging", "prod"] as const)("integrates fixed %s reads with actual endpoint wire and evaluator; tokens only reach snapshot", async stage => {
  const i = input(stage);
  vi.stubGlobal("crypto", { randomUUID: crypto.randomUUID.bind(crypto), subtle: {
    digest: crypto.subtle.digest.bind(crypto.subtle), timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b)),
  } });
  const io = fake(i, async (url, init) => {
    // The actual readiness endpoint must not even acquire a ledger. Snapshot
    // intentionally uses actual endpoint auth with an unavailable ledger here.
    const r = await observerRequest(new Request(url, init), {
      SUPPORT_OBSERVER_ENABLED: "true", SUPPORT_OBSERVER_READ_TOKEN: i.snapshotToken,
      SUPPORT_OBSERVER_STAGE: stage, SUPPORT_OBSERVER_RELEASE: candidate,
      SUPPORT_RELEASE_STAGE: stage, SUPPORT_RELEASE_CANDIDATE: candidate,
    }, async () => { throw new Error(canary()); });
    Object.defineProperty(r, "url", { value: url }); return r;
  });
  expect((await observeHTTPS(i, io)).public).toMatchObject({ readiness: "available", snapshot: "unavailable", continuity: "unknown" });
  const calls = vi.mocked(io.fetch).mock.calls;
  expect(calls).toHaveLength(2);
  for (const [n, [url, init]] of calls.entries()) {
    expect(url).toBe(i.target.origin + `/internal/observer/v1/${n ? "snapshot" : "readiness"}`);
    expect(init).toEqual({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal: expect.any(AbortSignal),
      headers: n ? { Accept: "application/json", "Accept-Encoding": "identity", Authorization: `Bearer ${i.snapshotToken}` } : { Accept: "application/json", "Accept-Encoding": "identity" } });
  }
  const good = await observeHTTPS(i, fake(i));
  expect(good.public).toMatchObject({ readiness: "available", snapshot: "accepted", review: "unknown", continuity: "unknown" });
  expect(good.public.verdict?.classes.find(c => c.class === "cron_start_missing")?.verdict).toBe("unknown");
  expect(good.public.verdict?.classes.find(c => c.class === "cron_incomplete")?.verdict).toBe("unknown");
  expect(encode(good.public).byteLength).toBeLessThanOrEqual(2048);
  expect(JSON.stringify(good.public)).not.toContain(i.snapshotToken);
});

it("reads readiness without a credential; its success cannot authorize snapshot", async () => {
  const i = input(); delete i.snapshotToken;
  const io = fake(i); const r = await observeHTTPS(i, io);
  expect(r.public).toMatchObject({ readiness: "available", snapshot: "not_requested", review: "unknown" });
  expect(io.fetch).toHaveBeenCalledTimes(1);
});

it("copies credentials, all target/context revisions and run identity before awaiting", async () => {
  const i = input(), original = structuredClone(i);
  let release!: (r: Response) => void;
  const io = fake(i, async url => url.endsWith("readiness") ? new Promise(r => { release = r; }) : response(url, wire(original)));
  const run = observeHTTPS(i, io);
  i.target.origin = "https://other.invalid"; i.target.candidate = "b".repeat(40); i.target.generation++;
  i.target.version = i.target.deployment; i.snapshotToken = token(); i.context.stage = "prod"; i.context.candidate = "c".repeat(40); i.context.generation++; i.observation++;
  release(response(original.target.origin + "/internal/observer/v1/readiness", ready));
  const r = await run;
  expect(r.public.snapshot).toBe("accepted");
  expect(vi.mocked(io.fetch).mock.calls[1]).toMatchObject([original.target.origin + "/internal/observer/v1/snapshot",
    { headers: { Authorization: `Bearer ${original.snapshotToken}` } }]);
});

it.each([
  "http://synthetic-staging.synthetic.workers.dev", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://10.0.0.1", "https://169.254.169.254",
  "https://synthetic-staging.local", "https://synthetic-staging.synthetic.workers.dev/", "https://synthetic-staging.synthetic.workers.dev/internal/observer/v1/snapshot",
  "https://synthetic-staging.synthetic.workers.dev?", "https://synthetic-staging.synthetic.workers.dev?q=private", "https://synthetic-staging.synthetic.workers.dev#x",
  "https://user@synthetic-staging.synthetic.workers.dev", "https://synthetic-staging.synthetic.workers.dev:443", "https://synthetic-staging.synthetic.workers.dev:8443",
  "https://synthetic-staging.synthetic.workers.dev.", "https://SYNTHETIC-staging.synthetic.workers.dev", "https://synthetic-%73taging.synthetic.workers.dev",
  "https://synthetic-prod.synthetic.workers.dev", "https://synthetic-staging.synthetic.workers.dev.evil.invalid",
])("refuses noncanonical/private/cross-worker origin before dispatch: %s", async origin => {
  const i = input(); i.target.origin = origin;
  const io = fake(i); expect((await observeHTTPS(i, io)).public.verdict).toBeNull(); expect(io.fetch).not.toHaveBeenCalled();
});
it.each(["stage", "candidate", "generation", "account", "deployment", "version", "credential", "context"])("refuses invalid explicit %s input before dispatch", async key => {
  const i = input();
  if (key === "stage") i.target.stage = "prod";
  if (key === "candidate") i.target.candidate = "b".repeat(40);
  if (key === "generation") i.target.generation++;
  if (key === "account") i.target.account = "bad" as typeof i.target.account;
  if (key === "deployment") i.target.deployment = canary();
  if (key === "version") i.target.version = canary();
  if (key === "credential") i.snapshotToken = canary();
  if (key === "context") i.context.activation = now + 1;
  const io = fake(i); await observeHTTPS(i, io); expect(io.fetch).not.toHaveBeenCalled();
});

it.each(["url", "path", "query", "redirected", "redirect", "type", "cookie", "encoding", "content-type", "length", "bad-length", "mismatched-length", "json", "utf8", "readiness-contract"])("refuses %s without forwarding credentials or clearing evidence", async kind => {
  const i = input();
  const io = fake(i, async url => {
    let r = response(url, ready);
    if (kind === "url") r = response("https://synthetic-prod.synthetic.workers.dev/internal/observer/v1/readiness", ready);
    if (kind === "path") r = response(url + "/../snapshot", ready);
    if (kind === "query") r = response(url + "?x=1", ready);
    if (kind === "redirected") Object.defineProperty(r, "redirected", { value: true });
    if (kind === "redirect") r = response(url, {}, 302, { location: "https://other.invalid" });
    if (kind === "type") Object.defineProperty(r, "type", { value: "opaqueredirect" });
    if (kind === "cookie") r.headers.set("set-cookie", canary());
    if (kind === "encoding") r.headers.set("content-encoding", "gzip");
    if (kind === "bad-length") r.headers.set("content-length", "1e3");
    if (kind === "mismatched-length") r.headers.set("content-length", "1");
    if (kind === "content-type") r.headers.set("content-type", "text/html");
    if (kind === "length") r.headers.set("content-length", "65537");
    if (kind === "readiness-contract") r = response(url, { healthy: true });
    if (kind === "json" || kind === "utf8") { r = new Response(kind === "json" ? "{" : new Uint8Array([255]), { headers: { "content-type": "application/json" } }); Object.defineProperty(r, "url", { value: url }); }
    return r;
  });
  const r = await observeHTTPS(i, io);
  expect(r.public.readiness).toBe("unknown"); expect(r.public.snapshot).toBe("unavailable"); expect(io.fetch).toHaveBeenCalledTimes(1);
});

it.each([403, 500, 503, 200])("snapshot HTTP %s/invalid JSON stays unavailable/invalid and hides raw canaries", async status => {
  const i = input(), secret = canary();
  const io = fake(i, async url => response(url, url.endsWith("readiness") ? ready : { private: secret, token: i.snapshotToken }, url.endsWith("readiness") ? 200 : status));
  const r = await observeHTTPS(i, io);
  expect(r.public.snapshot).toBe(status === 403 ? "denied" : status === 200 ? "invalid" : "unavailable");
  for (const privateValue of [secret, i.snapshotToken!, i.target.origin, i.target.deployment, candidate]) expect(JSON.stringify(r.public)).not.toContain(privateValue);
});
it("network errors are unavailability at one vantage and never expose raw error text or retry", async () => {
  const i = input(), secret = canary(), io = fake(i, async () => { throw new Error(secret + i.snapshotToken + i.target.origin); });
  const r = await observeHTTPS(i, io);
  expect(r.public.readiness).toBe("unavailable"); expect(io.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(r)).not.toContain(secret); expect(JSON.stringify(r)).not.toContain(i.snapshotToken);
});

it.each(["oversize", "chunks", "header", "during-body", "delayed-headers"])("bounds and cancels %s even with noncooperative fake I/O", async kind => {
  vi.useFakeTimers(); const i = input(), cancelled = vi.fn();
  const io = fake(i, async url => {
    if (kind === "delayed-headers") return new Promise(() => {});
    const body = new ReadableStream<Uint8Array>({ start(c) {
      if (kind === "oversize") { c.enqueue(new Uint8Array(32768)); c.enqueue(new Uint8Array(32769)); c.enqueue(new Uint8Array([1])); c.close(); }
      if (kind === "chunks") { for (let n = 0; n < 1026; n++) c.enqueue(new Uint8Array()); c.close(); }
    }, cancel: cancelled });
    const r = new Response(body, { headers: { "content-type": "application/json", ...(kind === "header" ? { "content-length": "65537" } : {}) } });
    Object.defineProperty(r, "url", { value: url }); return r;
  });
  const pending = observeHTTPS(i, io);
  await vi.advanceTimersByTimeAsync(10_001);
  const r = await pending;
  expect(r.public.snapshot).toBe("unavailable"); expect(io.fetch).toHaveBeenCalledTimes(1);
  if (kind !== "delayed-headers") expect(cancelled).toHaveBeenCalledTimes(1);
  expect(vi.mocked(io.fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it.each(["before", "between", "body", "deadline-between", "deadline-snapshot"])("cancellation/deadline %s invalidates remaining dispatches", async where => {
  vi.useFakeTimers(); const i = input(), controller = new AbortController(), cancel = vi.fn();
  let time = now;
  const io = fake(i, async url => {
    if (url.endsWith("readiness")) {
      if (where === "between") controller.abort();
      if (where === "deadline-between") time += 10_000;
      return response(url, ready);
    }
    if (where === "deadline-snapshot") return new Promise(() => {});
    return Object.defineProperty(new Response(new ReadableStream({ start() { controller.abort(); }, cancel })), "url", { value: url });
  });
  io.signal = controller.signal; io.now = () => time;
  if (where === "before") controller.abort();
  const pending = observeHTTPS(i, io); await vi.advanceTimersByTimeAsync(10_001); const r = await pending;
  expect(r.public.snapshot).toBe("unavailable");
  expect(io.fetch).toHaveBeenCalledTimes(where === "before" ? 0 : where === "body" || where === "deadline-snapshot" ? 2 : 1);
});

it.each(["stage", "candidate", "generation", "stale", "future", "partial", "failed-partial"])("strict actual snapshot handles %s without inventing recovery", async kind => {
  const i = input(), dto = wire(i);
  const value = { ...dto,
    ...(kind === "stage" ? { stage: "prod" } : {}), ...(kind === "candidate" ? { candidate: "b".repeat(40) } : {}),
    ...(kind === "generation" ? { generation: 2 } : {}), ...(kind === "stale" ? { generated: now - 3 * M, watermark: now - 3 * M } : {}),
    ...(kind === "future" ? { generated: now + 1 } : {}), ...(kind.includes("partial") ? { partial: true } : {}),
    ...(kind === "failed-partial" ? { ticks: [["staging", candidate, 1, now - M, 1, now - M, now - 1, 1, 2, 0, 0, 0, 0]] } : {}),
  };
  const r = await observeHTTPS(i, fake(i, async url => response(url, url.endsWith("readiness") ? ready : value)));
  expect(r.public.snapshot).toBe(kind.includes("partial") ? "accepted" : "invalid");
  const verdict = r.public.verdict?.classes.find(c => c.class === "cron_incomplete")?.verdict;
  expect(verdict).toBe(kind === "failed-partial" ? "incident" : "unknown");
  i.previous = r.state;
  const next = await observeHTTPS(i, fake(i));
  expect(next.public.verdict?.classes.find(c => c.class === "cron_incomplete")?.verdict).toBe(kind === "failed-partial" ? "incident" : "unknown");
});

function reviewed(i: PrivateReadInput) {
  const { worker: _worker, origin: _origin, ...pins } = i.target;
  const m = { schema: 1, proof: "reviewed_business_activation", ...pins, activatedAt: 0, validFrom: now - 5 * M, validTo: now + M,
    issued: now, evidenceObserved: now, reviewer: "vvaz" as const, record: randomBytes(32).toString("hex"), notification: "disabled", exclusions: [],
    snapshotSha256: createHash("sha256").update(encode(wire(i))).digest("hex"), observation: 1, readAt: now };
  const custody = { ...pins, reviewer: m.reviewer, record: m.record, sha256: createHash("sha256").update(encode(m)).digest("hex") };
  return validateSnapshotReview(encode(m), custody, now);
}
it("honors independently supplied synthetic review only as external-input claims, never continuity", async () => {
  const i = input(); i.review = reviewed(i);
  // This is a synthetic custody seam, not a real authenticated loader.
  expect((await observeHTTPS(i, fake(i))).public).toMatchObject({ snapshot: "accepted", review: "reviewed_external_input", continuity: "unknown" });
  expect((await observeHTTPS(i, fake(i))).public.review).toBe("unknown");
});
it.each(["target", "token", "timeout", "readiness", "json", "403"])("consumes review BEFORE failed %s snapshot run validation", async kind => {
  vi.useFakeTimers(); const i = input(), cap = reviewed(i); i.review = cap;
  const original = structuredClone({ ...i, review: undefined });
  if (kind === "target") i.target.origin += "?private";
  if (kind === "token") i.snapshotToken = canary();
  const io = fake(i, async url => {
    if (kind === "timeout") return new Promise(() => {});
    return response(url, url.endsWith("readiness") ? kind === "readiness" ? {} : ready : {}, kind === "403" && url.endsWith("snapshot") ? 403 : 200);
  });
  const pending = observeHTTPS(i, io); await vi.advanceTimersByTimeAsync(10_001); await pending;
  const r = { source: "snapshot" as const, observed: 1, at: now, from: now - 60 * M, to: now, ...original.target,
    status: "ok" as const, coverage: "complete" as const, pages: 1, body: encode(wire(original)) };
  const p = decodeBatch(original.context, [r], cap).evidence[0]?.payload;
  expect(p && "claims" in p ? p.claims?.activation : null).toBe("unknown");
});

it("accepts a complete exactly-64KiB chunked JSON read without Content-Length", async () => {
  const i = input(), bytes = encode(ready), padded = new Uint8Array(65536).fill(32);
  padded.set(bytes);
  const io = fake(i, async url => {
    if (url.endsWith("snapshot")) return response(url, wire(i));
    const r = new Response(new ReadableStream({ start(c) { c.enqueue(padded.slice(0, 32)); c.enqueue(padded.slice(32)); c.close(); } }),
      { headers: { "content-type": "application/json; charset=utf-8" } });
    Object.defineProperty(r, "url", { value: url }); return r;
  });
  expect((await observeHTTPS(i, io)).public).toMatchObject({ readiness: "available", snapshot: "accepted" });
});

it.each(["origin", "redirect", "length", "chunked", "body-error", "timeout"])("refuses snapshot %s and requests stream disposal without raw output", async fault => {
  vi.useFakeTimers(); const i = input(), secret = canary(), cancelled = vi.fn();
  const io = fake(i, async url => {
    if (url.endsWith("readiness")) return response(url, ready);
    const body = new ReadableStream<Uint8Array>({ start(c) {
      if (fault === "chunked") { c.enqueue(new Uint8Array(65537)); c.enqueue(new Uint8Array([0])); }
      if (fault === "body-error") c.error(new Error(secret + i.snapshotToken));
    }, cancel: cancelled });
    const r = new Response(body, { status: fault === "redirect" ? 307 : 200,
      headers: { "content-type": "application/json", ...(fault === "length" ? { "content-length": "999999" } : {}) } });
    Object.defineProperty(r, "url", { value: fault === "origin" ? "https://other.invalid" : url });
    return r;
  });
  const run = observeHTTPS(i, io); await vi.advanceTimersByTimeAsync(10_001); const r = await run;
  expect(r.public.snapshot).toBe(fault === "timeout" ? "unavailable" : "invalid");
  expect(r.public.review).toBe("unknown"); expect(io.fetch).toHaveBeenCalledTimes(2);
  if (fault !== "body-error") expect(cancelled).toHaveBeenCalledTimes(1);
  for (const value of [secret, i.snapshotToken!, i.target.origin]) expect(JSON.stringify(r.public)).not.toContain(value);
});

it("disposes a late fetch response after deadline; noncooperative cancellation never delays result or starts snapshot", async () => {
  vi.useFakeTimers(); const i = input(), cancelled = vi.fn(() => new Promise<void>(() => {}));
  let resolve!: (r: Response) => void;
  const io = fake(i, async () => new Promise(r => { resolve = r; }));
  const run = observeHTTPS(i, io); await vi.advanceTimersByTimeAsync(10_001);
  expect((await run).public.snapshot).toBe("unavailable");
  resolve(new Response(new ReadableStream({ cancel: cancelled })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancelled).toHaveBeenCalledTimes(1); expect(io.fetch).toHaveBeenCalledTimes(1);
});

it("HTTP confirmation requires distinct advancing observations of the same reviewed candidate/generation", async () => {
  const i = input(); delete i.snapshotToken;
  let at = now;
  const io = fake(i, async url => response(url, {}, 503)); io.now = () => at;
  const verdict = (r: Awaited<ReturnType<typeof observeHTTPS>>) => r.public.verdict?.classes[0].verdict;
  const first = await observeHTTPS(i, io); expect(verdict(first)).toBe("unknown"); i.previous = first.state;
  i.observation++;
  const equal = await observeHTTPS(i, io); expect(verdict(equal)).toBe("unknown"); i.previous = equal.state;
  at++;
  i.context.now = at; i.observation++;
  const later = await observeHTTPS(i, io); expect(verdict(later)).toBe("incident");
  i.previous = first.state; i.target.generation++; i.context.generation++;
  expect(verdict(await observeHTTPS(i, io))).toBe("unknown");
  i.target.generation--; i.context.generation--; i.target.candidate = "b".repeat(40); i.context.candidate = i.target.candidate;
  expect(verdict(await observeHTTPS(i, io))).toBe("unknown");
});
