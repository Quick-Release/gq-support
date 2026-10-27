import { createHash, randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { decodeBatch, evaluate, type Context, type Read } from "./protocol.ts";
import { validateSnapshotReview, type SnapshotReviewCustody } from "./snapshot-evidence.ts";

const M = 60_000, now = 120 * M, candidate = "a".repeat(40);
const deployment = "11111111-1111-1111-1111-111111111111", version = "22222222-2222-2222-2222-222222222222";
const c: Context = { now, account: "8f38791a8c37b182239af2a385ab3c31", stage: "staging", candidate,
  generation: 1, activation: 0, expected: [], exclusions: [] };
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const manifest = () => ({ schema: 1, proof: "reviewed_business_activation", account: c.account, stage: c.stage,
  candidate, deployment, version, generation: 1, activatedAt: 0, validFrom: now - 5 * M, validTo: now + M,
  issued: now, evidenceObserved: now, reviewer: "vvaz" as const, record: randomBytes(32).toString("hex"),
  notification: "disabled", exclusions: [], snapshotSha256: createHash("sha256").update(encode(wire())).digest("hex"), observation: 1, readAt: now });
const custody = (value: ReturnType<typeof manifest>, bytes = encode(value)): SnapshotReviewCustody => ({
  account: c.account, stage: c.stage, candidate, deployment, version, generation: 1,
  reviewer: value.reviewer, record: value.record, sha256: createHash("sha256").update(bytes).digest("hex"),
});
const wire = () => ({ version: 1, generated: now, stage: c.stage, candidate, generation: 1, maintenance: "open",
  watermark: now, partial: false, activation: null, coverage: "unknown", route: "disabled", ticks: [] });
const read = (value = wire()): Read => ({ source: "snapshot", observed: 1, at: now, from: now - 60 * M, to: now,
  account: c.account, stage: c.stage, candidate, generation: 1, status: "ok", coverage: "complete", pages: 1,
  deployment, version, body: encode(value) });
const claims = (context: Context, r: Read, review?: unknown) => {
  const p = decodeBatch(context, [r], review).evidence[0]?.payload;
  return p && "claims" in p ? p.claims : undefined;
};
it("fresh actual wire without independently reviewed activation remains unknown", () => {
  expect(claims(c, read())).toMatchObject({ activation: "unknown", records: null, continuity: "unknown" });
});
it("permits only bounded missing RECORD evidence and reviewed disabled expectation, never Cron health/nonexecution", () => {
  const m = manifest(), review = validateSnapshotReview(encode(m), custody(m), now);
  const batch = decodeBatch(c, [read()], validateSnapshotReview(encode(m), custody(m), now));
  expect(claims(c, read(), review)).toEqual({ activation: "reviewed_external_input", continuity: "unknown",
    records: { proof: "coherent_ring_read", from: now - 5 * M, to: now,
      missing: Array.from({ length: 5 }, (_, i) => now - (5 - i) * M) }, notification: "reviewed_disabled" });
  const result = evaluate(c, batch);
  expect(result.public.classes[2].verdict).toBe("unknown");
  expect(result.public.classes[3].verdict).toBe("unknown");
  expect(JSON.stringify(result.public)).not.toContain(m.record);
  expect(JSON.stringify(result.public)).not.toContain(deployment);
  expect(encode(result.public).byteLength).toBeLessThanOrEqual(2048);
  expect(claims(c, read(), review)).toMatchObject({ activation: "unknown", records: null });
  expect(claims(c, read(), structuredClone(review))).toMatchObject({ activation: "unknown", records: null });
});
it.each([
  ["future issue", { issued: now + 1 }], ["future evidence", { evidenceObserved: now + 1 }],
  ["stale evidence", { evidenceObserved: now - 3 * M }], ["expired", { validTo: now }],
  ["future validity", { validFrom: now + 1 }], ["wide validity", { validFrom: now - 60 * M }],
  ["activation after validity", { activatedAt: now }], ["provider timestamp as activation", { proof: "deployment_created" }],
  ["wrong actor", { reviewer: "operator" }], ["wrong account", { account: "0".repeat(32) }],
  ["wrong candidate", { candidate: "b".repeat(40) }], ["wrong stage", { stage: "prod" }],
  ["wrong generation", { generation: 2 }], ["rollback deployment", { deployment: version }],
  ["rollback version", { version: deployment }], ["operator boolean", { approved: true }],
  ["raw record URL", { record: "https://private.invalid/record" }],
  ["extra private data", { private: `gqcanary_${randomBytes(16).toString("hex")}` }],
])("rejects %s", (_name, change) => {
  const m = manifest(), changed = encode({ ...m, ...change });
  const binding = { ...custody(m), sha256: createHash("sha256").update(changed).digest("hex") };
  expect(() => validateSnapshotReview(changed, binding, now)).toThrow("invalid_snapshot_review");
});
it("rejects digest mismatch, malformed/oversized bytes and fabricated custody", () => {
  const m = manifest(), binding = custody(m);
  for (const bytes of [encode({ ...m, notification: "enabled" }), encode({}), new Uint8Array(8193), new Uint8Array([255])])
    expect(() => validateSnapshotReview(bytes, binding, now)).toThrow("invalid_snapshot_review");
  expect(() => validateSnapshotReview(encode(m), { ...binding, approved: true } as SnapshotReviewCustody, now)).toThrow("invalid_snapshot_review");
});
it("bounds and binds exclusions without using them to hide absent records or authorize recovery", () => {
  const m = manifest(), exclusion = { from: now - 4 * M, to: now - 3 * M, generation: 1, reason: "maintenance" };
  const value = { ...m, exclusions: [exclusion] }, bytes = encode(value);
  const binding = { ...custody(m), sha256: createHash("sha256").update(bytes).digest("hex") };
  expect(claims(c, read(), validateSnapshotReview(bytes, binding, now))?.activation).toBe("unknown");
  const review = validateSnapshotReview(bytes, binding, now);
  const context = { ...c, exclusions: [{ from: exclusion.from, to: exclusion.to, generation: 1 }] };
  expect(claims(context, read(), review)?.records?.missing).toHaveLength(5);
  for (const exclusions of [[{ ...exclusion, reason: "operator" }], [{ ...exclusion, generation: 0 }],
    [exclusion, exclusion], [{ ...exclusion, to: now + 2 * M }], Array.from({ length: 61 }, () => exclusion)]) {
    const invalid = encode({ ...m, exclusions });
    expect(() => validateSnapshotReview(invalid, { ...custody(m), sha256: createHash("sha256").update(invalid).digest("hex") }, now)).toThrow("invalid_snapshot_review");
  }
});
it.each(["partial", "unknown", "timeout", "deployment", "version", "generation", "candidate", "activation", "stale", "expired", "observation", "readAt", "race"])("%s cannot grant record coverage", kind => {
  const m = manifest(), review = validateSnapshotReview(encode(m), custody(m), now);
  const r = read(), context = { ...c };
  if (kind === "partial") r.body = encode({ ...wire(), partial: true });
  if (kind === "unknown") r.coverage = "unknown";
  if (kind === "timeout") r.status = "unavailable";
  if (kind === "deployment") r.deployment = version;
  if (kind === "version") r.version = deployment;
  if (kind === "generation") context.generation++;
  if (kind === "candidate") context.candidate = "b".repeat(40);
  if (kind === "activation") context.activation = 1;
  if (kind === "stale") context.now += 3 * M;
  if (kind === "expired") context.now += M;
  if (kind === "observation") r.observed++;
  if (kind === "readAt") r.at--;
  if (kind === "race") r.body = encode({ ...wire(), watermark: now - M });
  expect(claims(context, r, review)?.records ?? null).toBeNull();
  expect(evaluate(context, decodeBatch(context, [r], review)).public.classes[3].verdict).not.toBe("clear");
});
it("refuses to forge disabled expectation from enabled reviewed mode or from the wire alone", () => {
  const m = { ...manifest(), notification: "enabled" }, bytes = encode(m);
  const review = validateSnapshotReview(bytes, custody(m, bytes), now);
  expect(claims(c, read(), review)?.notification).toBe("unknown");
  expect(claims(c, read())?.notification).toBe("unknown");
});

it("a correctly bound sticky-partial read still cannot grant record coverage", () => {
  const r = read({ ...wire(), partial: true }), m = { ...manifest(), snapshotSha256: createHash("sha256").update(r.body).digest("hex") };
  const review = validateSnapshotReview(encode(m), custody(m), now);
  expect(claims(c, r, review)).toMatchObject({ activation: "reviewed_external_input", records: null, continuity: "unknown" });
});

it.each(["json", "utf8", "wire", "oversize", "status", "context", "batch"])("consumes snapshot capability before %s rejection", (fault) => {
  const m = manifest(), cap = validateSnapshotReview(encode(m), custody(m), now);
  const r = read(), context = { ...c };
  if (fault === "json") r.body = new TextEncoder().encode("{");
  if (fault === "utf8") r.body = new Uint8Array([255]);
  if (fault === "wire") r.body = encode({ ...wire(), version: 2 });
  if (fault === "oversize") r.body = new Uint8Array(65537);
  if (fault === "status") r.status = "unavailable";
  if (fault === "context") context.activation = now + 1;
  const reads = fault === "batch" ? Array.from({ length: 33 }, () => r) : [r];
  expect(decodeBatch(context, reads, cap).invalid).toBe(true);
  expect(claims(c, read(), cap)).toMatchObject({ activation: "unknown", records: null });
});
it("does not transfer failed snapshot authority to a later read in the same batch", () => {
  const m = manifest(), cap = validateSnapshotReview(encode(m), custody(m), now);
  const batch = decodeBatch(c, [{ ...read(), body: new TextEncoder().encode("{") }, read()], cap);
  const second = batch.evidence[1]?.payload;
  expect(second && "claims" in second ? second.claims : null).toMatchObject({ activation: "unknown", records: null });
});
