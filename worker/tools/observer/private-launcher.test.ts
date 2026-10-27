import * as fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./private-fixture.ts";
import { observePrivateFiles, type CustodyFS } from "./private-launcher.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function setup() {
  const f = fixture(), root = fs.mkdtempSync(join(homedir(), ".gq-offline-")); roots.push(root);
  fs.chmodSync(root, 0o700);
  const delivery = join(root, "delivery"), journal = join(root, "journal");
  fs.mkdirSync(delivery, { mode: 0o700 }); fs.mkdirSync(journal, { mode: 0o700 });
  const input = { deliveryDirectory: delivery, journalDirectory: journal, policy: f.policy,
    pins: { ...f.pins, sha256: createHash("sha256").update(f.bytes).digest("hex") }, commentId: 789 };
  const supply = () => {
    fs.writeFileSync(join(delivery, "manifest.json"), f.bytes, { mode: 0o400 });
    fs.writeFileSync(join(delivery, "credentials.json"), JSON.stringify({ schema: 1,
      githubToken: f.githubToken, snapshotToken: f.snapshotToken }), { mode: 0o400 });
  };
  supply();
  return { ...f, root, delivery, journal, input, supply,
    run: (io: CustodyFS = fs) => observePrivateFiles(input, f.io, io) };
}
function spent(journal: string) { return fs.readdirSync(journal); }
it("composes actual127/126 with fake HTTP after both durable barriers, consumes files and bounds public output", async () => {
  const f = setup(), order: string[] = [];
  const io = { ...fs, fsyncSync(fd: number) { fs.fsyncSync(fd); order.push(fs.fstatSync(fd).isDirectory() ? "dir" : "file"); } };
  const original = f.github.getMockImplementation()!;
  f.github.mockImplementation(async (u, init) => {
    expect(order).toEqual(["file", "dir", "dir"]);
    expect(fs.readdirSync(f.delivery)).toEqual([]);
    return original(u, init);
  });
  const result = await f.run(io);
  expect(result.public.snapshot).toBe("accepted"); expect(f.worker).toHaveBeenCalledTimes(2);
  expect(result.public.continuity).toBe("unknown");
  const record = fs.readFileSync(join(f.journal, spent(f.journal)[0]), "utf8");
  for (const value of [f.githubToken, f.snapshotToken, f.manifest.target.origin, JSON.stringify(f.manifest)]) {
    expect(JSON.stringify(result)).not.toContain(value); expect(record).not.toContain(value);
  }
  f.supply(); const calls = f.github.mock.calls.length;
  expect((await f.run()).public.verdict).toBeNull(); expect(f.github).toHaveBeenCalledTimes(calls);
});
it.each(["parse", "utf8", "bom", "size", "empty", "mode", "special-mode", "hardlink", "symlink", "directory", "inode", "owner", "mutation"])("consumes and refuses delivery %s, no network or corrected replay", async fault => {
  const f = setup(), path = join(f.delivery, "manifest.json"); let io: CustodyFS = fs;
  fs.unlinkSync(path);
  const bytes = fault === "utf8" ? Buffer.from([255]) : fault === "bom" ? Buffer.from('\ufeff{}') :
    fault === "size" ? Buffer.alloc(32769) : fault === "empty" ? Buffer.alloc(0) : fault === "parse" ? Buffer.from("{") : f.bytes;
  fs.writeFileSync(path, bytes, { mode: fault === "mode" ? 0o600 : 0o400 });
  if (fault === "special-mode") fs.chmodSync(path, 0o4400);
  if (fault === "mutation") io = { ...fs, readSync(...args) {
    const n = fs.readSync(...args);
    fs.chmodSync(path, 0o600); fs.writeFileSync(path, Buffer.alloc(f.bytes.length)); fs.chmodSync(path, 0o400);
    return n;
  } };
  if (fault === "hardlink") fs.linkSync(path, join(f.root, "link"));
  if (fault === "symlink") { fs.unlinkSync(path); fs.symlinkSync(join(f.root, "absent"), path); }
  if (fault === "directory") { fs.unlinkSync(path); fs.mkdirSync(path); }
  // Real descriptor read; inject metadata changes at the actual post-read fstat
  // boundary, without requiring root/chown privileges in the offline suite.
  if (fault === "inode" || fault === "owner") {
    let seen = 0;
    io = { ...fs, fstatSync(fd: number) {
      const s = fs.fstatSync(fd);
      if (s.isFile() && ++seen === (fault === "inode" ? 2 : 1)) {
        if (fault === "inode") s.ino++; else s.uid++;
      }
      return s;
    } } as CustodyFS;
  }
  expect((await f.run(io)).public.verdict).toBeNull(); expect(f.github).not.toHaveBeenCalled();
  expect(spent(f.journal)).toHaveLength(1);
  if (fault === "directory") fs.rmdirSync(path);
  expect(fs.existsSync(path)).toBe(false); expect(fs.existsSync(join(f.delivery, "credentials.json"))).toBe(false);
  f.supply(); await f.run(); expect(f.github).not.toHaveBeenCalled();
});
it.each(["auth", "read", "credentials", "digest", "stage", "nonce", "session", "candidate", "purpose", "expiry"])("keeps %s failure spent across new launcher invocations", async fault => {
  const f = setup();
  if (fault === "auth") f.comment.user.id++;
  if (fault === "read") f.worker.mockImplementation(async () => { throw new Error(f.githubToken); });
  if (fault === "credentials") {
    const p = join(f.delivery, "credentials.json"); fs.chmodSync(p, 0o600); fs.writeFileSync(p, "{"); fs.chmodSync(p, 0o400);
  }
  if (fault === "expiry") f.setTime(f.pins.expiresAt);
  if (["digest", "stage", "nonce", "session", "candidate", "purpose"].includes(fault)) {
    const m = { ...f.manifest };
    if (fault === "stage") m.stage = "prod" as "staging";
    if (fault === "session") m.session = "b".repeat(64);
    if (fault === "candidate") m.candidate = "b".repeat(40);
    if (fault === "nonce") m.nonce = "b".repeat(64);
    if (fault === "purpose") Object.assign(m, { purpose: "send" });
    const p = join(f.delivery, "manifest.json"); fs.chmodSync(p, 0o600);
    fs.writeFileSync(p, JSON.stringify(m) + (fault === "digest" ? " " : "")); fs.chmodSync(p, 0o400);
    if (fault !== "digest") f.input.pins.sha256 = createHash("sha256").update(JSON.stringify(m)).digest("hex");
  }
  const r = await f.run(); expect(r.public.snapshot).not.toBe("accepted");
  const calls = f.github.mock.calls.length; f.supply(); await f.run(); expect(f.github).toHaveBeenCalledTimes(calls);
  expect(spent(f.journal)).toHaveLength(1);
});
it.each(["claim-open", "claim-write", "claim-fsync", "directory-fsync", "delivery-fsync", "delivery-open", "delivery-read"])("fails closed at real %s boundary", async fault => {
  const f = setup(); let syncs = 0;
  const io: CustodyFS = { ...fs,
    openSync(p, flags, mode) {
      if ((fault === "claim-open" && typeof flags === "number" && (flags & fs.constants.O_EXCL)) ||
        (fault === "delivery-open" && String(p).endsWith("manifest.json"))) throw new Error(f.githubToken);
      return fs.openSync(p, flags, mode);
    },
    readSync(...args: Parameters<CustodyFS["readSync"]>) {
      if (fault === "delivery-read") throw new Error(f.githubToken);
      return fs.readSync(...args);
    },
    writeSync(...args: Parameters<CustodyFS["writeSync"]>) {
      if (fault === "claim-write") throw new Error(f.githubToken);
      return fs.writeSync(...args);
    },
    fsyncSync(fd) {
      syncs++;
      if (syncs === ({ "claim-fsync": 1, "directory-fsync": 2, "delivery-fsync": 3 }[fault] ?? -1)) throw new Error(f.githubToken);
      fs.fsyncSync(fd);
    },
  } as CustodyFS;
  const result = await f.run(io); expect(result.public.verdict).toBeNull(); expect(f.github).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain(f.githubToken);
  if (fault !== "claim-open") {
    expect(spent(f.journal)).toHaveLength(1); f.supply(); await f.run(); expect(f.github).not.toHaveBeenCalled();
  }
});
it.each(["ancestor-mode", "ancestor-symlink", "journal-mode", "same-directory", "corrupt", "extra", "filesystem", "full"])("refuses %s custody without HTTP", async fault => {
  const f = setup(); let io: CustodyFS = fs;
  if (fault === "ancestor-mode") fs.chmodSync(f.root, 0o770);
  if (fault === "ancestor-symlink") { const p = join(f.root, "alias"); fs.symlinkSync(f.delivery, p); f.input.deliveryDirectory = p; }
  if (fault === "same-directory") f.input.journalDirectory = f.delivery;
  if (fault === "journal-mode") fs.chmodSync(f.journal, 0o755);
  if (fault === "corrupt" || fault === "extra") fs.writeFileSync(join(f.journal, fault === "extra" ? "unknown" : "00"), "{", { mode: 0o600 });
  if (fault === "filesystem") io = { ...fs, statfsSync: p => ({ ...fs.statfsSync(p), type: 0x6969 }) } as CustodyFS;
  if (fault === "full") for (let n = 0; n < 256; n++) fs.writeFileSync(join(f.journal, n.toString(16).padStart(2, "0")), "{", { mode: 0o600 });
  expect((await f.run(io)).public.verdict).toBeNull(); expect(f.github).not.toHaveBeenCalled();
});
it("seals mutable pins, policy, carry and IO before awaiting fake HTTP", async () => {
  const f = setup(); let resume!: () => void;
  const original = f.github.getMockImplementation()!;
  f.github.mockImplementationOnce(async (u, init) => { await new Promise<void>(r => { resume = r; }); return original(u, init); });
  const run = f.run(); f.bytes.fill(0); f.input.pins.nonce = "b".repeat(64); f.policy.approvers.vvaz++;
  f.io.github = vi.fn(async () => { throw new Error(f.githubToken); });
  resume(); expect((await run).public.snapshot).toBe("accepted"); expect(f.io.github).not.toHaveBeenCalled();
});

