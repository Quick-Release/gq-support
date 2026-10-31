import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDurableStage } from "../src/support-db-config.ts";

/** The Tipme account (AGENTS.md). Durable stages deploy nowhere else. */
export const TIPME_ACCOUNT_ID = "8f38791a8c37b182239af2a385ab3c31";
const STACK = "GQSupportWorker";
const SCHEMA = "gq-support.deploy-plan/v1";

/** One resource row of an Alchemy plan, with the attributes Alchemy holds for it in state. */
export interface PlannedRow {
  readonly fqn: string;
  readonly logicalId: string;
  readonly type: string;
  readonly action: string;
  readonly attributes?: Readonly<Record<string, unknown>> | undefined;
}

export interface StackPlan {
  readonly stack: string;
  readonly stage: string;
  /** A destroy plan; the gate never applies one. */
  readonly destroy: boolean;
  readonly resources: readonly PlannedRow[];
  readonly actions: ReadonlyArray<{ readonly fqn: string; readonly type: string; readonly action: string }>;
}

/**
 * Plans the stage's deployment, hands the plan to `review`, and applies that
 * same plan only when `review` resolves true.
 */
export type StackPlanner = (
  stage: string,
  review: (plan: StackPlan) => Promise<boolean>,
) => Promise<{ readonly applied: boolean; readonly output?: unknown }>;

/** Reviewed identities per durable stage and protected logical ID (deploy/protected-resources.json). */
export type ProtectedPins = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>> | undefined>>;

export interface PlanGateIO {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly pins: ProtectedPins;
  readonly stack: StackPlanner;
  readonly now: () => Date;
  readonly readFile: (path: string) => string | undefined;
  readonly writeFile: (path: string, text: string) => void;
  readonly log: (line: string) => void;
}

/**
 * Resources whose loss loses Support data or service. Only these fields, each
 * checked against its pattern, leave the plan: nothing else Alchemy holds in
 * state is retained.
 */
const PROTECTED: Readonly<Record<string, { type: string; identity: Readonly<Record<string, RegExp>> }>> = {
  SupportDB: { type: "Cloudflare.D1Database", identity: d1Identity() },
  SupportLedger: { type: "Cloudflare.D1Database", identity: d1Identity() },
  Worker: {
    type: "Cloudflare.Worker",
    identity: { workerId: /^[0-9a-f]{32}$/, workerName: /^[a-z0-9][a-z0-9-]{0,62}$/, accountId: /^[0-9a-f]{32}$/ },
  },
};

function d1Identity(): Record<string, RegExp> {
  return {
    databaseId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    // Alchemy names a database `<Stack>-<LogicalId>-<stage>-<suffix>`, in mixed case: GQSupportWorker-SupportDB-prod-….
    databaseName: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
    jurisdiction: /^(eu|fedramp|default)$/,
    accountId: /^[0-9a-f]{32}$/,
  };
}

const ACTIONS = new Set(["create", "update", "adopted", "replace", "delete", "orphaned", "noop"]);
const DESTRUCTIVE = new Set(["replace", "delete", "orphaned"]);
const NAME = /^[A-Za-z0-9][\w./:-]{0,199}$/;

interface EvidenceRow {
  fqn: string;
  type: string;
  action: string;
  identity?: Record<string, string>;
}

