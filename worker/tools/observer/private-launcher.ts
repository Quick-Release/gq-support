// Trusted Linux launcher library. Never import into a child/provider/RPC.
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { exact, finiteInt, release } from "../../src/observer-snapshot.ts";
import type { ApprovalPolicy } from "../../deploy/github-candidate-approval.ts";
import { createObserverReadSession, type ReadSessionPins, type ObserverReviewIO } from "./review-loader.ts";
import type { State } from "./protocol.ts";

function refuse(): never { throw new Error("observer_private_refused"); }
const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const fdpath = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
const flags = fs.constants;
const slots = 256, limit = 2048;
// Injection is trusted launcher code, never private manifest configuration. It
// models real open/write/fsync failure boundaries; there is no approval flag.
export type CustodyFS = Pick<typeof fs, "openSync" | "closeSync" | "fsyncSync" | "unlinkSync" | "opendirSync"> & {
  fstatSync: (fd: number) => fs.Stats;
  statfsSync: (path: string) => fs.StatsFs;
  readSync: (fd: number, bytes: Uint8Array, offset: number, length: number, position: null) => number;
  writeSync: (fd: number, bytes: Uint8Array, offset: number, length: number, position: null) => number;
};
function directory(path: string, io: CustodyFS): number {
  if (process.platform !== "linux" || !isAbsolute(path) || path === "/" ||
    path.split("/").slice(1).some(x => !x || x === "." || x === "..")) refuse();
  const uid = process.getuid!();
  if (process.geteuid!() !== uid) refuse();
  let fd = io.openSync("/", flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW);
  try {
    for (const part of path.split("/").slice(1)) {
      const next = io.openSync(fdpath(fd, part), flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW);
      // Track the new descriptor before closing the predecessor: close may
      // throw after releasing it, so cleanup must not retry that ambiguous fd.
      const predecessor = fd; fd = next;
      io.closeSync(predecessor);
      const s = io.fstatSync(fd);
      if (!s.isDirectory() || ![0, uid].includes(s.uid) || (s.mode & 0o022) !== 0) refuse();
    }
    const s = io.fstatSync(fd);
    if (s.uid !== uid || (s.mode & 0o7777) !== 0o700) refuse();
    return fd;
  } catch { io.closeSync(fd); return refuse(); }
}
function regular(fd: number, mode: number, max: number, io: CustodyFS) {
  const s = io.fstatSync(fd);
  if (!s.isFile() || s.uid !== process.getuid!() || (s.mode & 0o7777) !== mode || s.nlink !== 1 ||
    s.size < 1 || s.size > max) refuse();
  return s;
}
function read(fd: number, max: number, mode: number, io: CustodyFS): Uint8Array {
  const before = regular(fd, mode, max, io), bytes = new Uint8Array(before.size + 1);
  let size = 0, n: number;
  do { n = io.readSync(fd, bytes, size, bytes.length - size, null); size += n; } while (n && size < bytes.length);
  const after = regular(fd, mode, max, io);
  if (size !== before.size || before.ino !== after.ino || before.dev !== after.dev ||
    before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) refuse();
  return bytes.slice(0, size);
}
function parse(bytes: Uint8Array): unknown {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}
function pins(value: ReadSessionPins): ReadSessionPins {
  const p = structuredClone(value);
  exact(p, ["stage", "candidate", "session", "nonce", "readyAt", "expiresAt", "sha256"]);
  if (!["prod", "staging"].includes(p.stage)) refuse();
  release(p.candidate);
  for (const v of [p.session, p.nonce, p.sha256]) if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) refuse();
  finiteInt(p.readyAt); finiteInt(p.expiresAt);
  if (p.expiresAt <= p.readyAt || p.expiresAt - p.readyAt > 300_000) refuse();
  return p;
}
type ReadPurpose = "observer_reads" | "observer_actions_reads";
function evidence(p: ReadSessionPins, purpose: ReadPurpose) {
  return { schema: 1, purpose, ...p, status: "spent" };
}
/** Fixed 256 permanent slots. Collisions/exhaustion block, never evict. The slot
 * depends only on session: altered digest/nonce/purpose cannot reopen a session.
 * No outcome update: even failed/unknown/crashed reads remain spent. */
