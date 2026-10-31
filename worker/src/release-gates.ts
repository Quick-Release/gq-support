import type { DeployedStage } from "./repository-mappings.ts";

/**
 * Release gates (#144, docs/support-operations-design.md#release-and-compatibility-procedure).
 * A release reaches the fleet only on evidence GitHub itself recorded: the
 * workflow runs that built, tested and deployed it, read by the Operator CLI
 * with the Operator's own GitHub access. Nothing here is a typed-in result or a
 * free-form proof string, and every run must be at the exact commit the
 * candidate record names: a passing run of other code proves nothing.
 *
 * - `package` and `compatibility`: the release workflow run that built and
 *   verified the candidate's bytes (named by the candidate's own provenance),
 *   including its installed-package cells and pre-release compatibility tiers.
 * - `security`, `privacy` and `performance`: CI on `main` at the release commit:
 *   secret scan, dependency audit, PHP standards and static analysis, the Worker
 *   suite with its privacy tests, required validation and the asset size gate.
 * - `staging`: the gated staging deployment of the candidate's Worker commit.
 * - `infrastructure` (at launch, src/fleet-rollout.ts): the gated deployment of
 *   that Worker commit to the launching stage, with its safe protected-resource plan.
 *
 * A deployment's plan digest covers the protected resources' identities and
 * planned actions at that commit (worker/deploy/plan-gate.ts), not every
 * configuration value or secret: the recorded evidence says no more than that.
 */
export interface WorkflowJob { readonly name: string; readonly conclusion: string | null }
export interface WorkflowRun {
  readonly id: number;
  /** The workflow file, such as `.github/workflows/ci.yml`. */
  readonly path: string;
  readonly repository: string;
  readonly head_sha: string;
  readonly head_branch: string | null;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly jobs: readonly WorkflowJob[];
}

/** GitHub's own records, read with the Operator's access; tests use a controlled provider. */
export interface ReleaseEvidence {
  /** A workflow run with its jobs, or null if there is none. */
  run(id: string): Promise<WorkflowRun | null>;
  /** A JSON file from the run's retained artifact whose name starts with `prefix`, or null. */
  artifact(id: string, prefix: string, file: string): Promise<unknown>;
}

export const REPOSITORY = "Quick-Release/gq-support";
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const COMMIT = /^[a-f0-9]{40}$/;

/** A gate's required run shape: its workflow and the jobs that must all have passed. */
export interface RunRule { readonly workflow: string; readonly jobs: readonly RegExp[]; readonly branch?: string; readonly event?: string }
const RELEASE_RUN = ".github/workflows/release-plugin.yml";
const CI_RUN = ".github/workflows/ci.yml";
const DEPLOY_RUN = ".github/workflows/deploy-worker.yml";
const GATES = {
  package: { workflow: RELEASE_RUN, jobs: [/^Build the release candidate$/] },
  compatibility: { workflow: RELEASE_RUN, jobs: [/^Installed package /, /^Pre-release compatibility/] },
  security: { workflow: CI_RUN, branch: "main", event: "push", jobs: [/^Secret scan$/, /^Dependency audit$/, /^PHPCS \+ PHPStan$/] },
  privacy: { workflow: CI_RUN, branch: "main", event: "push", jobs: [/^Worker typecheck \+ tests$/, /^Required validation$/] },
  performance: { workflow: CI_RUN, branch: "main", event: "push", jobs: [/^Asset size gate$/] },
} as const satisfies Record<string, RunRule>;
export type ReleaseGate = keyof typeof GATES | "staging" | "infrastructure" | "recovery";
const INFRASTRUCTURE: RunRule = { workflow: DEPLOY_RUN, branch: "main", event: "workflow_dispatch", jobs: [/^plan$/, /^deploy$/] };

/** One gate's evidence as recorded: GitHub's run identity and the jobs it checked. */
export interface RunEvidence { readonly run: number; readonly workflow: string; readonly commit: string; readonly url: string; readonly jobs: readonly string[] }

/** Why a run does not satisfy a rule, or its evidence. */
export const checkRun = (run: WorkflowRun | null, rule: RunRule, commit: string): RunEvidence | string => {
  if (!run) return "no such workflow run";
  if (run.repository !== REPOSITORY || run.path !== rule.workflow) return `not a ${rule.workflow} run of ${REPOSITORY}`;
  if (run.head_sha !== commit) return `ran at ${run.head_sha}, not ${commit}`;
  if ((rule.branch && run.head_branch !== rule.branch) || (rule.event && run.event !== rule.event)) return `not a ${rule.event} run on ${rule.branch}`;
  if (run.status !== "completed" || run.conclusion !== "success") return `concluded ${run.conclusion ?? run.status}, not success`;
  const checked: string[] = [];
  for (const pattern of rule.jobs) {
    const matching = run.jobs.filter((job) => pattern.test(job.name));
    if (matching.length === 0) return `has no job matching ${pattern.source}`;
    const failed = matching.find((job) => job.conclusion !== "success");
    if (failed) return `job "${failed.name}" concluded ${failed.conclusion ?? "unfinished"}`;
    checked.push(...matching.map((job) => job.name));
  }
  return { run: run.id, workflow: rule.workflow, commit, url: run.html_url, jobs: checked };
};

