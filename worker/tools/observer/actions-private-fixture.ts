import { createHash, randomBytes } from "node:crypto";
import { vi } from "vitest";
import { fixture } from "./private-fixture.ts";
import { actionsReadCommand, createActionsReadSession, type PrivateActionsManifest } from "./actions-review-loader.ts";
export const root = "https://api.github.com/repos/Quick-Release/gq-support";
export const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
export const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
export function actionsFixture() {
  const f = fixture(), canary = `gqcanary_${randomBytes(24).toString("hex")}`;
  const expectation = { repo: "Quick-Release/gq-support" as const, workflow: "deploy-worker.yml" as const,
    event: "workflow_dispatch" as const, run: 30433642, attempt: 1, head: f.pins.candidate,
    stage: f.pins.stage, candidate: f.pins.candidate };
  const manifest: PrivateActionsManifest = { schema: 1, purpose: "observer_actions_reads", ...f.pins,
    repositoryId: 1296269, context: { ...f.manifest.context, expected: [expectation] },
    tracked: [{ identity: randomBytes(32).toString("hex"), expectation, ref: "refs/heads/main" }], observation: 1 };
  const bytes = encode(manifest), pins = { ...f.pins, sha256: hash(bytes) };
  f.comment.body = actionsReadCommand(pins.sha256);
  const workflow = { id: 159038, path: ".github/workflows/deploy-worker.yml", state: "disabled_manually", url: `${root}/actions/workflows/159038` };
  const repository = { id: manifest.repositoryId, full_name: "Quick-Release/gq-support", url: root };
  const now = f.io.now(), iso = (n: number) => new Date(n).toISOString();
  const run = { id: expectation.run, run_attempt: 1, workflow_id: workflow.id, workflow_url: workflow.url,
    url: `${root}/actions/runs/${expectation.run}`, event: expectation.event, head_sha: expectation.head, head_branch: "main",
    repository, head_repository: repository, status: "completed", conclusion: "failure", created_at: iso(now - 3 * 86_400_000),
    updated_at: iso(now - 2 * 86_400_000), run_started_at: iso(now - 3 * 86_400_000 + 1000), name: canary };
  const source = vi.fn<typeof fetch>(async url => f.response(String(url), String(url).includes("/workflows/") ? workflow : run));
  const io = { github: f.github, source, now: f.io.now, signal: f.controller.signal };
  const actionsReadToken = `gqcanary_${randomBytes(24).toString("hex")}`;
  const session = () => createActionsReadSession(f.policy, pins, f.githubToken);
  const start = () => session().observe({ manifest: bytes, commentId: 789, actionsReadToken }, io);
  return { ...f, manifest, bytes, pins, workflow, run, canary, actionsReadToken, io, source, session, start };
}
