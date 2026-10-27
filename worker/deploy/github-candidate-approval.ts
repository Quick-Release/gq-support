// Trusted launcher only. All authentication is read from GitHub HTTPS responses;
// no timestamp, verifier or approval flag supplied by the graph is authoritative.
import { boundedBody, wireJson } from "./planning-read.ts";
import { requireEvidence, refusal, checkStage, type ProtectedStage } from "./planning-state.ts";

export const REPOSITORY = "Quick-Release/gq-support";
export interface ApprovalPolicy {
  readonly stage: ProtectedStage;
  readonly repositoryId: number;
  readonly approvers: Readonly<Record<"vvaz" | "gmarques", number>>;
  readonly run: number;
  readonly attempt: number;
  readonly head: string;
  readonly workflow: ".github/workflows/deploy-worker.yml";
}
export interface ApprovalCandidate {
  readonly candidate: string;
  readonly nonce: string;
  readonly readyAt: number;
  readonly expiresAt: number;
}
const root = `https://api.github.com/repos/${REPOSITORY}`;
export function approvalCommand(policy: ApprovalPolicy, candidate: ApprovalCandidate) {
  return `approve-plan ${REPOSITORY} ${policy.stage} ${policy.run}/${policy.attempt} ${policy.head} ${candidate.candidate} ${candidate.nonce}`;
}

