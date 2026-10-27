// Concrete trusted-launcher orchestration. Transport seams are for first-party
// HTTPS and fake HTTP tests, never user-provided authentication assertions.
import { randomBytes } from "node:crypto";
import { runOfflineModule, type ConfinedPlanInput } from "./planning-execution.ts";
import { githubCandidateApproval, type ApprovalPolicy, type ApprovalCandidate } from "./github-candidate-approval.ts";
import { planningApplyBroker, type ApplyBrokerConfig, type ApplyBrokerCustody } from "./planning-apply-broker.ts";
import type { AppSecretCustody } from "./github-app-secret.ts";
import type { SourceManifest } from "./planning-source.ts";
import { digest } from "./planner-evidence.ts";
import type { CandidateBinding } from "./retained-plan.ts";
import type { BrokerOperation } from "./retained-child-channel.ts";
import type { verifyApp } from "./github-app.ts";
import { requireEvidence, refusal, ACCOUNT, STACK } from "./planning-state.ts";

export interface ProtectedContinuation {
  repo: string;
  input: ConfinedPlanInput;
  sourceManifest: SourceManifest;
  app: Awaited<ReturnType<typeof verifyApp>>;
  policy: ApprovalPolicy;
  githubToken: string;
  github: typeof fetch;
  broker: Omit<ApplyBrokerConfig, "app" | "bundle" | "instances">;
  custody: Omit<ApplyBrokerCustody, "app">;
  appCustody(check: () => Promise<void>, dispatch: () => void): AppSecretCustody;
  evidence: Omit<CandidateBinding, "candidate">;
  // Independently reacquires endpoint + state + local source/lockfiles/SQL and
  // enforces the same local lease, rather than accepting a boolean from child.
  revalidate(): Promise<Omit<CandidateBinding, "candidate">>;
  checkWindow(): void;
  signal: AbortSignal;
  publish(evidence: ApprovalCandidate & { binding: CandidateBinding; bundle: string; resources: Record<string, string> }): void;
}

/** Authentication is asynchronous: local authorization must still hold when
 * its response arrives, immediately before granting a broker dispatch. */
export async function verifyDispatch(signal: AbortSignal, candidate: ApprovalCandidate, checkWindow: () => void,
  authenticate: () => Promise<boolean>, now = Date.now): Promise<void> {
  const local = () => { requireEvidence(!signal.aborted && now() < candidate.expiresAt); checkWindow(); };
  local();
  requireEvidence(await authenticate());
  local();
}

