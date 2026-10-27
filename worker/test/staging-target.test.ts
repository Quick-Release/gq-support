import { describe, it, expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import { decodeNativeState } from "../deploy/native-state-decoder.ts";
import { protectedPlanningEntry, planningPrerequisites } from "../deploy/planning-entry.ts";
import { acquireSnapshot } from "../deploy/planning-state.ts";
import * as evidence from "../deploy/planner-evidence.ts";
import type { ReviewedPlannerConfig } from "../deploy/reviewed-planner-config.ts";
import { approvalPolicy } from "./fixtures/approval-http.ts";
import { snapshotInput } from "../deploy/planner-evidence.ts";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { confinedInput } from "./fixtures/confined-input.ts";

describe.each(["prod", "staging"] as const)("%s protected target", (stage) => {
  it("keeps missing reviewed live configuration blocked before transport or private delivery", async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(Effect.runPromise(protectedPlanningEntry("PRIVATE_PATH_CANARY", undefined, {
      DEPLOY_STAGE: stage, GITHUB_REPOSITORY: "Quick-Release/gq-support", GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1",
    }, transport))).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
    expect(planningPrerequisites.endpointContract).toBeUndefined();
    expect(planningPrerequisites.stagingEndpointContract).toBeUndefined();
  });
  it("refuses mismatched reviewed manifest/approval/window/App targets before source or custody", async () => {
    const other = stage === "prod" ? "staging" : "prod";
    const config: ReviewedPlannerConfig = {
      endpoint: { target: { stack: "GQSupportWorker", stage }, account: "8f38791a8c37b182239af2a385ab3c31",
        origin: "https://synthetic.invalid", script: "synthetic", scriptDigest: "a".repeat(64), protocol: 7, path: "/state", mainModule: "main.js",
        scriptEtag: "synthetic", versionId: "synthetic", deploymentId: "synthetic", bindings: [], graph: [], outputPaths: [], databases: [] },
      approval: { ...approvalPolicy, stage }, worker: "synthetic",
      window: { target: { stack: "GQSupportWorker", stage }, id: "a".repeat(64), startsAt: 0, expiresAt: 1, duty: "exclude-every-state-writer-and-endpoint-deployer" },
      app: { id: 123, clientId: "synthetic", slug: stage === "prod" ? "getquick-support" : "getquick-support-staging" },
    };
    // Sentinel proves rejection happens at target binding, before source checks
    // or any credential path, rather than passing because metadata is synthetic.
    const source = vi.spyOn(evidence, "sourceEvidence").mockImplementation(() => { throw new Error("source reached"); });
    const env = { DEPLOY_STAGE: stage, GITHUB_REPOSITORY: "Quick-Release/gq-support", GITHUB_REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1" };
    const transport = vi.fn<typeof fetch>();
    try {
      for (const part of ["manifest", "approval", "window", "app", "locator"] as const) {
        const changed = structuredClone(config);
        if (part === "manifest") changed.endpoint.target.stage = other;
        if (part === "approval") Object.assign(changed.approval, { stage: other });
        if (part === "window") changed.window.target.stage = other;
        if (part === "app") Object.assign(changed.app, { slug: stage === "prod" ? "getquick-support-staging" : "getquick-support" });
        await expect(Effect.runPromise(protectedPlanningEntry("PRIVATE_PATH_CANARY", changed, { ...env, DEPLOY_STAGE: part === "locator" ? other : stage }, transport))).rejects.toThrow("apply blocked");
        expect(source).not.toHaveBeenCalled();
      }
      await expect(Effect.runPromise(protectedPlanningEntry("PRIVATE_PATH_CANARY", config, env, transport))).rejects.toThrow("apply blocked");
      expect(source).toHaveBeenCalledOnce(); expect(transport).not.toHaveBeenCalled();
      // Even otherwise-valid source cannot acquire the window or private
      // delivery while the integrated Discord custody path is unsupported.
      source.mockReturnValue({ manifest: [], source: "synthetic", lockfiles: "synthetic", migrations: "synthetic" });
      const window = vi.spyOn(evidence, "exclusiveLocalWindow").mockImplementation(() => { throw new Error("window reached"); });
      try {
        await expect(Effect.runPromise(protectedPlanningEntry("PRIVATE_PATH_CANARY", config, env, transport))).rejects.toThrow("apply blocked");
        expect(window).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
      } finally { window.mockRestore(); }
    } finally { source.mockRestore(); }
  });
  it("exports only the acquired stage and rejects other-stage native resource/output references", async () => {
    const input = confinedInput(stage);
    const memory = await Effect.runPromise(InMemoryService(input.rows, input.output));
    const snapshot = await Effect.runPromise(acquireSnapshot({ ...memory, getVersion: () => Effect.succeed(7) }, input.target));
    const copied = await snapshotInput(snapshot, input.target);
    expect(Object.keys(copied.rows.GQSupportWorker)).toEqual([stage]);
    expect(Object.keys(copied.output.GQSupportWorker)).toEqual([stage]);
    const other = stage === "prod" ? "staging" : "prod";
    await expect(snapshotInput(snapshot, { ...input.target, stage: other })).rejects.toThrow();
    const graph = { target: input.target, rows: new Map(Object.entries(input.rows.GQSupportWorker[stage])), output: { workerName: "synthetic-worker" } };
    const valid = new Output.RefExpr("GQSupportWorker", stage, "SupportDB");
    expect(decodeNativeState(valid, graph)).toMatchObject({ databaseId: input.databases[0].databaseId });
    expect(() => decodeNativeState(new Output.RefExpr("GQSupportWorker", other, "SupportDB"), graph)).toThrow("apply blocked");
    expect(() => decodeNativeState(new Output.StackRefExpr("GQSupportWorker", other), graph)).toThrow("apply blocked");
  });
});