// Children receive fake test pins/paths only; no credential argument or IPC.
function child(f: ReturnType<typeof setup>, delivery: string, phase: string) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const c = spawn(process.execPath, [join(import.meta.dirname, "private-process.ts"), delivery, f.journal,
      JSON.stringify(f.input.pins), phase], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
    let output = ""; c.stdout.on("data", b => { output += String(b); }); c.stderr.on("data", b => { output += String(b); });
    EventEmitter.prototype.on.call(c, "error", reject);
    EventEmitter.prototype.on.call(c, "close", (code: number | null) => resolve({ code, output }));
  });
}
it.each(["before-fsync", "after-claim", "before-dispatch", "after-read"])("real process crash %s retains refusal after restart", async phase => {
  const f = setup();
  const first = await child(f, f.delivery, phase); expect(first.code).toBe(77); expect(first.output).toBe("");
  expect(spent(f.journal)).toHaveLength(1); f.supply();
  const second = await child(f, f.delivery, "normal"); expect(second.code).toBe(0); expect(second.output).toBe("blocked\n");
});
it("multiple actual processes contend on one exclusive slot; restarts and changed pins never reopen it", async () => {
  const f = setup(), deliveries: string[] = [];
  for (let n = 0; n < 6; n++) {
    const d = join(f.root, `d${n}`); fs.mkdirSync(d, { mode: 0o700 }); deliveries.push(d);
    for (const name of ["manifest.json", "credentials.json"]) fs.copyFileSync(join(f.delivery, name), join(d, name));
  }
  const results = await Promise.all(deliveries.map(d => child(f, d, "normal")));
  expect(results.every(r => r.code === 0)).toBe(true);
  expect(results.filter(r => r.output === "dispatched\n")).toHaveLength(1);
  expect(results.filter(r => r.output === "blocked\n")).toHaveLength(5);
  f.input.pins.nonce = "c".repeat(64); f.input.pins.sha256 = "d".repeat(64);
  expect((await child(f, f.delivery, "normal")).output).toBe("blocked\n");
  for (const r of results) expect(r.output).not.toMatch(/gqcanary_|Bearer|workers\.dev/);
});