// A comment on #20 is an explicit post-plan command, not a deployment approval
// API event. The pre-job environment gate remains independently mandatory.
// Only creation is accepted: editing a pre-plan comment into an approval fails.
export function githubCandidateApproval(policy: ApprovalPolicy, token: string, transport: typeof fetch, now = Date.now) {
  policy = structuredClone(policy);
  checkStage(policy.stage);
  // Review history has no attempt identity/timestamp. A rerun cannot prove
  // its environment review is fresh; require a new workflow dispatch.
  requireEvidence(Number.isSafeInteger(policy.repositoryId) && policy.repositoryId > 0 &&
    Number.isSafeInteger(policy.run) && policy.run > 0 && policy.attempt === 1 &&
    /^[a-f0-9]{40}$/.test(policy.head) && policy.workflow === ".github/workflows/deploy-worker.yml" &&
    Object.keys(policy.approvers).sort().join() === "gmarques,vvaz" &&
    Object.values(policy.approvers).every((id) => Number.isSafeInteger(id) && id > 0) &&
    new Set(Object.values(policy.approvers)).size === 2 && token.length > 0 && !/\s/.test(token));
  let sealed: ApprovalCandidate | undefined;
  let accepted: number | undefined;
  let invalid = false;
  let requests = 0;
  const get = async (path: string): Promise<unknown> => {
    requireEvidence(!invalid && ++requests <= 12_000);
    const url = path.startsWith("/users/") ? `https://api.github.com${path}` : root + path;
    const response = await transport(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000), headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gq-support-candidate-approval", "Cache-Control": "no-cache",
    } });
    requireEvidence(response.status === 200 && !response.redirected && (!response.url || response.url === url) &&
      response.headers.get("content-type")?.startsWith("application/json") && !response.headers.has("link"));
    return wireJson(await boundedBody(response, 256 * 1024));
  };
  const obj = (value: unknown): Record<string, unknown> => {
    requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  async function policyChecks() {
      const run = obj(await get(`/actions/runs/${policy.run}`));
      requireEvidence(run.id === policy.run && run.run_attempt === policy.attempt && run.head_sha === policy.head &&
        run.head_branch === "main" && run.path === policy.workflow && run.event === "workflow_dispatch" &&
        typeof run.display_title === "string" &&
        (run.display_title === `Deploy Support Worker (${policy.stage})` || run.display_title.startsWith(`Deploy Support Worker (${policy.stage}) `)) &&
        run.status === "in_progress" && run.conclusion === null && obj(run.repository).id === policy.repositoryId &&
        obj(run.repository).full_name === REPOSITORY && obj(run.head_repository).id === policy.repositoryId);
      const branch = obj(await get("/branches/main"));
      requireEvidence(branch.protected === true && obj(branch.commit).sha === policy.head);
      const protection = obj(await get("/branches/main/protection"));
      requireEvidence(obj(protection.enforce_admins).enabled === true &&
        obj(protection.required_pull_request_reviews).required_approving_review_count !== undefined &&
        Number(obj(protection.required_pull_request_reviews).required_approving_review_count) >= 1 &&
        obj(protection.allow_force_pushes).enabled === false && obj(protection.allow_deletions).enabled === false);
      const environment = obj(await get(`/environments/${policy.stage}`));
      const deployment = obj(environment.deployment_branch_policy);
      requireEvidence(environment.name === policy.stage && Number.isSafeInteger(environment.id) &&
        deployment.protected_branches === true && deployment.custom_branch_policies === false && Array.isArray(environment.protection_rules));
      const reviewers = environment.protection_rules.map(obj).filter((rule) => rule.type === "required_reviewers");
      requireEvidence(reviewers.length === 1 && reviewers[0].prevent_self_review === true && Array.isArray(reviewers[0].reviewers));
      const configured = reviewers[0].reviewers.map(obj);
      requireEvidence(configured.length === 2 && configured.every((entry) => entry.type === "User" &&
        policy.approvers[obj(entry.reviewer).login as keyof typeof policy.approvers] === obj(entry.reviewer).id) &&
        new Set(configured.map((entry) => obj(entry.reviewer).id)).size === 2);
      // GET environment does not expose a documented can_admins_bypass field.
      // Verify an actual environment review from this run instead of inventing it.
      const reviews = await get(`/actions/runs/${policy.run}/approvals`);
      requireEvidence(Array.isArray(reviews));
      const relevant = reviews.map(obj).filter((review) => Array.isArray(review.environments) &&
        review.environments.some((env) => obj(env).id === environment.id && obj(env).name === policy.stage));
      requireEvidence(relevant.length === 1 && relevant[0].state === "approved" &&
        policy.approvers[obj(relevant[0].user).login as keyof typeof policy.approvers] === obj(relevant[0].user).id);
      for (const login of ["vvaz", "gmarques"] as const) {
        const identity = obj(await get(`/users/${login}`));
        const permission = obj(await get(`/collaborators/${login}/permission`));
        requireEvidence(identity.id === policy.approvers[login] && identity.login === login && identity.type === "User" &&
          ["admin", "maintain", "write"].includes(String(permission.permission)) &&
          obj(permission.user).id === identity.id && obj(permission.user).login === login);
      }
  }
  async function check(candidate: ApprovalCandidate): Promise<boolean> {
    try {
      requireEvidence(!invalid && /^[a-f0-9]{64}$/.test(candidate.candidate) && /^[a-f0-9]{64}$/.test(candidate.nonce) &&
        Number.isSafeInteger(candidate.readyAt) && Number.isSafeInteger(candidate.expiresAt) &&
        candidate.readyAt <= now() && now() < candidate.expiresAt && candidate.expiresAt - candidate.readyAt <= 15 * 60_000);
      if (!sealed) sealed = Object.freeze({ ...candidate });
      requireEvidence(JSON.stringify(sealed) === JSON.stringify(candidate));
      const fresh = () => requireEvidence(!invalid && candidate.readyAt <= now() && now() < candidate.expiresAt);
      await policyChecks();
      fresh();
      const comments = await get(`/issues/20/comments?since=${encodeURIComponent(new Date(candidate.readyAt).toISOString())}&per_page=100`);
      requireEvidence(Array.isArray(comments) && comments.length < 100);
      const command = approvalCommand(policy, candidate);
      const matches: Record<string, unknown>[] = [];
      for (const raw of comments) {
        const comment = obj(raw);
        if (comment.body !== command && comment.body !== command.replace(/^approve-plan /, "revoke-plan ")) continue;
        const user = obj(comment.user);
        requireEvidence(user.type === "User" && policy.approvers[user.login as keyof typeof policy.approvers] === user.id &&
          comment.issue_url === `${root}/issues/20` && Number.isSafeInteger(comment.id));
        const created = Date.parse(String(comment.created_at));
        requireEvidence(Number.isFinite(created) && created > candidate.readyAt && created <= now() &&
          created < candidate.expiresAt && now() - created <= 5 * 60_000 && comment.created_at === comment.updated_at);
        requireEvidence(comment.body === command); // an authenticated revocation is terminal
        matches.push(comment);
      }
      requireEvidence(matches.length <= 1);
      fresh();
      if (accepted !== undefined) requireEvidence(matches.length === 1 && matches[0].id === accepted);
      if (!matches.length) return false;
      // Re-read the exact comment; deletion/edit between list and handoff fails.
      const comment = obj(await get(`/issues/comments/${matches[0].id}`));
      requireEvidence(JSON.stringify(comment) === JSON.stringify(matches[0]));
      fresh();
      requireEvidence(now() - Date.parse(String(comment.created_at)) <= 5 * 60_000);
      accepted = Number(comment.id);
      return true;
    } catch { invalid = true; token = ""; throw refusal(); }
  }
  return Object.freeze({ check, preflight: async () => { try { await policyChecks(); } catch { invalid = true; token = ""; throw refusal(); } }, close: () => { invalid = true; token = ""; } });
}