/** Sanitized rows and every reason the plan may not be applied. */
function review(plan: StackPlan, stage: string, pins: ProtectedPins) {
  const refusals: string[] = [];
  if (plan.stack !== STACK) refusals.push(`The plan is for stack ${safe(plan.stack)}, not ${STACK}.`);
  if (plan.stage !== stage) refusals.push(`The plan is for stage ${safe(plan.stage)}, not ${stage}.`);
  if (plan.destroy) refusals.push("The plan destroys the stage.");

  const rows: EvidenceRow[] = plan.resources.map((row) => {
    const fqn = safe(row.fqn);
    const type = safe(row.type);
    if (fqn !== row.fqn || type !== row.type) refusals.push(`${fqn} has an unrecognized name or type.`);
    const action = ACTIONS.has(row.action) ? row.action : "unknown";
    if (action === "unknown") refusals.push(`${fqn} has an unrecognized plan action.`);
    if (DESTRUCTIVE.has(action)) refusals.push(`${fqn} (${type}) would ${action === "orphaned" ? "be deleted as an orphan" : action}.`);
    const spec = PROTECTED[row.logicalId];
    if (spec === undefined || row.type !== spec.type) return { fqn, type, action };
    const identity: Record<string, string> = {};
    for (const [field, pattern] of Object.entries(spec.identity)) {
      const value = row.attributes?.[field];
      if (value === undefined) continue;
      if (typeof value === "string" && pattern.test(value)) identity[field] = value;
      else refusals.push(`${fqn} has an unrecognized ${field}.`);
    }
    return Object.keys(identity).length === 0 ? { fqn, type, action } : { fqn, type, action, identity };
  });

  const stagePins = pins[stage];
  for (const [logicalId, spec] of Object.entries(PROTECTED)) {
    const matches = plan.resources.filter((row) => row.logicalId === logicalId && row.type === spec.type);
    if (matches.length !== 1) {
      refusals.push(`The plan has ${matches.length} ${logicalId} resources; exactly one is required.`);
      continue;
    }
    const row = rows[plan.resources.indexOf(matches[0]!)]!;
    if (row.identity?.accountId !== undefined && row.identity.accountId !== TIPME_ACCOUNT_ID) {
      refusals.push(`${logicalId} belongs to another Cloudflare account.`);
    }
    const pinned = stagePins?.[logicalId];
    if (stagePins === undefined) {
      if (row.action !== "create") {
        refusals.push(`${logicalId} already exists (${row.action}) but no reviewed identity is pinned for ${stage} in deploy/protected-resources.json.`);
      }
    } else if (pinned === undefined || Object.keys(pinned).length === 0) {
      refusals.push(`No reviewed identity is pinned for ${stage} ${logicalId}.`);
    } else if (row.action !== "noop" && row.action !== "update") {
      refusals.push(`${logicalId} is pinned but the plan would ${row.action} it.`);
    } else {
      for (const [field, expected] of Object.entries(pinned)) {
        if (row.identity?.[field] !== expected) refusals.push(`${logicalId} ${field} does not match its pinned identity.`);
      }
    }
  }
  rows.sort((a, b) => (a.fqn < b.fqn ? -1 : a.fqn > b.fqn ? 1 : 0));
  const actions = plan.actions
    .map((action) => ({ fqn: safe(action.fqn), type: safe(action.type), action: ["run", "delete", "noop"].includes(action.action) ? action.action : "unknown" }))
    .sort((a, b) => (a.fqn < b.fqn ? -1 : a.fqn > b.fqn ? 1 : 0));
  plan.actions.forEach((action) => {
    if (safe(action.fqn) !== action.fqn || safe(action.type) !== action.type || !["run", "delete", "noop"].includes(action.action)) {
      refusals.push(`Stack action ${safe(action.fqn)} has an unrecognized name, type or action.`);
    }
  });
  return { rows, actions, refusals };
}

const safe = (value: string) => (NAME.test(value) ? value : "<unrecognized>");

/** The content hash of what the plan does: two plans with equal digests make the same changes to the same resources. */
const digestOf = (body: object) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

function provenance(env: PlanGateIO["env"]): { missing: string[] } | Origin {
  const keys = ["GITHUB_SHA", "GITHUB_REF", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SERVER_URL", "GITHUB_WORKFLOW_REF"] as const;
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) return { missing };
  return {
    commit: env.GITHUB_SHA!,
    provenance: {
      repository: env.GITHUB_REPOSITORY!,
      ref: env.GITHUB_REF!,
      workflow: env.GITHUB_WORKFLOW_REF!,
      runId: env.GITHUB_RUN_ID!,
      runAttempt: env.GITHUB_RUN_ATTEMPT!,
      runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    },
  };
}

/** The commit and GitHub Actions run a plan or deployment belongs to. */
interface Origin {
  readonly commit: string;
  readonly provenance: { readonly repository: string; readonly ref: string; readonly workflow: string; readonly runId: string; readonly runAttempt: string; readonly runUrl: string };
}

function parseArgs(argv: readonly string[]): { command: "plan" | "apply"; stage: string; dir: string; reviewedDigest?: string } | undefined {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const value = rest[index + 1];
    if (!["--stage", "--out", "--evidence", "--reviewed-digest"].includes(flag) || value === undefined || value.startsWith("-") || flag.slice(2) in flags) return undefined;
    flags[flag.slice(2)] = value;
  }
  const { stage, out, evidence, "reviewed-digest": reviewedDigest, ...unknown } = flags;
  if (stage === undefined || Object.keys(unknown).length > 0) return undefined;
  if (command === "plan" && out !== undefined && evidence === undefined && reviewedDigest === undefined) return { command, stage, dir: out };
  if (command === "apply" && evidence !== undefined && out === undefined) return { command, stage, dir: evidence, ...(reviewedDigest === undefined ? {} : { reviewedDigest }) };
  return undefined;
}

const USAGE = "Usage: deploy-gate plan --stage <staging|prod> --out <dir> | deploy-gate apply --stage <staging|prod> --evidence <dir> [--reviewed-digest <sha256>]";

