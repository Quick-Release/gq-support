import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { actionsFixture, encode, hash, root } from "./actions-private-fixture.ts";
import { actionsReadCommand, createActionsReadSession } from "./actions-review-loader.ts";
import { observeActionsPrivateFiles } from "./actions-private-launcher.ts";
import { observePrivateFiles, type CustodyFS } from "./private-launcher.ts";
import { observerReadCommand } from "./review-loader.ts";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function setup() {
  const f = actionsFixture(), dir = fs.mkdtempSync(join(homedir(), ".gq-actions-offline-")); roots.push(dir);
  fs.chmodSync(dir, 0o700);
  const delivery = join(dir, "delivery"), journal = join(dir, "journal");
  fs.mkdirSync(delivery, { mode: 0o700 }); fs.mkdirSync(journal, { mode: 0o700 });
  const input = { deliveryDirectory: delivery, journalDirectory: journal, pins: f.pins, policy: f.policy, commentId: 789 };
  const supply = (manifest = f.bytes, credentials: unknown = { schema: 1, reviewAuthToken: f.githubToken, actionsReadToken: f.actionsReadToken }) => {
    fs.writeFileSync(join(delivery, "manifest.json"), manifest, { mode: 0o400 });
    fs.writeFileSync(join(delivery, "credentials.json"), encode(credentials), { mode: 0o400 });
  };
  supply();
  return { ...f, input, supply, delivery, journal, launch: (io: CustodyFS = fs) => observeActionsPrivateFiles(input, f.io, io) };
}
const incident = (r: Awaited<ReturnType<ReturnType<typeof actionsFixture>["start"]>>) =>
  r.public.verdict?.classes.find(x => x.class === "workflow_failure")?.verdict;

