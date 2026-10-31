import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPOSITORY, type ReleaseEvidence, type WorkflowRun } from "../src/release-gates.ts";

/** Runs `gh` with arguments, never a shell; null when it fails, times out or answers too much. */
export type Gh = (args: readonly string[]) => string | null;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const ARTIFACT = /^[A-Za-z0-9._-]{1,128}$/;
const FILE = /^[A-Za-z0-9._-]{1,64}\.json$/;

/** The GitHub CLI with the Operator's own login. Stderr is discarded: it can carry account details. */
export const ghCommand = (): Gh => (args) => {
  const result = spawnSync("gh", args, { shell: false, stdio: ["ignore", "pipe", "ignore"], timeout: 60_000, killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" });
  return result.error || result.status !== 0 ? null : result.stdout;
};

const parse = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };

/**
 * GitHub's own workflow run records for release gates (src/release-gates.ts),
 * read by the Operator CLI with the Operator's `gh` login: a run with its
 * latest attempt's jobs, and a JSON file from one of its retained artifacts.
 * Nothing typed by the Operator stands in for them.
 */
export const githubEvidence = (gh: Gh = ghCommand(), scratch = tmpdir()): ReleaseEvidence => ({
  async run(id) {
    if (!RUN_ID.test(id)) return null;
    const run = parse(gh(["api", `repos/${REPOSITORY}/actions/runs/${id}`])) as Record<string, unknown> | null;
    const jobs = parse(gh(["api", `repos/${REPOSITORY}/actions/runs/${id}/jobs?filter=latest&per_page=100`])) as { jobs?: unknown } | null;
    if (!run || !Array.isArray(jobs?.jobs)) return null;
    const repository = (run.repository as { full_name?: unknown } | undefined)?.full_name;
    return { id: Number(run.id), path: String(run.path ?? ""), repository: String(repository ?? ""), head_sha: String(run.head_sha ?? ""),
      head_branch: typeof run.head_branch === "string" ? run.head_branch : null, event: String(run.event ?? ""), status: String(run.status ?? ""),
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null, html_url: String(run.html_url ?? ""),
      jobs: (jobs.jobs as Record<string, unknown>[]).map((job) => ({ name: String(job.name ?? ""),
        conclusion: typeof job.conclusion === "string" ? job.conclusion : null })) } satisfies WorkflowRun;
  },
  async artifact(id, prefix, file) {
    if (!RUN_ID.test(id) || !FILE.test(file)) return null;
    const listed = parse(gh(["api", `repos/${REPOSITORY}/actions/runs/${id}/artifacts?per_page=100`])) as { artifacts?: unknown } | null;
    const names = (Array.isArray(listed?.artifacts) ? listed.artifacts as Record<string, unknown>[] : [])
      .filter((artifact) => artifact.expired === false && typeof artifact.name === "string" && artifact.name.startsWith(prefix) && ARTIFACT.test(artifact.name))
      .map((artifact) => artifact.name as string).sort();
    // The last attempt's retained record, as the deploy job read it.
    const name = names.at(-1);
    if (!name) return null;
    const directory = mkdtempSync(join(scratch, "gq-support-evidence-"));
    try {
      if (gh(["run", "download", id, "--repo", REPOSITORY, "--name", name, "--dir", directory]) === null) return null;
      return parse(readFileSync(join(directory, file), "utf8"));
    } catch {
      return null;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
});
