import { describe, expect, it } from "vitest";
import { planGate, type PlanGateIO, type PlannedRow, type ProtectedPins, type StackPlan } from "../deploy/plan-gate.ts";
import reviewedPins from "../deploy/protected-resources.json" with { type: "json" };

const TIPME = "8f38791a8c37b182239af2a385ab3c31";
const COMMIT = "0ce1c6011111111111111111111111111111111a";
const SECRET = "sentinel-secret-value-never-retained";

const supportDb = "0b1d5c1e-1111-4a4a-8a8a-000000000001";
const ledgerDb = "0b1d5c1e-2222-4a4a-8a8a-000000000002";

const d1 = (logicalId: string, databaseId: string, action = "update"): PlannedRow => ({
  fqn: logicalId,
  logicalId,
  type: "Cloudflare.D1Database",
  action,
  attributes: {
    databaseId,
    databaseName: `GQSupportWorker-${logicalId}-staging-abc123`,
    jurisdiction: "eu",
    accountId: TIPME,
    migrationsHashes: { "0001_init.sql": SECRET },
  },
});

const worker = (action = "update"): PlannedRow => ({
  fqn: "Worker",
  logicalId: "Worker",
  type: "Cloudflare.Worker",
  action,
  attributes: {
    workerId: "c81a2d22c29840ed9d61681a3270dbff",
    workerName: "gqsupportworker-worker-staging-fzos3ewkrboeduj2",
    accountId: TIPME,
    url: `https://worker.example/?token=${SECRET}`,
  },
});

const appSecret: PlannedRow = {
  fqn: "GitHubAppSecret",
  logicalId: "GitHubAppSecret",
  type: "GQSupport.GitHubAppSecret",
  action: "update",
  attributes: { fingerprint: SECRET },
};

const stagingPlan = (overrides: Partial<StackPlan> = {}): StackPlan => ({
  stack: "GQSupportWorker",
  stage: "staging",
  destroy: false,
  resources: [d1("SupportDB", supportDb), d1("SupportLedger", ledgerDb), worker(), appSecret],
  actions: [],
  ...overrides,
});

const pins = {
  staging: {
    SupportDB: { databaseId: supportDb },
    SupportLedger: { databaseId: ledgerDb },
    Worker: { workerName: "gqsupportworker-worker-staging-fzos3ewkrboeduj2" },
  },
};

const ciEnv = {
  CLOUDFLARE_ACCOUNT_ID: TIPME,
  GITHUB_SHA: COMMIT,
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "Quick-Release/gq-support",
  GITHUB_RUN_ID: "4242",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_WORKFLOW_REF: "Quick-Release/gq-support/.github/workflows/deploy-worker.yml@refs/heads/main",
};

/** A CI job: an in-memory directory and an Alchemy stack that plans `plans` in turn. */
const job = (plans: StackPlan[], options: { env?: Record<string, string | undefined>; at?: string; files?: Map<string, string> } = {}) => {
  const files = options.files ?? new Map<string, string>();
  const applied: StackPlan[] = [];
  const lines: string[] = [];
  let planned = 0;
  const io: PlanGateIO = {
    env: options.env ?? ciEnv,
    pins,
    now: () => new Date(options.at ?? "2026-10-31T10:00:00.000Z"),
    readFile: (path) => files.get(path),
    writeFile: (path, text) => void files.set(path, text),
    log: (line) => void lines.push(line),
    stack: async (stage, review) => {
      const plan = plans[planned++];
      if (plan === undefined) throw new Error("no more plans");
      expect(stage).toBe(plan.stage);
      if (!(await review(plan))) return { applied: false };
      applied.push(plan);
      return { applied: true, output: { workerName: "gqsupportworker-worker-staging-fzos3ewkrboeduj2", databaseId: supportDb } };
    },
  };
  return { io, files, applied, lines, evidence: () => JSON.parse(files.get("deploy-plan/plan.json") ?? "null") };
};

const plan = (io: PlanGateIO, stage = "staging") => planGate(["plan", "--stage", stage, "--out", "deploy-plan"], io);

