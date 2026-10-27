// Fake first-party HTTP ONLY. Numeric identities below are synthetic; they
// deliberately do not assert live vvaz/gmarques identities or configuration.
import { approvalCommand, REPOSITORY, type ApprovalPolicy, type ApprovalCandidate } from "../../deploy/github-candidate-approval.ts";
export const approvalPolicy: ApprovalPolicy = { stage: "prod", repositoryId: 123, approvers: { vvaz: 11, gmarques: 22 }, run: 456, attempt: 1, head: "a".repeat(40), workflow: ".github/workflows/deploy-worker.yml" };
export function approvalHttp(policy = approvalPolicy) {
  let candidate: ApprovalCandidate | undefined;
  const root = `https://api.github.com/repos/${REPOSITORY}`;
  const fixtures: Record<string, unknown> = {
    [`${root}/actions/runs/${policy.run}`]: { id: policy.run, run_attempt: policy.attempt, head_sha: policy.head, head_branch: "main", path: policy.workflow, event: "workflow_dispatch", display_title: `Deploy Support Worker (${policy.stage})`, status: "in_progress", conclusion: null, repository: { id: policy.repositoryId, full_name: REPOSITORY }, head_repository: { id: policy.repositoryId } },
    [`${root}/branches/main`]: { protected: true, commit: { sha: policy.head } },
    [`${root}/branches/main/protection`]: { enforce_admins: { enabled: true }, required_pull_request_reviews: { required_approving_review_count: 1 }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } },
    [`${root}/environments/${policy.stage}`]: { id: policy.stage === "prod" ? 111 : 222, name: policy.stage, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }, protection_rules: [{ type: "required_reviewers", prevent_self_review: true, reviewers: Object.entries(policy.approvers).map(([login, id]) => ({ type: "User", reviewer: { login, id } })) }] },
  };
  fixtures[`${root}/actions/runs/${policy.run}/approvals`] = [{ state: "approved", user: { id: 11, login: "vvaz" }, environments: [{ id: policy.stage === "prod" ? 111 : 222, name: policy.stage }] }];
  for (const [login, id] of Object.entries(policy.approvers)) {
    fixtures[`https://api.github.com/users/${login}`] = { id, login, type: "User" };
    fixtures[`${root}/collaborators/${login}/permission`] = { permission: "admin", user: { id, login } };
  }
  let comment: Record<string, unknown> | undefined;
  const approve = (value: ApprovalCandidate, created = value.readyAt + 1000) => {
    candidate = value;
    const at = new Date(created).toISOString();
    comment = { id: 789, user: { id: 11, login: "vvaz", type: "User" }, body: approvalCommand(policy, value), created_at: at, updated_at: at, issue_url: `${root}/issues/20` };
    return comment;
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (init?.method !== "GET" || init?.redirect !== "error") throw new Error("Unexpected non-GET");
    const path = String(url);
    if (fixtures[path]) return Response.json(fixtures[path]);
    if (path.startsWith(`${root}/issues/20/comments?`)) return Response.json(candidate && comment ? [comment] : []);
    if (path === `${root}/issues/comments/789` && comment) return Response.json(comment);
    return Response.json({}, { status: 404 });
  };
  return { fetch, fixtures, approve, remove: () => { comment = undefined; } };
}