it("permanent hash-slot collision blocks a distinct session without deleting either record", async () => {
  const f = setup(); await f.run();
  const slot = spent(f.journal)[0];
  let session: string;
  for (let n = 0; ; n++) {
    session = n.toString(16).padStart(64, "0");
    if (createHash("sha256").update(session).digest("hex").slice(0, 2) === slot && session !== f.input.pins.session) break;
  }
  f.input.pins.session = session;
  const before = fs.readFileSync(join(f.journal, slot));
  f.supply(); const calls = f.github.mock.calls.length;
  await f.run(); expect(f.github).toHaveBeenCalledTimes(calls);
  expect(fs.readFileSync(join(f.journal, slot))).toEqual(before);
});

it("tracks each opened directory before predecessor close can fail, without ambiguous-close retry", async () => {
  const f = setup();
  const owned = new Set<number>();
  let retries = 0;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      let closedOnce = false;
      const io: CustodyFS = { ...fs,
        openSync(...args) { const fd = fs.openSync(...args); owned.add(fd); return fd; },
        closeSync(fd) {
          if (!owned.delete(fd)) { retries++; throw new Error("ambiguous descriptor retried"); }
          fs.closeSync(fd);
          if (!closedOnce) { closedOnce = true; throw new Error("closed predecessor then failed"); }
        },
      };
      expect((await f.run(io)).public.verdict).toBeNull();
      expect(owned.size).toBe(0);
    }
    expect(retries).toBe(0);
    expect(f.github).not.toHaveBeenCalled(); expect(f.worker).not.toHaveBeenCalled();
  } finally { for (const fd of owned) fs.closeSync(fd); }
});