describe("deploy plan gate: plan", () => {
  it("records a safe plan with its commit, stage, run and protected identities, and applies nothing", async () => {
    const ci = job([stagingPlan()]);

    expect(await plan(ci.io)).toBe(0);

    expect(ci.applied).toEqual([]);
    const evidence = ci.evidence();
    expect(evidence).toMatchObject({
      verdict: "safe",
      refusals: [],
      stage: "staging",
      stack: "GQSupportWorker",
      accountId: TIPME,
      commit: COMMIT,
      provenance: {
        repository: "Quick-Release/gq-support",
        ref: "refs/heads/main",
        runId: "4242",
        runAttempt: "1",
        runUrl: "https://github.com/Quick-Release/gq-support/actions/runs/4242",
        plannedAt: "2026-10-31T10:00:00.000Z",
      },
    });
    expect(evidence.resources).toEqual([
      { fqn: "GitHubAppSecret", type: "GQSupport.GitHubAppSecret", action: "update" },
      {
        fqn: "SupportDB",
        type: "Cloudflare.D1Database",
        action: "update",
        identity: {
          databaseId: supportDb,
          databaseName: "GQSupportWorker-SupportDB-staging-abc123",
          jurisdiction: "eu",
          accountId: TIPME,
        },
      },
      {
        fqn: "SupportLedger",
        type: "Cloudflare.D1Database",
        action: "update",
        identity: {
          databaseId: ledgerDb,
          databaseName: "GQSupportWorker-SupportLedger-staging-abc123",
          jurisdiction: "eu",
          accountId: TIPME,
        },
      },
      {
        fqn: "Worker",
        type: "Cloudflare.Worker",
        action: "update",
        identity: {
          workerId: "c81a2d22c29840ed9d61681a3270dbff",
          workerName: "gqsupportworker-worker-staging-fzos3ewkrboeduj2",
          accountId: TIPME,
        },
      },
    ]);
    expect(evidence.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ci.files.get("deploy-plan/summary.md")).toContain("safe");
  });

  it("refuses to replace the main database and records why", async () => {
    const ci = job([stagingPlan({ resources: [d1("SupportDB", supportDb, "replace"), d1("SupportLedger", ledgerDb), worker(), appSecret] })]);

    expect(await plan(ci.io)).toBe(1);

    expect(ci.applied).toEqual([]);
    expect(ci.evidence().verdict).toBe("refused");
    expect(ci.evidence().refusals.join("\n")).toMatch(/SupportDB.*replace/);
  });
});

