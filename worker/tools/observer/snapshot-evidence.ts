import { createHash } from "node:crypto";
import { exact, finiteInt, enumValue, release, type ObserverSnapshot } from "../../src/observer-snapshot.ts";
import type { Context, Read } from "./protocol.ts";

const M = 60_000, account = "8f38791a8c37b182239af2a385ab3c31";
const refuse = (): never => { throw new Error("invalid_snapshot_review"); };
const digest = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) return refuse();
  return v;
};
const identity = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)) return refuse();
  return v;
};
interface Pins {
  account: string; stage: "staging" | "prod"; candidate: string; deployment: string; version: string; generation: number;
}
interface Exclusion { from: number; to: number; generation: number; reason: "maintenance" | "restore" | "rollback" }
interface Manifest extends Pins {
  schema: 1; proof: "reviewed_business_activation";
  activatedAt: number; validFrom: number; validTo: number; issued: number; evidenceObserved: number;
  reviewer: "vvaz" | "gmarques"; record: string; snapshotSha256: string; observation: number; readAt: number; notification: "enabled" | "disabled"; exclusions: Exclusion[];
}
/** Supplied OUTSIDE the response/manifest by a private authenticated review loader.
 * The digest is integrity, not authentication. That loader must independently
 * authenticate the actor/record, actual business activation, current deployment,
 * single version, generation, notification mode and exclusion authorization.
 * review-loader.ts authenticates approval of private bytes; independent live
 * attestation collection/validation is still not implemented. */
export interface SnapshotReviewCustody extends Pins {
  sha256: string; reviewer: "vvaz" | "gmarques"; record: string;
}
// Same-process capability only. Not JSON, persisted authority, or operator approval.
const reviewed = new WeakMap<object, Readonly<Manifest>>();
export interface SnapshotReview { readonly kind: "private_snapshot_review" }
export function validateSnapshotReview(bytes: Uint8Array, custody: SnapshotReviewCustody, now: number): SnapshotReview {
  try {
    finiteInt(now);
    exact(custody, ["account", "stage", "candidate", "deployment", "version", "generation", "sha256", "reviewer", "record"]);
    if (bytes.byteLength > 8192 || createHash("sha256").update(bytes).digest("hex") !== digest(custody.sha256)) refuse();
    const o = exact(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)), ["schema", "proof", "account", "stage", "candidate", "deployment", "version", "generation", "activatedAt", "validFrom", "validTo", "issued", "evidenceObserved", "reviewer", "record", "notification", "exclusions", "snapshotSha256", "observation", "readAt"]);
    if (o.schema !== 1 || o.proof !== "reviewed_business_activation" || o.account !== account) refuse();
    const stage = enumValue(o.stage, ["staging", "prod"]), candidate = release(o.candidate);
    const deployment = identity(o.deployment), version = identity(o.version), generation = finiteInt(o.generation);
    const reviewer = enumValue(o.reviewer, ["vvaz", "gmarques"]), record = digest(o.record);
    for (const key of ["account", "stage", "candidate", "deployment", "version", "generation", "reviewer", "record"] as const)
      if (o[key] !== custody[key]) refuse();
    const activatedAt = finiteInt(o.activatedAt), validFrom = finiteInt(o.validFrom), validTo = finiteInt(o.validTo);
    const issued = finiteInt(o.issued, now), evidenceObserved = finiteInt(o.evidenceObserved, issued);
    if (activatedAt > validFrom || validFrom > evidenceObserved || evidenceObserved < now - 2 * M ||
      issued < validFrom || now < validFrom || now >= validTo || validTo - validFrom > 60 * M) refuse();
    if (!Array.isArray(o.exclusions) || o.exclusions.length > 60) refuse();
    let end = validFrom;
    const exclusions = (o.exclusions as unknown[]).map(value => {
      const x = exact(value, ["from", "to", "generation", "reason"]);
      const from = finiteInt(x.from), to = finiteInt(x.to);
      if (from < end || from >= to || to > validTo || x.generation !== generation) refuse();
      end = to;
      return { from, to, generation, reason: enumValue(x.reason, ["maintenance", "restore", "rollback"]) };
    });
    const snapshotSha256 = digest(o.snapshotSha256), observation = finiteInt(o.observation), readAt = finiteInt(o.readAt, issued);
    if (readAt < evidenceObserved || readAt < now - 2 * M) refuse();
    const manifest: Manifest = { schema: 1, proof: "reviewed_business_activation", account, stage, candidate,
      deployment, version, generation, reviewer, record, snapshotSha256, observation, readAt, activatedAt, validFrom, validTo, issued, evidenceObserved,
      notification: enumValue(o.notification, ["enabled", "disabled"]), exclusions };
    const capability: SnapshotReview = Object.freeze({ kind: "private_snapshot_review" });
    reviewed.set(capability, manifest);
    return capability;
  } catch { return refuse(); }
}
/** Move authority out of the caller's capability before any decode can fail.
 * The replacement stays internal to that one snapshot attempt. */
