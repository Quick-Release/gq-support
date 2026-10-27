import { describe, it, expect } from "vitest";
import { githubCandidateApproval, type ApprovalCandidate } from "../deploy/github-candidate-approval.ts";
import { approvalHttp, approvalPolicy } from "./fixtures/approval-http.ts";
const readyAt = Date.parse("2026-10-27T12:00:00Z");
const candidate: ApprovalCandidate = { candidate: "b".repeat(64), nonce: "c".repeat(64), readyAt, expiresAt: readyAt + 10 * 60_000 };
const now = () => readyAt + 2000;
function fixture(stage: "prod" | "staging" = "prod") {
  const policy = { ...approvalPolicy, stage };
  const http = approvalHttp(policy);
  const verifier = githubCandidateApproval(policy, "SYNTHETIC_TOKEN", http.fetch, now);
  return { http, verifier };
}
describe.each(["prod", "staging"] as const)("%s authenticated post-plan GitHub command", (stage) => {
  it("waits for creation after plan-ready; authenticates identity, permission, main/run and protected environment", async () => {
    const { http, verifier } = fixture(stage);
    expect(await verifier.check(candidate)).toBe(false);
    http.approve(candidate);
    expect(await verifier.check(candidate)).toBe(true);
    expect(await verifier.check(candidate)).toBe(true);
  });
  it.each(["dispatch-stage", "environment-stage", "approval-stage", "missing-reviewers", "missing-stage"])("refuses %s without approval carryover", async (change) => {
    const policy = { ...approvalPolicy, stage };
    const other = stage === "prod" ? "staging" : "prod";
    const http = approvalHttp(policy); http.approve(candidate);
    const root = "https://api.github.com/repos/Quick-Release/gq-support";
    if (change === "dispatch-stage") Object.assign(http.fixtures[`${root}/actions/runs/456`]!, { display_title: `Deploy Support Worker (${other})` });
    if (change === "environment-stage") Object.assign(http.fixtures[`${root}/environments/${stage}`]!, { name: other });
    if (change === "approval-stage") http.fixtures[`${root}/actions/runs/456/approvals`] = [{ state: "approved", user: { id: 11, login: "vvaz" }, environments: [{ id: 111, name: other }] }];
    if (change === "missing-reviewers") Object.assign(http.fixtures[`${root}/environments/${stage}`]!, { protection_rules: [] });
    if (change === "missing-stage") {
      Object.assign(policy, { stage: undefined });
      expect(() => githubCandidateApproval(policy, "TOKEN", http.fetch, now)).toThrow("apply blocked"); return;
    }
    await expect(githubCandidateApproval(policy, "TOKEN", http.fetch, now).check(candidate)).rejects.toThrow("apply blocked");
  });
  it("refuses rerun review carryover even when its reported attempt matches", () => {
    const policy = { ...approvalPolicy, stage, attempt: 2 };
    const http = approvalHttp(policy);
    expect(() => githubCandidateApproval(policy, "TOKEN", http.fetch, now)).toThrow("apply blocked");
  });
  it("cannot reuse the other stage's command", async () => {
    const { http, verifier } = fixture(stage);
    const comment = http.approve(candidate);
    comment.body = String(comment.body).replace(` ${stage} `, stage === "prod" ? " staging " : " prod ");
    expect(await verifier.check(candidate)).toBe(false);
  });
  it.each(["identity", "permission", "main", "run", "head", "attempt", "environment", "protection"])("invalidates %s evidence", async (change) => {
    const { http, verifier } = fixture(stage); http.approve(candidate);
    const root = "https://api.github.com/repos/Quick-Release/gq-support";
    const get = (key: string) => http.fixtures[key] as Record<string, unknown>;
    if (change === "identity") get("https://api.github.com/users/vvaz").id = 99;
    if (change === "permission") get(`${root}/collaborators/vvaz/permission`).permission = "read";
    if (change === "main") get(`${root}/actions/runs/456`).head_branch = "topic";
    if (change === "run") get(`${root}/actions/runs/456`).id = 99;
    if (change === "head") get(`${root}/actions/runs/456`).head_sha = "d".repeat(40);
    if (change === "attempt") get(`${root}/actions/runs/456`).run_attempt = 2;
    if (change === "environment") get(`${root}/environments/${stage}`).deployment_branch_policy = { protected_branches: false };
    if (change === "protection") get(`${root}/branches/main/protection`).enforce_admins = { enabled: false };
    await expect(verifier.check(candidate)).rejects.toThrow("apply blocked");
  });
  it.each(["pre-plan", "edited", "wrong-author", "revoked", "future", "expired"])("rejects %s command", async (change) => {
    const { http, verifier } = fixture(stage); const comment = http.approve(candidate);
    if (change === "pre-plan") { comment.created_at = new Date(readyAt).toISOString(); comment.updated_at = comment.created_at; }
    if (change === "edited") comment.updated_at = new Date(readyAt + 1500).toISOString();
    if (change === "wrong-author") comment.user = { id: 33, login: "vvaz", type: "User" };
    if (change === "revoked") comment.body = String(comment.body).replace("approve-plan", "revoke-plan");
    if (change === "future") { comment.created_at = new Date(readyAt + 5000).toISOString(); comment.updated_at = comment.created_at; }
    await expect(verifier.check(change === "expired" ? { ...candidate, expiresAt: readyAt + 1000 } : candidate)).rejects.toThrow("apply blocked");
  });
  it.each(["nonce", "candidate"] as const)("rejects changed %s and consumes verifier", async (key) => {
    const { http, verifier } = fixture(stage); http.approve(candidate); expect(await verifier.check(candidate)).toBe(true);
    await expect(verifier.check({ ...candidate, [key]: "d".repeat(64) })).rejects.toThrow("apply blocked");
    await expect(verifier.check(candidate)).rejects.toThrow("apply blocked");
  });
  it("deletion, cancellation and closed custody cannot authorize again", async () => {
    const { http, verifier } = fixture(stage); http.approve(candidate); expect(await verifier.check(candidate)).toBe(true);
    http.remove(); await expect(verifier.check(candidate)).rejects.toThrow("apply blocked");
    verifier.close(); await expect(verifier.check(candidate)).rejects.toThrow("apply blocked");
  });
  it.each(["expiry", "closed"])("refuses %s occurring while the final authenticated read is pending", async (change) => {
    const policy = { ...approvalPolicy, stage };
    const http = approvalHttp(policy); http.approve(candidate);
    let time = readyAt + 2000;
    const verifier = githubCandidateApproval(policy, "SYNTHETIC_TOKEN", async (url, init) => {
      const response = await http.fetch(url, init);
      if (String(url).endsWith("/issues/comments/789")) {
        if (change === "expiry") time = candidate.expiresAt;
        else verifier.close();
      }
      return response;
    }, () => time);
    await expect(verifier.check(candidate)).rejects.toThrow("apply blocked");
  });
});
