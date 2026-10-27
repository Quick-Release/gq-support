import { createHash, randomBytes } from "node:crypto";
import { vi } from "vitest";
import { createObserverReadSession, observerReadCommand } from "./review-loader.ts";

const root = "https://api.github.com/repos/Quick-Release/gq-support";
const now = Date.UTC(2026, 8, 16, 12), head = "a".repeat(40);
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const canary = () => `gqcanary_${randomBytes(24).toString("hex")}`;
export function fixture() {
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