export function consumeSnapshotReview(capability: unknown): SnapshotReview | undefined {
  if (!capability || typeof capability !== "object") return undefined;
  const manifest = reviewed.get(capability);
  reviewed.delete(capability);
  if (!manifest) return undefined;
  const attempt: SnapshotReview = Object.freeze({ kind: "private_snapshot_review" });
  reviewed.set(attempt, manifest);
  return attempt;
}
/** Private assessment only. Complete SQL read proves absence of RECORDS within
 * explicit bounds, never successful heartbeat writes or Cron nonexecution. */
export interface SnapshotClaims {
  activation: "reviewed_external_input" | "unknown";
  records: { proof: "coherent_ring_read"; from: number; to: number; missing: readonly number[] } | null;
  continuity: "unknown";
  notification: "reviewed_disabled" | "unknown";
}
export function assessSnapshot(wire: ObserverSnapshot, c: Context, r: Read, capability?: unknown): SnapshotClaims {
  const unknown: SnapshotClaims = { activation: "unknown", records: null, continuity: "unknown", notification: "unknown" };
  const m = capability && typeof capability === "object" ? reviewed.get(capability) : undefined;
  if (capability && typeof capability === "object") reviewed.delete(capability); // one observation, one consumption
  if (!m || r.observed !== m.observation || r.at !== m.readAt ||
    createHash("sha256").update(r.body).digest("hex") !== m.snapshotSha256 || m.account !== c.account || m.stage !== c.stage || m.candidate !== c.candidate || m.generation !== c.generation ||
    m.activatedAt !== c.activation || r.deployment !== m.deployment || r.version !== m.version ||
    c.now < m.validFrom || c.now >= m.validTo || m.evidenceObserved < c.now - 2 * M ||
    r.at < m.validFrom || r.at >= m.validTo || r.at < c.now - 2 * M || r.at > c.now ||
    wire.generated < m.validFrom || wire.generated < c.now - 2 * M ||
    wire.stage !== m.stage || wire.candidate !== m.candidate || wire.generation !== m.generation ||
    (c.exclusions.length !== m.exclusions.length || c.exclusions.some((x, i) =>
      x.from !== m.exclusions[i].from || x.to !== m.exclusions[i].to || x.generation !== m.exclusions[i].generation))) return unknown;
  const result: SnapshotClaims = { ...unknown, activation: "reviewed_external_input",
    notification: m.notification === "disabled" && wire.route === "disabled" ? "reviewed_disabled" : "unknown" };
  if (r.status !== "ok" || r.coverage !== "complete" || wire.partial) return result;
  const from = Math.ceil(Math.max(r.from, m.validFrom, m.activatedAt, wire.watermark - 59 * M, wire.generated - 60 * M) / M) * M;
  const to = Math.floor(Math.min(r.to, m.validTo, wire.generated) / M) * M;
  if (from >= to || to - from > 60 * M) return result;
  const missing = Array.from({ length: (to - from) / M }, (_, i) => from + i * M)
    .filter(slot => !wire.ticks.some(t => t[1] === m.candidate && t[2] === m.generation && t[3] === slot));
  return { ...result, records: { proof: "coherent_ring_read", from, to, missing } };
}