/** Stages whose apply must name the digest of a plan a human reviewed from a plan-only run. */
const REVIEWED_STAGES: readonly string[] = ["prod"];

/**
 * The only deployment path for durable stages. `plan` records a sanitized,
 * credentialed Alchemy plan and fails unless it is safe; `apply` re-plans,
 * requires the same plan as the retained evidence, and applies only that.
 * Returns the process exit code.
 */
export async function planGate(argv: readonly string[], io: PlanGateIO): Promise<number> {
  const args = parseArgs(argv);
  if (args === undefined) {
    io.log(USAGE);
    return 2;
  }
  const stage = args.stage;
  if (!isDurableStage(stage)) {
    io.log(`The deploy gate covers the durable stages only, not ${safe(stage)}.`);
    return 2;
  }
  const origin = provenance(io.env);
  if ("missing" in origin) {
    io.log(`Missing deployment provenance: ${origin.missing.join(", ")}.`);
    return 1;
  }
  if (io.env.CLOUDFLARE_ACCOUNT_ID !== TIPME_ACCOUNT_ID) {
    io.log("CLOUDFLARE_ACCOUNT_ID must be the Tipme account.");
    return 1;
  }

  return args.command === "plan" ? recordPlan(stage, args.dir, origin, io) : applyRetained(stage, args.dir, args.reviewedDigest, origin, io);
}

/** Reviews a plan as evidence for this run. */
function evidenceFor(plan: StackPlan, stage: string, origin: Origin, io: PlanGateIO) {
  const { rows, actions, refusals } = review(plan, stage, io.pins);
  const body = { schema: SCHEMA, stack: STACK, stage, accountId: TIPME_ACCOUNT_ID, commit: origin.commit, resources: rows, actions };
  return {
    ...body,
    digest: digestOf(body),
    verdict: refusals.length === 0 ? "safe" : "refused",
    refusals,
    provenance: { ...origin.provenance, plannedAt: io.now().toISOString() },
  };
}