describe("deploy plan gate: plan refusals", () => {
  const without = (logicalId: string) => stagingPlan().resources.filter((row) => row.logicalId !== logicalId);

  it.each([
    ["deleting the suppression ledger", [d1("SupportDB", supportDb), d1("SupportLedger", ledgerDb, "delete"), worker(), appSecret], /SupportLedger.*delete/],
    ["orphaning the suppression ledger", [...without("SupportLedger"), { ...d1("SupportLedger", ledgerDb, "orphaned"), fqn: "Old/SupportLedger", logicalId: "OldLedger" }], /Old\/SupportLedger.*orphan/],
    ["replacing the Worker", [d1("SupportDB", supportDb), d1("SupportLedger", ledgerDb), worker("replace"), appSecret], /Worker.*replace/],
    ["deleting any other resource", [...stagingPlan().resources, { fqn: "Legacy", logicalId: "Legacy", type: "Cloudflare.KVNamespace", action: "delete" }], /Legacy.*delete/],
    ["losing the main database from the plan", without("SupportDB"), /0 SupportDB/],
    ["a second suppression ledger", [...stagingPlan().resources, { ...d1("SupportLedger", ledgerDb), fqn: "Copy/SupportLedger" }], /2 SupportLedger/],
    ["creating a pinned database afresh", [d1("SupportDB", supportDb), { ...d1("SupportLedger", ledgerDb, "create"), attributes: undefined }, worker(), appSecret], /SupportLedger is pinned but the plan would create/],
    ["another stage's main database", [d1("SupportDB", "0b1d5c1e-9999-4a4a-8a8a-000000000009"), d1("SupportLedger", ledgerDb), worker(), appSecret], /SupportDB databaseId does not match/],
    ["a database in another account", [{ ...d1("SupportDB", supportDb), attributes: { ...d1("SupportDB", supportDb).attributes, accountId: "0".repeat(32) } }, d1("SupportLedger", ledgerDb), worker(), appSecret], /SupportDB belongs to another Cloudflare account/],
    ["a resource name that is not a plain identifier", [...stagingPlan().resources, { fqn: `Leak ${SECRET}`, logicalId: "Leak", type: "Cloudflare.KVNamespace", action: "create" }], /<unrecognized> has an unrecognized name or type/],
    ["an unrecognized plan action", [d1("SupportDB", supportDb, "truncate"), d1("SupportLedger", ledgerDb), worker(), appSecret], /SupportDB has an unrecognized plan action/],
  ])("refuses %s", async (_, resources, reason) => {
    const ci = job([stagingPlan({ resources })]);

    expect(await plan(ci.io)).toBe(1);

    expect(ci.evidence().verdict).toBe("refused");
    expect(ci.evidence().refusals.join("\n")).toMatch(reason);
  });

  it("refuses a destroy plan", async () => {
    const ci = job([stagingPlan({ destroy: true })]);
    expect(await plan(ci.io)).toBe(1);
    expect(ci.evidence().refusals.join("\n")).toMatch(/destroys the stage/);
  });

  it("refuses a plan Alchemy made for another stage", async () => {
    const ci = job([]);
    const io: PlanGateIO = { ...ci.io, stack: async (_, review) => ({ applied: await review(stagingPlan({ stage: "prod" })) }) };
    expect(await plan(io)).toBe(1);
    expect(ci.evidence().refusals.join("\n")).toMatch(/stage prod, not staging/);
  });

  it("refuses existing resources on a stage without reviewed pins, recording their identities to pin", async () => {
    const prod = stagingPlan({ stage: "prod" });
    const ci = job([prod]);

    expect(await plan(ci.io, "prod")).toBe(1);

    expect(ci.evidence().refusals.join("\n")).toMatch(/SupportDB already exists \(update\) but no reviewed identity is pinned for prod/);
    expect(ci.evidence().resources.find((row: { fqn: string }) => row.fqn === "SupportDB").identity.databaseId).toBe(supportDb);
  });

  it("allows a stage's first deployment, which creates every protected resource", async () => {
    const created = (row: PlannedRow) => ({ ...row, action: "create", attributes: undefined });
    const ci = job([stagingPlan({ stage: "prod", resources: stagingPlan().resources.map(created) })]);

    expect(await plan(ci.io, "prod")).toBe(0);
    expect(ci.evidence().verdict).toBe("safe");
  });

  it("retains no state attribute outside the protected identities", async () => {
    const ci = job([stagingPlan({ resources: [d1("SupportDB", supportDb, "replace"), d1("SupportLedger", ledgerDb), worker(), appSecret] })]);

    await plan(ci.io);

    for (const text of ci.files.values()) expect(text).not.toContain(SECRET);
  });

  it("refuses an identity value that is not a plain identifier, without retaining it", async () => {
    const ci = job([stagingPlan({ resources: [{ ...d1("SupportDB", supportDb), attributes: { databaseId: SECRET } }, d1("SupportLedger", ledgerDb), worker(), appSecret] })]);

    expect(await plan(ci.io)).toBe(1);
    expect(ci.evidence().refusals.join("\n")).toMatch(/SupportDB has an unrecognized databaseId/);
    for (const text of ci.files.values()) expect(text).not.toContain(SECRET);
  });

  it.each([
    ["without a commit", { ...ciEnv, GITHUB_SHA: undefined }],
    ["outside the Tipme account", { ...ciEnv, CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) }],
  ])("plans nothing %s", async (_, env) => {
    const ci = job([stagingPlan()], { env });
    expect(await plan(ci.io)).toBe(1);
    expect(ci.files.size).toBe(0);
  });

  it.each(["dev_valerio", "pr_12"])("is only for durable stages, not %s", async (stage) => {
    const ci = job([stagingPlan({ stage })]);
    expect(await plan(ci.io, stage)).toBe(2);
    expect(ci.files.size).toBe(0);
  });

  it("records no evidence when Alchemy cannot plan", async () => {
    const ci = job([]);
    expect(await plan(ci.io)).toBe(1);
    expect(ci.files.size).toBe(0);
  });
});