export async function continueProtectedPlan(config: ProtectedContinuation) {
  // Detach caller-owned metadata before the first asynchronous boundary.
  config = { ...config, policy: structuredClone(config.policy), input: structuredClone(config.input), app: structuredClone(config.app),
    evidence: Object.freeze({ ...config.evidence }), broker: structuredClone(config.broker), sourceManifest: structuredClone(config.sourceManifest) };
  requireEvidence(Object.keys(config.evidence).sort().join() === "lockfiles,migrations,source,state,target,window" &&
    Object.values(config.evidence).every((value) => /^[a-f0-9]{64}$/.test(value)));
  const initial = config.input.rows as Record<string, Record<string, Record<string, { instanceId: string; attr: { accountId: string; workerName: string } }>>>;
  const worker = initial?.[STACK]?.prod?.Worker;
  const secret = initial?.[STACK]?.prod?.GitHubAppSecret;
  requireEvidence(worker?.attr.accountId === ACCOUNT && worker.attr.workerName === config.broker.worker && worker.instanceId && secret?.instanceId);
  const instances = { Worker: worker.instanceId, GitHubAppSecret: secret.instanceId };
  const nonce = randomBytes(32).toString("hex");
  let binding = Object.freeze({ ...config.evidence, candidate: digest({ ...config.evidence, nonce, run: config.policy.run, attempt: config.policy.attempt, head: config.policy.head }) });
  const approval = githubCandidateApproval(config.policy, config.githubToken, config.github);
  let candidate: ApprovalCandidate | undefined;
  let authorized = false, ready = false, attempted = false;
  let alive = config.signal;
  const dispatch = () => {
    requireEvidence(!alive.aborted && authorized && candidate && Date.now() < candidate.expiresAt);
    config.checkWindow();
  };
  const check = async () => {
    requireEvidence(!alive.aborted && authorized && candidate);
    await verifyDispatch(alive, candidate, config.checkWindow, () => approval.check(candidate!));
    dispatch();
  };
  let broker: ReturnType<typeof planningApplyBroker> | undefined;
  const revoke = () => { authorized = false; broker?.close(); approval.close(); };
  const signals = new Set<AbortSignal>();
  const watch = (signal: AbortSignal) => {
    if (signals.has(signal)) return;
    signals.add(signal); signal.addEventListener("abort", revoke, { once: true });
    if (signal.aborted) revoke();
  };
  watch(config.signal);
  const lifetimeMs = 15 * 60_000;
  try {
    const result = await runOfflineModule(config.repo, "deploy/retained-planning-child.ts", {
      ...config.input, app: config.app, binding, nonce, sourceManifest: config.sourceManifest,
    }, { lifetimeMs, signal: config.signal, message: async (raw, runtimeSignal) => {
      watch(runtimeSignal);
      alive = AbortSignal.any([config.signal, runtimeSignal]);
      requireEvidence(!alive.aborted);
      const message = raw as BrokerOperation & { event?: string; binding?: CandidateBinding; nonce?: string; resources?: Record<string, string>; bundle?: string };
      requireEvidence(message && typeof message === "object");
      if (message.event === "ready") {
        requireEvidence(typeof message.bundle === "string" && /^[a-f0-9]{64}$/.test(message.bundle));
        const expected = { ...binding, candidate: digest({ seed: binding.candidate, bundle: message.bundle }) };
        requireEvidence(!ready && Object.keys(message).sort().join() === "binding,bundle,event,nonce,resources" &&
          JSON.stringify(message.binding) === JSON.stringify(expected) && message.nonce === nonce && message.resources &&
          Object.keys(message.resources).sort().join() === "GitHubAppSecret,SupportDB,SupportLedger,Worker" &&
          // Minimal audited apply profile: no pending D1 updates, no bootstrap.
          message.resources.SupportDB === "noop" && message.resources.SupportLedger === "noop" &&
          message.resources.Worker === "update" && message.resources.GitHubAppSecret === "update");
        requireEvidence(Buffer.byteLength(JSON.stringify(message)) <= 2048);
        binding = Object.freeze(expected);
        broker = planningApplyBroker({ ...config.broker, app: config.app, bundle: message.bundle, instances }, { ...config.custody, app: config.appCustody(check, dispatch) }, check, dispatch);
        ready = true;
        const readyAt = Date.now(); candidate = Object.freeze({ candidate: binding.candidate, nonce, readyAt, expiresAt: readyAt + 10 * 60_000 });
        config.publish({ ...candidate, binding, bundle: message.bundle, resources: message.resources }); return null;
      }
      if (message.op === "authorize") {
        requireEvidence(ready && candidate && !attempted && Object.keys(message).sort().join() === "id,op"); attempted = true;
        // Bounded application polling; missing/uncertain evidence poisons this
        // process. No native plan leaves it and no subsequent job replans.
        for (;;) {
          config.checkWindow(); requireEvidence(!alive.aborted && Date.now() < candidate.expiresAt);
          if (await approval.check(candidate)) break;
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); alive.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 5_000); alive.addEventListener("abort", done, { once: true });
          });
        }
        requireEvidence(await approval.check(candidate));
        const fresh = await config.revalidate();
        requireEvidence(JSON.stringify(fresh) === JSON.stringify(config.evidence));
        config.checkWindow(); requireEvidence(!alive.aborted && Date.now() < candidate.expiresAt);
        authorized = true; return binding;
      }
      requireEvidence(authorized && broker && message.op !== undefined);
      const { id, ...operation } = raw as Record<string, unknown>;
      requireEvidence(Number.isSafeInteger(id));
      return await broker.handle(operation as Exclude<BrokerOperation, { op: "authorize" }>);
    } });
    // Normal child exit revokes its runtime signal too. A committed output and
    // verified child result establish completion; no dispatch grant stays open.
    requireEvidence(!config.signal.aborted && broker?.outcome().completed && result === '{"status":"applied"}');
    return Object.freeze({ status: "applied" as const, candidate: binding.candidate });
  } catch { throw refusal(); }
  finally {
    revoke();
    for (const signal of signals) signal.removeEventListener("abort", revoke);
  }
}