async function recordPlan(stage: string, out: string, origin: Origin, io: PlanGateIO) {
  let verdict = "refused";
  const run = io.stack(stage, async (plan) => {
    const evidence = evidenceFor(plan, stage, origin, io);
    io.writeFile(join(out, "plan.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    io.writeFile(join(out, "summary.md"), summary(evidence));
    for (const line of evidence.refusals) io.log(line);
    io.log(`Plan for ${stage} at ${origin.commit}: ${evidence.verdict} (${evidence.digest}).`);
    verdict = evidence.verdict;
    return false;
  });
  try {
    await run;
  } catch {
    io.log(`Alchemy could not plan ${stage}; nothing was applied.`);
    return 1;
  }
  return verdict === "safe" ? 0 : 1;
}

/** How old a retained plan may be when its run applies it. */
const MAX_PLAN_AGE_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Why retained evidence may not authorize this run's deployment of `stage`. */
function retainedProblems(evidence: Record<string, unknown>, stage: string, origin: Origin, now: Date): string[] {
  const problems: string[] = [];
  if (evidence.schema !== SCHEMA) problems.push(`The retained plan has an unsupported schema; ${SCHEMA} is required.`);
  const body = { schema: evidence.schema, stack: evidence.stack, stage: evidence.stage, accountId: evidence.accountId, commit: evidence.commit, resources: evidence.resources, actions: evidence.actions };
  if (typeof evidence.digest !== "string" || digestOf(body) !== evidence.digest) problems.push("The retained plan's digest does not match its contents.");
  if (evidence.verdict !== "safe" || !Array.isArray(evidence.refusals) || evidence.refusals.length > 0) problems.push("The retained plan is not safe.");
  if (evidence.stack !== STACK || evidence.stage !== stage) problems.push(`The retained plan is not for the ${STACK} ${stage} stage.`);
  if (evidence.accountId !== TIPME_ACCOUNT_ID) problems.push("The retained plan is not for the Tipme account.");
  if (evidence.commit !== origin.commit) problems.push(`The retained plan is for another commit, not ${origin.commit}.`);
  const retained = (typeof evidence.provenance === "object" && evidence.provenance !== null ? evidence.provenance : {}) as Record<string, unknown>;
  if (retained.repository !== origin.provenance.repository || retained.runId !== origin.provenance.runId || retained.workflow !== origin.provenance.workflow) {
    problems.push(`The retained plan is from another run, not run ${origin.provenance.runId} of ${origin.provenance.workflow}.`);
  }
  const plannedAt = typeof retained.plannedAt === "string" ? Date.parse(retained.plannedAt) : Number.NaN;
  if (Number.isNaN(plannedAt)) problems.push("The retained plan has no valid planned at time.");
  else if (now.getTime() - plannedAt > MAX_PLAN_AGE_MS) problems.push(`The retained plan was planned at ${new Date(plannedAt).toISOString()}, more than 6 hours ago.`);
  else if (plannedAt - now.getTime() > CLOCK_SKEW_MS) problems.push(`The retained plan was planned at ${new Date(plannedAt).toISOString()}, in the future.`);
  return problems;
}

async function applyRetained(stage: string, dir: string, reviewedDigest: string | undefined, origin: Origin, io: PlanGateIO) {
  const text = io.readFile(join(dir, "plan.json"));
  if (text === undefined) {
    io.log(`No retained plan at ${join(dir, "plan.json")}; run the plan job first. Nothing was applied.`);
    return 1;
  }
  let retained: unknown;
  try {
    retained = JSON.parse(text);
  } catch {
    retained = undefined;
  }
  if (typeof retained !== "object" || retained === null || Array.isArray(retained)) {
    io.log("The retained plan is unparseable. Nothing was applied.");
    return 1;
  }
  const evidence = retained as Record<string, unknown>;
  const problems = retainedProblems(evidence, stage, origin, io.now());
  if (reviewedDigest !== undefined ? reviewedDigest !== evidence.digest : REVIEWED_STAGES.includes(stage)) {
    problems.push(reviewedDigest === undefined
      ? `Deploying ${stage} needs --reviewed-digest: the digest of a reviewed plan-only run of this commit.`
      : "The retained plan differs from the reviewed plan; review a new plan-only run.");
  }
  if (problems.length > 0) {
    for (const line of problems) io.log(line);
    io.log("Nothing was applied.");
    return 1;
  }

  let approved = false;
  let result: Awaited<ReturnType<StackPlanner>>;
  try {
    result = await io.stack(stage, async (plan) => {
      const fresh = evidenceFor(plan, stage, origin, io);
      for (const line of fresh.refusals) io.log(line);
      if (fresh.refusals.length > 0) return false;
      if (fresh.digest !== evidence.digest) {
        io.log(`The fresh plan (${fresh.digest}) differs from the retained plan (${String(evidence.digest)}); plan again.`);
        return false;
      }
      approved = true;
      return true;
    });
  } catch {
    io.log(approved ? `Alchemy failed while applying ${stage}; see its output above.` : `Alchemy could not plan ${stage}; nothing was applied.`);
    if (approved) record(dir, "failed", undefined);
    return 1;
  }
  if (!result.applied) {
    io.log("Nothing was applied.");
    return 1;
  }
  record(dir, "applied", result.output);
  io.log(`Applied plan ${String(evidence.digest)} to ${stage} at ${origin.commit}.`);
  return 0;

  function record(dir: string, outcome: string, output: unknown) {
    const deployment = {
      schema: "gq-support.deploy-applied/v1",
      outcome,
      stage,
      commit: origin.commit,
      planDigest: evidence.digest,
      appliedAt: io.now().toISOString(),
      provenance: origin.provenance,
      output: stackOutput(output),
    };
    io.writeFile(join(dir, "applied.json"), `${JSON.stringify(deployment, null, 2)}\n`);
  }
}

/** The stack's public outputs (alchemy.run.ts): names, IDs and the Worker URL. */
const OUTPUTS = ["url", "workerName", "databaseName", "databaseId", "ledgerDatabaseName", "ledgerDatabaseId"];

function stackOutput(output: unknown): Record<string, string> {
  if (typeof output !== "object" || output === null) return {};
  const values = output as Record<string, unknown>;
  return Object.fromEntries(OUTPUTS.flatMap((key) => {
    const value = values[key];
    return typeof value === "string" && /^[\w.:/-]{1,200}$/.test(value) ? [[key, value]] : [];
  }));
}

function summary(evidence: { stage: string; commit: string; verdict: string; digest: string; refusals: string[]; resources: EvidenceRow[] }) {
  const rows = evidence.resources.map((row) =>
    `| \`${row.fqn}\` | ${row.type} | ${row.action} | ${row.identity === undefined ? "" : Object.entries(row.identity).map(([key, value]) => `${key} \`${value}\``).join(", ")} |`);
  return [
    `## Deploy plan: ${evidence.stage} — ${evidence.verdict}`,
    "",
    `Commit \`${evidence.commit}\`, plan digest \`${evidence.digest}\`.`,
    "",
    ...evidence.refusals.map((line) => `- **Refused:** ${line}`),
    "",
    "| Resource | Type | Action | Identity |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