it("real private files compose approval, disabled workflow, exact old attempt and evaluator after durable barriers", async () => {
  const f = setup(), order: string[] = [];
  const github = f.github.getMockImplementation()!;
  f.github.mockImplementation(async (u, init) => {
    expect(order).toEqual(["file", "dir", "dir"]); expect(fs.readdirSync(f.delivery)).toEqual([]);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${f.githubToken}` });
    expect(String(u)).not.toContain("/actions/"); return github(u, init);
  });
  const r = await f.launch({ ...fs, fsyncSync(fd) { fs.fsyncSync(fd); order.push(fs.fstatSync(fd).isDirectory() ? "dir" : "file"); } });
  expect(r.public.coverage).toBe("complete"); expect(incident(r)).toBe("incident");
  expect(f.github).toHaveBeenCalledTimes(16); expect(f.source).toHaveBeenCalledTimes(2);
  expect(f.source.mock.calls.map(x => String(x[0]))).toEqual([
    `${root}/actions/workflows/deploy-worker.yml`, `${root}/actions/runs/30433642/attempts/1`]);
  for (const [url, init] of f.source.mock.calls) {
    expect(new URL(String(url)).origin).toBe("https://api.github.com");
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { Authorization: `Bearer ${f.actionsReadToken}`, "X-GitHub-Api-Version": "2026-03-10", "Accept-Encoding": "identity" } });
    expect(JSON.stringify(init)).not.toContain(f.githubToken);
  }
  for (const secret of [f.githubToken, f.actionsReadToken, f.snapshotToken, f.canary])
    expect(JSON.stringify(r)).not.toContain(secret);
  const journal = fs.readFileSync(join(f.journal, fs.readdirSync(f.journal)[0]), "utf8");
  expect(JSON.parse(journal).purpose).toBe("observer_actions_reads");
  for (const privateValue of [f.githubToken, f.actionsReadToken, f.canary, "30433642", f.manifest.tracked[0].identity, root]) {
    expect(JSON.stringify(r.public)).not.toContain(privateValue); expect(journal).not.toContain(privateValue);
  }
  expect(f.comment.body).toMatch(/^approve-observer-actions-read sha256:[a-f0-9]{64}$/);
  expect(f.worker).not.toHaveBeenCalled();
});

it.each(["vvaz", "gmarques"] as const)("requires independent numeric %s current identity and repo permission", async actor => {
  const f = actionsFixture(); f.comment.user.login = actor; f.comment.user.id = f.policy.approvers[actor];
  f.github.mockImplementation(async u => f.response(String(u), String(u).includes("/permission")
    ? { permission: "write", user: f.comment.user } : String(u).includes("/users/") ? f.comment.user : f.comment));
  expect(incident(await f.start())).toBe("incident");
});
it.each(["worker-command", "space", "newline", "wrong-digest", "actor", "numeric-id", "bot", "issue", "comment", "edited", "old", "user", "permission"])("rejects unauthenticated record %s before source", async fault => {
  const f = actionsFixture();
  if (fault === "worker-command") f.comment.body = observerReadCommand(f.pins.sha256);
  if (fault === "space") f.comment.body += " ";
  if (fault === "newline") f.comment.body += "\n";
  if (fault === "wrong-digest") f.comment.body = actionsReadCommand("0".repeat(64));
  if (fault === "actor") f.comment.user.login = "attacker";
  if (fault === "numeric-id") f.comment.user.id++;
  if (fault === "bot") f.comment.user.type = "Bot";
  if (fault === "issue") f.comment.issue_url = `${root}/issues/29`;
  if (fault === "comment") f.comment.id++;
  if (fault === "edited") f.comment.updated_at = new Date(f.io.now()).toISOString();
  if (fault === "old") f.comment.created_at = f.comment.updated_at = new Date(f.pins.readyAt).toISOString();
  const original = f.github.getMockImplementation()!;
  f.github.mockImplementation(async (u, init) => String(u).includes("/users/") && fault === "user"
    ? f.response(String(u), { ...f.comment.user, id: 44 }) : String(u).includes("/permission") && fault === "permission"
      ? f.response(String(u), { permission: "read", user: f.comment.user }) : original(u, init));
  expect((await f.start()).public.verdict).toBeNull(); expect(f.source).not.toHaveBeenCalled();
});
it.each(["purpose", "schema", "approved", "reviewer", "repository", "stage", "candidate", "session", "nonce", "expiry", "generation", "ref", "identity", "head", "run", "attempt", "event", "repo", "tracked-stage", "extra-context", "extra-expectation"])("binds exact manifest bytes/pins/joins before auth: %s", async fault => {
  const f = actionsFixture(), m = structuredClone(f.manifest);
  if (fault === "purpose") Object.assign(m, { purpose: "observer_reads" });
  if (fault === "schema") m.schema = 2 as 1;
  if (fault === "approved") Object.assign(m, { approved: true });
  if (fault === "reviewer") Object.assign(m, { reviewer: "vvaz" });
  if (fault === "repository") m.repositoryId = 0;
  if (fault === "stage") m.stage = "prod";
  if (fault === "candidate") m.candidate = "b".repeat(40);
  if (fault === "session") m.session = "c".repeat(64);
  if (fault === "nonce") m.nonce = "d".repeat(64);
  if (fault === "expiry") m.expiresAt++;
  if (fault === "generation") m.context.generation = -1;
  if (fault === "ref") m.tracked[0].ref = "refs/tags/plugin-v1.2.3";
  if (fault === "identity") m.tracked[0].identity = "invalid";
  if (fault === "head") m.tracked[0].expectation.head = "b".repeat(40);
  if (fault === "run") m.tracked[0].expectation.run++;
  if (fault === "attempt") m.tracked[0].expectation.attempt++;
  if (fault === "event") m.tracked[0].expectation.event = "push";
  if (fault === "repo") Object.assign(m.tracked[0].expectation, { repo: "evil/repo" });
  if (fault === "tracked-stage") m.tracked[0].expectation.stage = "prod";
  if (fault === "extra-context") Object.assign(m.context, { approved: true });
  if (fault === "extra-expectation") Object.assign(m.tracked[0].expectation, { approved: true });
  // Break fixture alias so tracked/context mismatch vectors test the actual join.
  if (["head", "run", "attempt"].includes(fault)) m.context.expected = f.manifest.context.expected;
  const bytes = encode(m), pins = { ...f.pins, sha256: hash(bytes) };
  f.comment.body = actionsReadCommand(pins.sha256);
  const result = await createActionsReadSession(f.policy, pins, f.githubToken).observe(
    { manifest: bytes, commentId: 789, actionsReadToken: f.actionsReadToken }, f.io);
  expect(result.public.verdict).toBeNull(); expect(f.github).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled();
});
it("consumes direct session even on wrong hash, no corrected replay", async () => {
  const f = actionsFixture(), session = f.session();
  const request = { manifest: encode({}), commentId: 789, actionsReadToken: f.actionsReadToken };
  await session.observe(request, f.io); request.manifest = f.bytes;
  expect((await session.observe(request, f.io)).public.verdict).toBeNull(); expect(f.github).not.toHaveBeenCalled();
});
it.each(["revoke", "delete", "expire", "cancel"])("%s during async identity check stops all later dispatch", async fault => {
  const f = actionsFixture(), original = f.github.getMockImplementation()!;
  f.github.mockImplementation(async (u, init) => {
    if (String(u).includes("/users/")) {
      if (fault === "revoke") f.comment.body = "revoked";
      if (fault === "delete") f.github.mockImplementation(async url => f.response(String(url), {}, 404));
      if (fault === "expire") f.setTime(f.pins.expiresAt);
      if (fault === "cancel") f.controller.abort();
    }
    return original(u, init);
  });
  expect((await f.start()).public.verdict).toBeNull(); expect(f.source).not.toHaveBeenCalled();
  expect(f.github.mock.calls.length).toBeLessThanOrEqual(4);
});
it.each(["revoke", "delete", "expire", "cancel", "throw"])("%s between metadata and attempt is terminal even though130 catches wrappers", async fault => {
  const f = actionsFixture(), original = f.source.getMockImplementation()!;
  f.source.mockImplementation(async (u, init) => {
    if (fault === "revoke") f.comment.body = "revoked";
    if (fault === "delete") f.github.mockImplementation(async url => f.response(String(url), {}, 404));
    if (fault === "expire") f.setTime(f.pins.expiresAt);
    if (fault === "cancel") f.controller.abort();
    if (fault === "throw") throw new Error(f.canary);
    return original(u, init);
  });
  expect((await f.start()).public.verdict).toBeNull(); expect(f.source).toHaveBeenCalledTimes(1);
});
it.each(["revoke", "expire", "cancel"])("%s after final source read withholds all acceptance and retains old failure", async fault => {
  const f = actionsFixture(), failure = await f.start(), original = f.source.getMockImplementation()!;
  f.run.conclusion = "success"; f.manifest.context.expected[0].attempt = 2; f.run.run_attempt = 2;
  f.manifest.tracked[0].expectation.attempt = 2;
  f.source.mockClear();
  f.source.mockImplementation(async (u, init) => {
    if (String(u).includes("/attempts/")) {
      if (fault === "revoke") f.comment.body = "revoked";
      if (fault === "expire") f.setTime(f.pins.expiresAt);
      if (fault === "cancel") f.controller.abort();
    }
    return original(u, init);
  });
  const bytes = encode(f.manifest), pins = { ...f.pins, sha256: hash(bytes) }; f.comment.body = actionsReadCommand(pins.sha256);
  const r = await createActionsReadSession(f.policy, pins, f.githubToken).observe(
    { manifest: bytes, commentId: 789, actionsReadToken: f.actionsReadToken, previous: failure.state }, f.io);
  expect(r.public.verdict).toBeNull(); expect(r.state?.workflowFailures).toHaveLength(1); expect(f.source).toHaveBeenCalledTimes(2);
});
it.each(["parse", "credentials", "worker-credentials", "worker-manifest", "auth", "read", "fsync"])("consumes delivery and session on %s; corrected replay cannot start network", async fault => {
  const f = setup();
  fs.unlinkSync(join(f.delivery, "manifest.json")); fs.unlinkSync(join(f.delivery, "credentials.json"));
  f.supply(fault === "parse" ? new TextEncoder().encode("{") : fault === "worker-manifest" ? encode({ purpose: "observer_reads" }) : f.bytes,
    fault === "worker-credentials" ? { schema: 1, githubToken: f.githubToken, snapshotToken: null } :
      fault === "credentials" ? { schema: 1, reviewAuthToken: f.githubToken, actionsReadToken: f.githubToken } :
        { schema: 1, reviewAuthToken: f.githubToken, actionsReadToken: f.actionsReadToken });
  if (fault === "auth") f.comment.body = "revoked";
  if (fault === "read") f.source.mockRejectedValue(new Error(f.canary));
  const io = fault === "fsync" ? { ...fs, fsyncSync() { throw new Error("offline_storage_uncertain"); } } : fs;
  await f.launch(io); expect(fs.readdirSync(f.delivery)).toEqual([]); expect(fs.readdirSync(f.journal)).toHaveLength(1);
  f.supply(); const calls = f.github.mock.calls.length;
  expect((await f.launch()).public.verdict).toBeNull(); expect(f.github).toHaveBeenCalledTimes(calls);
});
it.each(["digest", "nonce", "purpose"])("cannot reopen a Worker-spent session by changing %s", async fault => {
  const f = setup();
  await observePrivateFiles(f.input, { ...f.io, worker: f.worker }); // Worker path consumes then rejects Actions credentials.
  f.supply(); if (fault === "digest") f.input.pins.sha256 = "b".repeat(64);
  if (fault === "nonce") f.input.pins.nonce = "c".repeat(64);
  expect((await f.launch()).public.verdict).toBeNull(); expect(f.github).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(join(f.journal, fs.readdirSync(f.journal)[0]), "utf8")).purpose).toBe("observer_reads");
});
it.each(["cancel", "deadline", "expiry"])("disposes late verification stream on %s including126 clock race", async fault => {
  vi.useFakeTimers(); const f = actionsFixture(); let resolve!: (r: Response) => void, disposed = false;
  f.github.mockImplementation(() => new Promise(r => { resolve = r; }));
  const p = f.start();
  if (fault === "cancel") f.controller.abort();
  if (fault === "deadline") await vi.advanceTimersByTimeAsync(10_000);
  if (fault === "expiry") f.setTime(f.pins.expiresAt);
  resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
  expect((await p).public.verdict).toBeNull(); await Promise.resolve();
  expect(disposed).toBe(true); expect(f.github).toHaveBeenCalledTimes(1); expect(f.source).not.toHaveBeenCalled();
});
it("rejects the recognized Worker snapshot-token shape even with an Actions manifest", async () => {
  const f = actionsFixture();
  const r = await f.session().observe({ manifest: f.bytes, commentId: 789, actionsReadToken: f.snapshotToken }, f.io);
  expect(r.public.verdict).toBeNull(); expect(f.github).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled();
});
it("rejects reuse of review-auth credential as source token", async () => {
  const f = actionsFixture();
  expect((await f.session().observe({ manifest: f.bytes, commentId: 789, actionsReadToken: f.githubToken }, f.io)).public.verdict).toBeNull();
  expect(f.github).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled();
});
it.each(["repository", "stage", "candidate", "generation", "session", "nonce", "ready", "expiry", "identity", "head", "ref", "run", "attempt", "observation"])("unchanged byte digest rejects even otherwise valid changed %s", async fault => {
  const f = actionsFixture(), m = structuredClone(f.manifest);
  if (fault === "repository") m.repositoryId++;
  if (fault === "stage") m.stage = "prod";
  if (fault === "candidate") m.candidate = "b".repeat(40);
  if (fault === "generation") m.context.generation++;
  if (fault === "session") m.session = "b".repeat(64);
  if (fault === "nonce") m.nonce = "c".repeat(64);
  if (fault === "ready") m.readyAt--;
  if (fault === "expiry") m.expiresAt++;
  if (fault === "identity") m.tracked[0].identity = "d".repeat(64);
  if (fault === "head") m.tracked[0].expectation.head = "c".repeat(40);
  if (fault === "ref") m.tracked[0].ref = "refs/tags/plugin-v1.2.3";
  if (fault === "run") m.tracked[0].expectation.run++;
  if (fault === "attempt") m.tracked[0].expectation.attempt++;
  if (fault === "observation") m.observation++;
  const r = await f.session().observe({ manifest: encode(m), commentId: 789, actionsReadToken: f.actionsReadToken }, f.io);
  expect(r.public.verdict).toBeNull(); expect(f.github).not.toHaveBeenCalled(); expect(f.source).not.toHaveBeenCalled();
});
it.each(["bom", "utf8", "json", "oversize"])("consumes invalid private bytes %s before auth, with matching outer hash", async fault => {
  const f = setup(), bytes = fault === "bom" ? Buffer.concat([Buffer.from([239, 187, 191]), f.bytes]) :
    fault === "utf8" ? Buffer.from([255]) : fault === "json" ? Buffer.from("{") : Buffer.alloc(32769);
  fs.unlinkSync(join(f.delivery, "manifest.json")); fs.writeFileSync(join(f.delivery, "manifest.json"), bytes, { mode: 0o400 });
  f.input.pins.sha256 = hash(bytes); f.comment.body = actionsReadCommand(f.input.pins.sha256);
  expect((await f.launch()).public.verdict).toBeNull(); expect(f.github).not.toHaveBeenCalled();
  expect(fs.readdirSync(f.delivery)).toEqual([]); expect(fs.readdirSync(f.journal)).toHaveLength(1);
});
it.each(["url", "redirect", "cookie", "gzip", "type", "length", "truncated", "oversize", "chunks"])("refuses bounded review wire %s and disposes refused stream", async fault => {
  const f = actionsFixture(); let disposed = false, n = 0;
  f.github.mockImplementation(async u => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (fault === "cookie") headers["Set-Cookie"] = f.canary;
    if (fault === "gzip") headers["Content-Encoding"] = "gzip";
    if (fault === "type") headers["Content-Type"] = "text/html";
    if (fault === "length") headers["Content-Length"] = "32769";
    if (fault === "truncated") headers["Content-Length"] = "32768";
    const r = new Response(new ReadableStream({ pull(c) {
      if (fault === "oversize") { c.enqueue(new Uint8Array(32769)); return; }
      if (fault === "chunks") { c.enqueue(new Uint8Array()); return; }
      if (n++ === 0) c.enqueue(encode(f.comment)); else c.close();
    }, cancel() { disposed = true; } }), { headers });
    Object.defineProperty(r, "url", { value: fault === "url" ? "https://evil.invalid" : String(u) });
    if (fault === "redirect") Object.defineProperty(r, "redirected", { value: true });
    return r;
  });
  expect((await f.start()).public.verdict).toBeNull(); expect(f.source).not.toHaveBeenCalled();
  expect(f.github).toHaveBeenCalledTimes(1); if (fault !== "truncated") expect(disposed).toBe(true);
});
it("does not reset the total ten-second window between verifier and source", async () => {
  const f = actionsFixture(), started = f.io.now(), original = f.github.getMockImplementation()!;
  let n = 0;
  f.github.mockImplementation(async (u, init) => { f.setTime(started + ++n * 1000); return original(u, init); });
  expect((await f.start()).public.verdict).toBeNull();
  expect(f.github).toHaveBeenCalledTimes(10); expect(f.source).toHaveBeenCalledTimes(1);
});
it("maximum mixed tracked set costs 100 verification +23 source GETs", async () => {
  const f = actionsFixture(), m = f.manifest;
  m.context.expected = Array.from({ length: 20 }, (_, n) => ({ ...m.context.expected[0], run: f.run.id + n,
    workflow: (["deploy-worker.yml", "ci.yml", "release-plugin.yml"] as const)[n % 3], event: n % 3 === 1 ? "push" : "workflow_dispatch" }));
  m.tracked = m.context.expected.map((expectation, n) => ({ expectation, identity: n.toString(16).padStart(64, "0"), ref: "refs/heads/main" }));
  f.source.mockImplementation(async url => {
    const u = String(url), e = m.context.expected.find(e => u.endsWith(`/runs/${e.run}/attempts/1`));
    const w = m.context.expected.find(e => u.endsWith(`/workflows/${e.workflow}`));
    return f.response(u, w ? { ...f.workflow, path: `.github/workflows/${w.workflow}` } : { ...f.run, id: e!.run,
      event: e!.event, url: `${root}/actions/runs/${e!.run}` });
  });
  const bytes = encode(m), pins = { ...f.pins, sha256: hash(bytes) }; f.comment.body = actionsReadCommand(pins.sha256);
  const r = await createActionsReadSession(f.policy, pins, f.githubToken).observe(
    { manifest: bytes, commentId: 789, actionsReadToken: f.actionsReadToken }, f.io);
  expect(r.public.coverage).toBe("complete"); expect(incident(r)).toBe("incident");
  expect(f.github).toHaveBeenCalledTimes(100); expect(f.source).toHaveBeenCalledTimes(23); expect(r.reads).toHaveLength(20);
});
it("retains an exact positive failure after later source wrapper throws, with no accepted result or further calls", async () => {
  const f = actionsFixture(), m = f.manifest, e = { ...m.context.expected[0], run: f.run.id + 1 };
  m.context.expected = [...m.context.expected, e];
  m.tracked = [...m.tracked, { expectation: e, identity: "b".repeat(64), ref: "refs/heads/main" }];
  const bytes = encode(m), pins = { ...f.pins, sha256: hash(bytes) }; f.comment.body = actionsReadCommand(pins.sha256);
  const original = f.source.getMockImplementation()!;
  f.source.mockImplementation(async (u, init) => {
    if (String(u).includes(`/runs/${e.run}/`)) throw new Error(f.canary);
    return original(u, init);
  });
  const r = await createActionsReadSession(f.policy, pins, f.githubToken).observe(
    { manifest: bytes, commentId: 789, actionsReadToken: f.actionsReadToken }, f.io);
  expect(r.public.verdict).toBeNull(); expect(r.public.coverage).toBe("unknown");
  expect(r.state?.workflowFailures).toEqual([m.context.expected[0]]); expect(f.source).toHaveBeenCalledTimes(3);
  expect(f.github).toHaveBeenCalledTimes(16); // no final request after terminal wrapper failure
});
it("unavailable later HTTP keeps earlier historical failure visible through partial normalized output", async () => {
  const f = actionsFixture(), m = f.manifest, e = { ...m.context.expected[0], run: f.run.id + 1 };
  m.context.expected = [...m.context.expected, e];
  m.tracked = [...m.tracked, { expectation: e, identity: "b".repeat(64), ref: "refs/heads/main" }];
  const bytes = encode(m), pins = { ...f.pins, sha256: hash(bytes) }; f.comment.body = actionsReadCommand(pins.sha256);
  const original = f.source.getMockImplementation()!;
  f.source.mockImplementation(async (u, init) => String(u).includes(`/runs/${e.run}/`) ? f.response(String(u), {}, 404) : original(u, init));
  const r = await createActionsReadSession(f.policy, pins, f.githubToken).observe(
    { manifest: bytes, commentId: 789, actionsReadToken: f.actionsReadToken }, f.io);
  expect(r.public.coverage).toBe("partial"); expect(incident(r)).toBe("incident"); expect(r.state?.workflowFailures).toHaveLength(1);
});
it("recognizes old and new journal records without deleting evidence; old Worker schema stays exclusive", async () => {
  const f = setup(); await f.launch(); const entries = fs.readdirSync(f.journal);
  // Distinct new slot chosen locally; both purpose records remain recognizable.
  let n = 0;
  do { f.input.pins.session = (++n).toString(16).padStart(64, "0"); }
  while (entries.includes(hash(Buffer.from(f.input.pins.session)).slice(0, 2)));
  f.supply(); await observePrivateFiles(f.input, { ...f.io, worker: f.worker });
  expect(fs.readdirSync(f.journal)).toHaveLength(2);
  const records = fs.readdirSync(f.journal).map(p => JSON.parse(fs.readFileSync(join(f.journal, p), "utf8")));
  expect(records.map(r => r.purpose).sort()).toEqual(["observer_actions_reads", "observer_reads"]);
  expect(f.worker).not.toHaveBeenCalled();
});
it("rejects coercible permission arrays rather than treating them as authority", async () => {
  const f = actionsFixture(), original = f.github.getMockImplementation()!;
  f.github.mockImplementation(async (u, init) => String(u).includes("/permission") ? f.response(String(u),
    { permission: ["write"], user: f.comment.user }) : original(u, init));
  expect((await f.start()).public.verdict).toBeNull(); expect(f.source).not.toHaveBeenCalled();
});
it("malformed new-purpose journal entry blocks instead of coercing its purpose", async () => {
  const f = setup(); await f.launch();
  const path = join(f.journal, fs.readdirSync(f.journal)[0]), record = JSON.parse(fs.readFileSync(path, "utf8"));
  record.purpose = ["observer_actions_reads"]; fs.writeFileSync(path, JSON.stringify(record));
  let n = 0;
  do { f.input.pins.session = (++n).toString(16).padStart(64, "0"); }
  while (hash(Buffer.from(f.input.pins.session)).slice(0, 2) === path.split("/").pop());
  f.supply(); const calls = f.github.mock.calls.length;
  expect((await f.launch()).public.verdict).toBeNull(); expect(f.github).toHaveBeenCalledTimes(calls);
  expect(fs.readdirSync(f.journal)).toHaveLength(1); expect(JSON.parse(fs.readFileSync(path, "utf8")).purpose).toEqual(["observer_actions_reads"]);
});
it.each(["cancel", "deadline", "expiry"])("disposes late composed source stream on %s, no final verification dispatch", async fault => {
  vi.useFakeTimers(); const f = actionsFixture(); let resolve!: (r: Response) => void, disposed = false;
  f.source.mockImplementation(() => new Promise(r => { resolve = r; }));
  const p = f.start();
  // Drive the bounded initial + per-source fake review until source dispatch.
  for (let n = 0; n < 300 && f.source.mock.calls.length === 0; n++) await Promise.resolve();
  expect(f.source).toHaveBeenCalledTimes(1); const calls = f.github.mock.calls.length;
  if (fault === "cancel") f.controller.abort();
  if (fault === "deadline") await vi.advanceTimersByTimeAsync(10_000);
  if (fault === "expiry") f.setTime(f.pins.expiresAt);
  resolve(new Response(new ReadableStream({ cancel() { disposed = true; } })));
  expect((await p).public.verdict).toBeNull();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(disposed).toBe(true); expect(f.source).toHaveBeenCalledTimes(1); expect(f.github).toHaveBeenCalledTimes(calls);
});
it("copies manifest bytes, policy, tokens and transport functions before asynchronous authentication", async () => {
  const f = actionsFixture(), policy = structuredClone(f.policy), pins = structuredClone(f.pins), bytes = f.bytes.slice();
  let resolve!: (r: Response) => void;
  const original = f.github.getMockImplementation()!;
  f.github.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const session = createActionsReadSession(policy, pins, f.githubToken);
  const request = { manifest: bytes, commentId: 789, actionsReadToken: f.actionsReadToken };
  const p = session.observe(request, f.io);
  bytes.fill(0); policy.approvers.vvaz = 999; pins.session = "a".repeat(64); request.actionsReadToken = "changed";
  const source = f.source; f.io.source = vi.fn();
  resolve(await original(`${root}/issues/comments/789`));
  expect(incident(await p)).toBe("incident"); expect(source).toHaveBeenCalledTimes(2); expect(f.io.source).not.toHaveBeenCalled();
});

it("retains a validated first failure when cancellation wins while the next source request never settles", async () => {
  const f = actionsFixture();
  const first = f.manifest.tracked[0];
  const second = { ...first, identity: "c".repeat(64), expectation: { ...first.expectation, run: first.expectation.run + 1 } };
  const manifest = { ...f.manifest, context: { ...f.manifest.context, expected: [first.expectation, second.expectation] }, tracked: [first, second] };
  const bytes = encode(manifest), pins = { ...f.pins, sha256: hash(bytes) };
  f.comment.body = actionsReadCommand(pins.sha256);
  f.source.mockImplementation(async url => {
    if (String(url).includes("/workflows/")) return f.response(String(url), f.workflow);
    if (String(url).includes(`/runs/${first.expectation.run}/`)) return f.response(String(url), f.run);
    f.controller.abort();
    return new Promise<Response>(() => {});
  });
  const session = createActionsReadSession(f.policy, pins, f.githubToken);
  const result = await session.observe({ manifest: bytes, commentId: 789, actionsReadToken: f.actionsReadToken }, f.io);
  expect(f.source).toHaveBeenCalledTimes(3);
  expect(result.public).toEqual({ coverage: "unknown", verdict: null });
  expect(result.state?.workflowFailures).toEqual([first.expectation]);
  expect(result.state?.cells[4].active).toBe(true);
  const calls = f.github.mock.calls.length;
  await session.observe({ manifest: bytes, commentId: 789, actionsReadToken: f.actionsReadToken }, f.io);
  expect(f.github).toHaveBeenCalledTimes(calls); expect(f.source).toHaveBeenCalledTimes(3);
});