describe("deploy plan gate: apply", () => {
  const apply = (io: PlanGateIO, stage = "staging") => planGate(["apply", "--stage", stage, "--evidence", "deploy-plan"], io);

  /** Evidence from a plan job of this run, then an apply job that sees `fresh` and runs with `env` at `at`. */
  const planned = async (fresh: StackPlan, options: { env?: Record<string, string | undefined>; at?: string; edit?: (evidence: Record<string, unknown>) => void } = {}) => {
    const planJob = job([stagingPlan()]);
    expect(await plan(planJob.io)).toBe(0);
    if (options.edit) {
      const evidence = planJob.evidence();
      options.edit(evidence);
      planJob.files.set("deploy-plan/plan.json", JSON.stringify(evidence));
    }
    return job([fresh], { files: planJob.files, env: options.env, at: options.at ?? "2026-10-31T10:20:00.000Z" });
  };

  it("applies the fresh plan when it matches the retained safe plan, and records the deployment", async () => {
    const ci = await planned(stagingPlan(), { env: { ...ciEnv, GITHUB_RUN_ATTEMPT: "2" } });

    expect(await apply(ci.io)).toBe(0);

    expect(ci.applied).toHaveLength(1);
    const deployment = JSON.parse(ci.files.get("deploy-plan/applied.json")!);
    expect(deployment).toMatchObject({
      stage: "staging",
      commit: COMMIT,
      planDigest: ci.evidence().digest,
      appliedAt: "2026-10-31T10:20:00.000Z",
      provenance: { runId: "4242", runAttempt: "2", runUrl: "https://github.com/Quick-Release/gq-support/actions/runs/4242" },
      output: { workerName: "gqsupportworker-worker-staging-fzos3ewkrboeduj2", databaseId: supportDb },
    });
  });

  it("applies nothing without retained evidence", async () => {
    const ci = job([stagingPlan()]);
    expect(await apply(ci.io)).toBe(1);
    expect(ci.applied).toEqual([]);
    expect(ci.lines.join("\n")).toMatch(/No retained plan/);
  });

  it("applies nothing from unparseable evidence", async () => {
    const ci = job([stagingPlan()], { files: new Map([["deploy-plan/plan.json", "{\"verdict\": \"safe\""]]) });
    expect(await apply(ci.io)).toBe(1);
    expect(ci.applied).toEqual([]);
  });

  it.each([
    ["a refused plan", (evidence: Record<string, unknown>) => { evidence.verdict = "refused"; }, /not safe/],
    ["safe-looking evidence with refusals", (evidence: Record<string, unknown>) => { evidence.refusals = ["SupportDB would replace."]; }, /not safe/],
    ["another stage's plan", (evidence: Record<string, unknown>) => { evidence.stage = "prod"; }, /stage/],
    ["another commit's plan", (evidence: Record<string, unknown>) => { evidence.commit = "f".repeat(40); }, /commit/],
    ["another run's plan", (evidence: Record<string, unknown>) => { (evidence.provenance as Record<string, string>).runId = "4141"; }, /run/],
    ["an edited plan", (evidence: Record<string, unknown>) => { (evidence.resources as Array<Record<string, string>>)[1]!.action = "noop"; }, /digest/],
    ["another schema", (evidence: Record<string, unknown>) => { evidence.schema = "gq-support.deploy-plan/v0"; }, /schema/],
  ])("applies nothing from %s", async (_, edit, reason) => {
    const ci = await planned(stagingPlan(), { edit });
    expect(await apply(ci.io)).toBe(1);
    expect(ci.applied).toEqual([]);
    expect(ci.lines.join("\n")).toMatch(reason);
  });

  it.each([
    ["stale", "2026-10-31T16:00:01.000Z"],
    ["from the future", "2026-10-31T09:50:00.000Z"],
  ])("applies nothing from a %s plan", async (_, at) => {
    const ci = await planned(stagingPlan(), { at });
    expect(await apply(ci.io)).toBe(1);
    expect(ci.applied).toEqual([]);
    expect(ci.lines.join("\n")).toMatch(/planned at/);
  });

  it("applies nothing when the fresh plan differs from the retained one", async () => {
    const ci = await planned(stagingPlan({ resources: [d1("SupportDB", supportDb, "noop"), d1("SupportLedger", ledgerDb), worker(), appSecret] }));
    expect(await apply(ci.io)).toBe(1);
    expect(ci.applied).toEqual([]);
    expect(ci.lines.join("\n")).toMatch(/differs from the retained plan/);
  });

  it("applies nothing when the fresh plan would replace a protected resource", async () => {
    const ci = await planned(stagingPlan({ resources: [d1("SupportDB", supportDb, "replace"), d1("SupportLedger", ledgerDb), worker(), appSecret] }));
    expect(await apply(ci.io)).toBe(1);
    expect(ci.applied).toEqual([]);
    expect(ci.lines.join("\n")).toMatch(/SupportDB.*replace/);
  });
});

describe("deploy plan gate: commands", () => {
  it.each([
    [["destroy", "--stage", "prod"]],
    [["deploy", "--stage", "prod", "--out", "deploy-plan"]],
    [["plan", "--stage", "prod", "--out", "deploy-plan", "--adopt"]],
    [["plan", "--stage", "prod"]],
    [["apply", "--stage", "prod", "--out", "deploy-plan"]],
    [["plan", "--stage", "prod", "--out", "deploy-plan", "--reviewed-digest", "a".repeat(64)]],
    [["apply", "--stage", "prod", "--evidence", "deploy-plan", "--stage", "staging"]],
  ])("plans nothing for %j", async (argv) => {
    const ci = job([]);
    expect(await planGate(argv, ci.io)).toBe(2);
    expect(ci.files.size).toBe(0);
  });
});

