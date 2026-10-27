import { constants, openSync, fstatSync, lstatSync, readFileSync, closeSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import { productionEndpointContract, stagingEndpointContract, refusal, requireEvidence, STACK, checkTarget, protectedAppSlugs } from "./planning-state.ts";
import { reviewedPlannerConfig, type ReviewedPlannerConfig } from "./reviewed-planner-config.ts";
import { acquireAttestedSnapshot } from "./endpoint-attestation.ts";
import { planningPreflight } from "./planning-preflight.ts";
import { sourceEvidence, snapshotInput, exclusiveLocalWindow, digest } from "./planner-evidence.ts";
import { continueProtectedPlan } from "./protected-plan-continuation.ts";
import { trustedAppCustody } from "./trusted-app-custody.ts";
import { approvalCommand, githubCandidateApproval } from "./github-candidate-approval.ts";

// The PR110 ordinary provider performs Discord secret removal and trace
// restoration outside the PR117 App custody protocol. That protocol cannot
// express these operations. Do not let an otherwise valid native plan apply
// while silently skipping them. Removing this gate requires a separately
// reviewed custody/profile design and integrated continuation evidence.
export const integrationCodeBlockers = Object.freeze([
  "Discord secret/settings custody and verified trace restoration are unsupported by the protected apply protocol",
]);
export function assertIntegratedCustodyReady(): void {
  requireEvidence(integrationCodeBlockers.length === 0);
}

// Explicit private delivery only; no profile, config cache, minting or discovery.
function readPrivate(path: string | undefined): string {
  requireEvidence(typeof path === "string" && /^\/dev\/shm\/gq-protected\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(path));
  const directory = lstatSync("/dev/shm/gq-protected");
  requireEvidence(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === process.getuid?.() && (directory.mode & 0o777) === 0o700);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireEvidence(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o400 && stat.nlink === 1 && stat.size > 0 && stat.size <= 64 * 1024);
    const value = readFileSync(fd, "utf8").trim();
    unlinkSync(path); // delivery files are one-shot owner-created tmpfs files
    return value;
  } finally { closeSync(fd); }
}

// Config is reviewed source metadata, not an authorization verifier. Even with
// it supplied, GitHub and endpoint observations execute independently.
export const protectedPlanningEntry = (credentialFile: string, reviewed: ReviewedPlannerConfig | undefined = reviewedPlannerConfig,
  env = process.env, transport: typeof fetch = fetch) => Effect.promise(async () => {
  try {
    requireEvidence(reviewed && env.GITHUB_REPOSITORY === "Quick-Release/gq-support" && env.GITHUB_REF === "refs/heads/main" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") && env.DEPLOY_STAGE === reviewed.endpoint.target.stage);
    const config = structuredClone(reviewed);
    checkTarget(config.endpoint.target);
    const { stage } = config.endpoint.target;
    requireEvidence(config.approval.stage === stage && config.app.slug === protectedAppSlugs[stage] &&
      config.window.target.stack === STACK && config.window.target.stage === stage);
    const approval = { ...config.approval, head: env.GITHUB_SHA!, run: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) };
    const repo = new URL("../../", import.meta.url).pathname;
    const { manifest: sourceManifest, ...originalSource } = sourceEvidence(repo, approval.head);
    assertIntegratedCustodyReady(); // before owner-window acquisition or private delivery
    const window = exclusiveLocalWindow(`/dev/shm/gq-support-${stage}-writer.lock`, config.window);
    try {
      const githubToken = readPrivate(env.GITHUB_APPROVAL_READ_TOKEN_FILE);
      const policyCheck = githubCandidateApproval(approval, githubToken, transport);
      try { await policyCheck.preflight(); } finally { policyCheck.close(); }
      const stateBearer = readPrivate(credentialFile);
      const readToken = readPrivate(env.CLOUDFLARE_PLANNING_READ_TOKEN_FILE);
      const deploymentToken = readPrivate(env.CLOUDFLARE_APPLY_TOKEN_FILE);
      const appEnv = { CLOUDFLARE_ACCOUNT_ID: config.endpoint.account, CLOUDFLARE_API_TOKEN: deploymentToken,
        GITHUB_APP_ID: String(config.app.id), GITHUB_APP_CLIENT_ID: config.app.clientId, GITHUB_APP_SLUG: config.app.slug,
        GITHUB_APP_PRIVATE_KEY: readPrivate(env.GITHUB_APP_PRIVATE_KEY_FILE), GITHUB_WEBHOOK_SECRET: readPrivate(env.GITHUB_WEBHOOK_SECRET_FILE),
        ...(env.GITHUB_WEBHOOK_PREVIOUS_SECRET_FILE ? { GITHUB_WEBHOOK_PREVIOUS_SECRET: readPrivate(env.GITHUB_WEBHOOK_PREVIOUS_SECRET_FILE) } : {}),
      };
      const acquire = () => Effect.runPromise(acquireAttestedSnapshot(config.endpoint, stateBearer, readToken, { cloudflare: transport, state: transport }));
      window.check();
      const initial = await snapshotInput(await acquire(), config.endpoint.target);
      const app = await planningPreflight(appEnv, transport, stage);
      requireEvidence(app.appId === config.app.id && app.clientId === config.app.clientId && app.slug === config.app.slug);
      const evidence = { ...originalSource, target: digest({ account: config.endpoint.account, stack: STACK, stage, worker: config.worker, endpoint: config.endpoint, app: config.app, approval: config.approval }),
        state: digest(initial), window: window.binding };
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
      try {
        return await window.runApply(() => continueProtectedPlan({ repo, sourceManifest, input: { ...initial, target: config.endpoint.target, databases: config.endpoint.databases }, app, policy: approval,
          githubToken, github: transport, evidence, signal: controller.signal, checkWindow: window.check,
          broker: { stage, worker: config.worker, stateOrigin: config.endpoint.origin, databases: config.endpoint.databases },
          custody: { cloudflareToken: deploymentToken, stateBearer, cloudflare: transport, state: transport },
          appCustody: (check, dispatch) => trustedAppCustody(appEnv, config.worker, transport, check, dispatch, stage),
          revalidate: async () => {
            window.check();
            const fresh = await snapshotInput(await acquire(), config.endpoint.target);
            const { manifest: _manifest, ...source } = sourceEvidence(repo, approval.head);
            return { ...source, target: evidence.target, state: digest(fresh), window: window.binding };
          },
          publish: (candidate) => {
            // Only sanitized digests/nonce/actions. No props/state/native plan.
            const summary = JSON.stringify({ ...candidate, command: approvalCommand(approval, candidate) });
            requireEvidence(Buffer.byteLength(summary) <= 2048);
            process.stdout.write(summary + "\n");
          },
        }));
      } finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
    } finally { window.close(); }
  } catch { throw refusal(); }
});
export const planningPrerequisites = Object.freeze({ endpointContract: productionEndpointContract, stagingEndpointContract, reviewedPlannerConfig,
  integrationCodeBlockers,
  status: "CODE blocked on integrated Discord custody; LIVE metadata, private delivery, protected runner, writer exclusion and candidate approval also required",
});
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Effect.runPromise(protectedPlanningEntry(process.env.ALCHEMY_STATE_BEARER_FILE ?? "")).catch(() => {
    process.stderr.write("Protected planning evidence unavailable; apply blocked\n"); process.exitCode = 1;
  });
}
