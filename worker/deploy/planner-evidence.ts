import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openSync, closeSync, fstatSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { encodeState } from "alchemy/State/StateEncoding";
import * as Effect from "effect/Effect";
import type { StateService } from "alchemy/State/State";
import { requireEvidence, STACK } from "./planning-state.ts";

// Integrity observations, NOT a backend revision/CAS/ABA proof.
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const git = (repo: string, args: string[]) => execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", ...args], {
  cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
});
export function sourceEvidence(repo: string, head?: string) {
  if (head) {
    const workflow = readFileSync(join(repo, ".github/workflows/deploy-worker.yml"), "utf8").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    requireEvidence(["if: github.ref == 'refs/heads/main'", 'environment: ${{ inputs.stage }}', 'group: deploy-worker-${{ inputs.stage }}', 'cancel-in-progress: false',
      'node --import ./deploy/planning-loader.mjs deploy/planning-entry.ts'].every((required) => workflow.includes(required)) &&
      !/alchemy (?:deploy|plan)|workflow_run:|upload-artifact/.test(workflow));
    requireEvidence(git(repo, ["rev-parse", "HEAD"]).trim() === head);
    requireEvidence(git(repo, ["status", "--porcelain", "--untracked-files=normal"]).trim() === "");
  }
  const files = git(repo, ["ls-files", "-z"]).split("\0").filter((file) => file.startsWith("worker/") || file.startsWith("scripts/ci/") ||
    file.startsWith(".github/workflows/") || ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "plugin/composer.lock"].includes(file)).sort();
  const rows = files.map((file): [string, string] => {
    requireEvidence(!lstatSync(join(repo, file)).isSymbolicLink());
    return [file, createHash("sha256").update(readFileSync(join(repo, file))).digest("hex")];
  });
  return Object.freeze({ manifest: rows, source: digest(rows), lockfiles: digest(rows.filter(([file]) => /lock|package.json|pnpm-workspace/.test(file))),
    migrations: digest(rows.filter(([file]) => /migrations\//.test(file))) });
}
export async function snapshotInput(snapshot: StateService) {
  const target = { stack: STACK, stage: "prod" };
  const rows: Record<string, unknown> = {};
  for (const fqn of [...await Effect.runPromise(snapshot.list(target))].sort()) rows[fqn] = encodeState(await Effect.runPromise(snapshot.get({ ...target, fqn })));
  const output = encodeState(await Effect.runPromise(snapshot.getOutput(target)));
  return { rows: { [STACK]: { prod: rows } }, output: { [STACK]: { prod: output } } };
}
export interface OwnerWindow {
  readonly id: string;
  readonly startsAt: number;
  readonly expiresAt: number;
  // Reviewed source metadata: owner has excluded local operators, other repos,
  // scheduled automation, state endpoint deployments and credential holders.
  // Runtime cannot establish that external fact. Approval binds this duty.
  readonly duty: "exclude-every-state-writer-and-endpoint-deployer";
}
export function exclusiveLocalWindow(path: string, window: OwnerWindow, now = Date.now) {
  window = structuredClone(window);
  requireEvidence(/^[a-f0-9]{64}$/.test(window.id) && window.duty === "exclude-every-state-writer-and-endpoint-deployer" &&
    window.startsAt <= now() && now() < window.expiresAt && window.expiresAt - window.startsAt <= 20 * 60_000);
  // Fixed owner-controlled path on the protected runner, shared with every
  // local authorized entry. Existing/stale lock refuses; never steal a lease.
  const fd = openSync(path, "wx", 0o600);
  const original = fstatSync(fd);
  let closed = false;
  const check = () => {
    const current = lstatSync(path);
    requireEvidence(!closed && !current.isSymbolicLink() && current.ino === original.ino && current.dev === original.dev &&
      current.uid === process.getuid?.() && (current.mode & 0o777) === 0o600 && now() >= window.startsAt && now() < window.expiresAt);
  };
  return { binding: digest(window), check, close: () => {
    if (closed) return;
    try { check(); unlinkSync(path); } finally { closed = true; closeSync(fd); }
  } };
}