describe("deploy plan gate: reviewed production plans", () => {
  const prodPins = {
    prod: {
      SupportDB: { databaseId: supportDb },
      SupportLedger: { databaseId: ledgerDb },
      Worker: { workerName: "gqsupportworker-worker-staging-fzos3ewkrboeduj2" },
    },
  };
  const prodPlan = () => stagingPlan({ stage: "prod" });

  /** A plan-only run a human reviewed, then a deploy run that plans, retains and applies. */
  const deployRun = async (reviewed: (digest: string) => string[]) => {
    const review = job([prodPlan()]);
    expect(await plan({ ...review.io, pins: prodPins }, "prod")).toBe(0);
    const digest = review.evidence().digest as string;

    const run = job([prodPlan(), prodPlan()]);
    const io = { ...run.io, pins: prodPins };
    expect(await plan(io, "prod")).toBe(0);
    const code = await planGate(["apply", "--stage", "prod", "--evidence", "deploy-plan", ...reviewed(digest)], io);
    return { code, run };
  };

  it("applies prod only when the plan matches the reviewed plan's digest", async () => {
    const { code, run } = await deployRun((digest) => ["--reviewed-digest", digest]);
    expect(code).toBe(0);
    expect(run.applied).toHaveLength(1);
  });

  it("applies nothing to prod without a reviewed plan", async () => {
    const { code, run } = await deployRun(() => []);
    expect(code).toBe(1);
    expect(run.applied).toEqual([]);
    expect(run.lines.join("\n")).toMatch(/reviewed plan/);
  });

  it("applies nothing to prod when the plan differs from the reviewed one", async () => {
    const { code, run } = await deployRun(() => ["--reviewed-digest", "a".repeat(64)]);
    expect(code).toBe(1);
    expect(run.applied).toEqual([]);
    expect(run.lines.join("\n")).toMatch(/reviewed plan/);
  });
});

describe("deploy plan gate: the reviewed pins", () => {
  // Both durable stages exist: staging since 2026-10-17, prod since run 39634753079 (2026-10-21), last
  // deployed by runs 39962559038 and 39963084422 at 0e6bfc92. A plan that creates any protected
  // resource there would bring up a new, empty database or Worker beside the live one.
  const deployed = (stage: "staging" | "prod") => {
    const pinned = (reviewedPins as Record<string, Record<string, Record<string, string>>>)[stage]!;
    const identity = (logicalId: string) => ({ ...pinned[logicalId], accountId: TIPME, jurisdiction: "eu" });
    return stagingPlan({
      stage,
      resources: [
        { ...d1("SupportDB", ""), attributes: identity("SupportDB") },
        { ...d1("SupportLedger", ""), attributes: identity("SupportLedger") },
        { ...worker(), attributes: identity("Worker") },
        appSecret,
      ],
    });
  };
  const withPins = (ci: ReturnType<typeof job>): PlanGateIO => ({ ...ci.io, pins: reviewedPins as ProtectedPins });

  it.each(["staging", "prod"] as const)("pin every protected resource of %s, and accept an update of those deployed resources", async (stage) => {
    const ci = job([deployed(stage)]);
    expect(await plan(withPins(ci), stage)).toBe(0);
    expect(ci.evidence().verdict).toBe("safe");
  });

  it.each(["staging", "prod"] as const)("refuse a %s plan that would create its protected resources as a first deployment", async (stage) => {
    const created = (row: PlannedRow) => ({ ...row, action: "create", attributes: undefined });
    const ci = job([stagingPlan({ stage, resources: stagingPlan().resources.map(created) })]);
    expect(await plan(withPins(ci), stage)).toBe(1);
    expect(ci.evidence().refusals).toEqual(expect.arrayContaining([
      "SupportDB is pinned but the plan would create it.",
      "SupportLedger is pinned but the plan would create it.",
      "Worker is pinned but the plan would create it.",
    ]));
  });

  it("refuse a prod plan whose database is another one than the deployed prod database", async () => {
    const plan0 = deployed("prod");
    const swapped = { ...plan0, resources: plan0.resources.map((row) => row.logicalId === "SupportDB"
      ? { ...row, attributes: { ...row.attributes, databaseId: "8e8e563c-6633-415a-b435-0a36c0debafe" } } : row) };
    const ci = job([swapped]);
    expect(await plan(withPins(ci), "prod")).toBe(1);
    expect(ci.evidence().refusals).toContain("SupportDB databaseId does not match its pinned identity.");
  });
});