/** A gated deployment's own records: what it planned and applied, and nothing it does not prove. */
export interface DeploymentEvidence extends RunEvidence {
  readonly stage: DeployedStage;
  readonly plan_digest: string;
  readonly applied_at: string;
  /** What the plan digest covers (worker/deploy/plan-gate.ts). */
  readonly covers: "protected resource identities and planned actions at this commit";
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The gated deployment of `commit` to `stage` in run `id`: a safe plan, applied by that run. */
export const deploymentEvidence = async (evidence: ReleaseEvidence, id: string, stage: DeployedStage, commit: string):
  Promise<DeploymentEvidence | string> => {
  if (!RUN_ID.test(id)) return "invalid run ID";
  const checked = checkRun(await evidence.run(id), INFRASTRUCTURE, commit);
  if (typeof checked === "string") return checked;
  const prefix = `deploy-plan-${stage}-${id}-`;
  const [plan, applied] = (await Promise.all([evidence.artifact(id, prefix, "plan.json"), evidence.artifact(id, prefix, "applied.json")])).map(object);
  if (!plan || !applied) return `has no retained ${stage} plan and apply record`;
  const provenance = object(applied.provenance);
  if (plan.schema !== "gq-support.deploy-plan/v1" || plan.verdict !== "safe" || plan.stage !== stage || plan.commit !== commit ||
    typeof plan.digest !== "string" || !/^[a-f0-9]{64}$/.test(plan.digest)) return `its retained plan is not a safe ${stage} plan of ${commit}`;
  if (applied.schema !== "gq-support.deploy-applied/v1" || applied.outcome !== "applied" || applied.stage !== stage || applied.commit !== commit ||
    applied.planDigest !== plan.digest || provenance?.runId !== id || typeof applied.appliedAt !== "string") {
    return `did not apply that plan to ${stage}`;
  }
  return { ...checked, stage, plan_digest: plan.digest, applied_at: applied.appliedAt,
    covers: "protected resource identities and planned actions at this commit" };
};

/** Refused: the gates that failed, each with why. Nothing was recorded. */
export class GateRefusal extends Error {
  constructor(readonly failures: Readonly<Partial<Record<ReleaseGate, string>>>) {
    super(`Release gates not passed; nothing was recorded: ${Object.entries(failures).map(([gate, why]) => `${gate}: ${why}`).join("; ")}`);
  }
}

/** The release run and commit a candidate's provenance names (src/release-operator.ts). */
export const provenanceOf = (provenance: string) => {
  const match = /^release-plugin run ([1-9][0-9]{0,19}) at ([a-f0-9]{40})$/.exec(provenance);
  return match ? { run: match[1]!, commit: match[2]! } : null;
};

/**
 * Every pre-approval gate of one candidate, from the runs GitHub recorded: the
 * candidate's own release run, CI at its release commit and the staging
 * deployment of its Worker commit. All pass, or GateRefusal lists every failure.
 */
export const verifyReleaseGates = async (evidence: ReleaseEvidence,
  candidate: { readonly provenance: string; readonly worker_commit: string }, runs: { readonly ci: string; readonly staging: string }) => {
  const origin = provenanceOf(candidate.provenance);
  if (!origin || !COMMIT.test(candidate.worker_commit)) throw new GateRefusal({ package: "the candidate's provenance names no release run and commit" });
  if (!RUN_ID.test(runs.ci) || !RUN_ID.test(runs.staging)) throw new GateRefusal({ security: "invalid run ID" });
  const [release, ci] = await Promise.all([evidence.run(origin.run), evidence.run(runs.ci)]);
  const failures: Partial<Record<ReleaseGate, string>> = {};
  const passed: Partial<Record<ReleaseGate, RunEvidence>> = {};
  for (const [gate, rule] of Object.entries(GATES) as [keyof typeof GATES, RunRule][]) {
    const result = checkRun(rule.workflow === RELEASE_RUN ? release : ci, rule, origin.commit);
    if (typeof result === "string") failures[gate] = result; else passed[gate] = result;
  }
  const staging = await deploymentEvidence(evidence, runs.staging, "staging", candidate.worker_commit);
  if (typeof staging === "string") failures.staging = staging; else passed.staging = staging;
  if (Object.keys(failures).length > 0) throw new GateRefusal(failures);
  return passed as Record<keyof typeof GATES | "staging", RunEvidence>;
};
