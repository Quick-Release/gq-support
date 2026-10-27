// Linux-only, one-shot, offline execution. No network fallback on other hosts.
// Trusted launcher/source/dependencies/kernel/bwrap; not a malicious-code sandbox.
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseIdentity } from "./native-plan-policy.ts";
import type { verifyApp } from "./github-app.ts";
import { refusal, requireEvidence } from "./planning-state.ts";
import { MAX_BODY, checkWire } from "./planning-read.ts";

export interface ConfinedPlanInput {
  readonly databases: readonly DatabaseIdentity[];
  readonly rows: unknown;
  readonly output: unknown;
}
export interface ConfinedPlanSummary {
  readonly status: "planned";
  readonly resources: Readonly<Record<"SupportDB" | "SupportLedger" | "Worker" | "GitHubAppSecret", "noop" | "update" | "create">>;
}

// preflight must be the trusted adapter invoking verifyApp with its isolated
// GitHub-only transport and validateWebhookSecrets, never a user assertion.
// This is a local execution primitive, NOT approval or a production entry.
export async function runConfinedPlan(repo: string, input: ConfinedPlanInput,
  preflight: () => Promise<Awaited<ReturnType<typeof verifyApp>>>,
): Promise<ConfinedPlanSummary> {
  try {
    checkWire(input);
    requireEvidence(Object.keys(input).sort().join() === "databases,output,rows");
    const verified = await preflight();
    const app = { stage: verified.stage, appId: verified.appId, slug: verified.slug, clientId: verified.clientId, fingerprint: verified.fingerprint };
    const summary = JSON.parse(await runOfflineModule(repo, "deploy/confined-planning-child.ts", { ...input, app })) as ConfinedPlanSummary;
    requireEvidence(summary.status === "planned" && Object.keys(summary).sort().join() === "resources,status" &&
      Object.keys(summary.resources).sort().join() === "GitHubAppSecret,SupportDB,SupportLedger,Worker" &&
      Object.values(summary.resources).every((action) => ["noop", "update", "create"].includes(action)) &&
      ["noop", "update"].includes(summary.resources.SupportDB) && ["noop", "update"].includes(summary.resources.SupportLedger));
    return Object.freeze({ status: "planned", resources: Object.freeze({ ...summary.resources }) });
  } catch { throw refusal(); }
}

// Internal runtime primitive, also exercised by syscall canaries. Entry is
// trusted source, never a caller-supplied CLI/HTTP parameter.
export async function runOfflineModule(repo: string, entry: string, input: unknown): Promise<string> {
  let scratch: string | undefined;
  let result: string | undefined;
  let failed = false;
  try {
    requireEvidence(process.platform === "linux" && /^(deploy|test\/fixtures)\/[A-Za-z0-9-]+\.(ts|mjs)$/.test(entry));
    checkWire(input);
    const payload = JSON.stringify(input);
    requireEvidence(Buffer.byteLength(payload) <= MAX_BODY);
    scratch = mkdtempSync(join(tmpdir(), "gq-planning-"));
    const root = join(scratch, "source"); mkdirSync(root);
    repo = realpathSync(repo);
    // Copy tracked source only. Never mount the checkout, .git, dotenv,
    // profiles, the credential files or the launcher's home into the child.
    const tracked = execFileSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "ls-files", "-z"], { cwd: repo, encoding: "utf8", env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] }).split("\0").filter(Boolean);
    for (const file of tracked.filter((file) => file.startsWith("worker/") || ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file))) {
      requireEvidence(!file.split("/").some((part) => part === ".git" || part === ".alchemy" || part.startsWith(".env") || part.startsWith(".dev.vars")) && !lstatSync(join(repo, file)).isSymbolicLink());
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(join(repo, file), join(root, file));
    }
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, "worker/node_modules"));
    result = await executeOffline(repo, root, entry, payload);
  } catch { failed = true; }
  finally {
    try { if (scratch) rmSync(scratch, { recursive: true, force: true }); } catch { failed = true; }
  }
  requireEvidence(!failed && result !== undefined);
  return result;
}

async function executeOffline(repo: string, source: string, entry: string, payload: string): Promise<string> {
  const node = realpathSync(process.execPath);
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", dirname(node), "/runtime", "--ro-bind", source, "/workspace",
    "--ro-bind", resolve(repo, "node_modules"), "/workspace/node_modules",
    "--ro-bind", resolve(repo, "worker/node_modules"), "/workspace/worker/node_modules",
    "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev", "--chdir", "/workspace/worker",
    "--setenv", "HOME", "/tmp/home", "--setenv", "PATH", "/runtime:/usr/bin",
    "--", "/runtime/node", "--disable-warning=ExperimentalWarning", "--import", "./deploy/planning-loader.mjs", entry];
  const child = spawnSync("/usr/bin/bwrap", args, { env: {}, input: payload, stdio: ["pipe", "ignore", "ignore", "pipe"], timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 });
  requireEvidence(!child.error && child.status === 0);
  requireEvidence(child.output[3] && child.output[3].length <= 1024);
  return String(child.output[3]);
}