function claim(fd: number, p: ReadSessionPins, purpose: ReadPurpose, io: CustodyFS) {
  // Linux local implementations only. Type is a refusal filter, never proof of
  // persistent backing, fsync semantics, backup integrity or all-runner exclusion.
  if (![0xef53, 0x58465342, 0x9123683e, 0x794c7630].includes(Number(io.statfsSync(fdpath(fd, ".")).type))) refuse();
  const names: string[] = [];
  const listing = io.opendirSync(fdpath(fd, "."));
  try {
    let entry;
    while ((entry = listing.readSync()) !== null) {
      if (names.length >= slots) refuse();
      names.push(entry.name);
    }
  } finally { listing.closeSync(); }
  if (names.length >= slots) refuse();
  for (const name of names) {
    if (!/^[a-f0-9]{2}$/.test(name)) refuse();
    const entry = io.openSync(fdpath(fd, name), flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK);
    try {
      const v = exact(parse(read(entry, limit, 0o600, io)),
        ["schema", "purpose", "stage", "candidate", "session", "nonce", "readyAt", "expiresAt", "sha256", "status"]);
      const { schema, purpose, status, ...rest } = v;
      const prior = pins(rest as unknown as ReadSessionPins);
      if (schema !== 1 || (purpose !== "observer_reads" && purpose !== "observer_actions_reads") || status !== "spent" || hash(prior.session).slice(0, 2) !== name) refuse();
    } finally { io.closeSync(entry); }
  }
  const entry = io.openSync(fdpath(fd, hash(p.session).slice(0, 2)),
    flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(evidence(p, purpose)));
    if (bytes.length > limit) refuse();
    let offset = 0;
    while (offset < bytes.length) {
      const n = io.writeSync(entry, bytes, offset, bytes.length - offset, null);
      if (n <= 0) refuse();
      offset += n;
    }
    regular(entry, 0o600, limit, io);
    io.fsyncSync(entry);
    io.fsyncSync(fd); // BOTH durable barriers precede even the first GitHub GET.
  } finally { io.closeSync(entry); } // never unlink, including ambiguous fsync.
}
export interface PrivateLaunch {
  deliveryDirectory: string; journalDirectory: string;
  pins: ReadSessionPins; policy: Pick<ApprovalPolicy, "approvers">;
  commentId: number; previous?: State;
}
/** Files are consumed synchronously before parsing/authentication/await. Only
 * finite public output escapes; #122 carry stays caller-owned private memory.
 * Parent must attest storage domain/durability and target independently. This
 * function cannot establish those facts and is deliberately not an enabled CLI. * Shared descriptor delivery, never authentication. Purpose is code-selected. */
export function consumePrivateDelivery(input: Pick<PrivateLaunch, "deliveryDirectory" | "journalDirectory" | "pins">,
  purpose: ReadPurpose, io: CustodyFS = fs) {
  const descriptors: number[] = [];
  try {
    const p = structuredClone(input.pins);
    const delivery = directory(input.deliveryDirectory, io); descriptors.push(delivery);
    const journal = directory(input.journalDirectory, io); descriptors.push(journal);
    const a = io.fstatSync(delivery), b = io.fstatSync(journal);
    if (a.dev === b.dev && a.ino === b.ino) refuse();
    const opened: number[] = [];
    let manifest: Uint8Array | undefined, credentials: Uint8Array | undefined;
    // Consume both names even when the other file fails validation/open/read.
    let failed = false;
    for (const [name, max] of [["manifest.json", 32_768], ["credentials.json", 8192]] as const) {
      try {
        const fd = io.openSync(fdpath(delivery, name), flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK);
        opened.push(fd); descriptors.push(fd);
        const bytes = read(fd, max, 0o400, io);
        if (name === "manifest.json") manifest = bytes; else credentials = bytes;
      } catch { failed = true; }
      finally { try { io.unlinkSync(fdpath(delivery, name)); } catch { failed = true; } }
    }
    // Invalid delivery still spends the independently supplied session; malformed
    // JSON/UTF8/auth never permits a corrected retry with these pins.
    pins(p);
    claim(journal, p, purpose, io);
    io.fsyncSync(delivery);
    if (failed || opened.length !== 2 || !manifest || !credentials || hash(manifest) !== p.sha256) refuse();
    // Release consumed inodes before any parsing/auth/await; only our byte copies
    // remain. This is unlink/close custody, not secure storage erasure.
    while (descriptors.length) io.closeSync(descriptors.pop()!);
    return { manifest, credentials, pins: p };
  } finally { for (const fd of descriptors.reverse()) { try { io.closeSync(fd); } catch { /* fixed output */ } } }
}
export async function observePrivateFiles(input: PrivateLaunch, transport: ObserverReviewIO, io: CustodyFS = fs) {
  try {
    const policy = structuredClone(input.policy), commentId = input.commentId;
    const previous = input.previous === undefined ? undefined : structuredClone(input.previous);
    const network = { ...transport };
    const { manifest, credentials, pins: p } = consumePrivateDelivery(input, "observer_reads", io);
    const c = exact(parse(credentials), ["schema", "githubToken", "snapshotToken"]);
    parse(manifest); // encoding/JSON before authenticated review; exact schema remains #127's.
    if (c.schema !== 1 || typeof c.githubToken !== "string" || !/^[!-~]{1,4096}$/.test(c.githubToken) ||
      !(c.snapshotToken === null || (typeof c.snapshotToken === "string" && /^[a-f0-9]{64}$/.test(c.snapshotToken))) ||
      c.githubToken === c.snapshotToken) refuse();
    const session = createObserverReadSession(policy, p, c.githubToken);
    return await session.observe({ manifest, commentId, previous,
      snapshotToken: c.snapshotToken === null ? undefined : c.snapshotToken as string }, network);
  } catch { return { public: { readiness: "unknown" as const, snapshot: "unavailable" as const,
    review: "unknown" as const, continuity: "unknown" as const, verdict: null } }; }
}
