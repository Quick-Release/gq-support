// Concrete trusted-launcher orchestration. Transport seams are for first-party
// HTTPS and fake HTTP tests, never user-provided authentication assertions.
import { validateDiscordBinding } from "./discord-alert-secret.ts";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { ResourceState } from "alchemy/State/ResourceState";
import { d1MigrationGrant, migrationSummary, sha256 } from "./d1-migration-profile.ts";
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
import { requireEvidence, refusal, ACCOUNT, STACK, validateRow, checkInputTarget, protectedAppSlugs } from "./planning-state.ts";

export interface ProtectedContinuation {
  repo: string;
  input: ConfinedPlanInput;
  sourceManifest: SourceManifest;
  app: Awaited<ReturnType<typeof verifyApp>>;
  policy: ApprovalPolicy;
  githubToken: string;
  github: typeof fetch;
  broker: Omit<ApplyBrokerConfig, "app" | "bundle" | "instances" | "migrations">;
  custody: Omit<ApplyBrokerCustody, "app">;
  appCustody(check: () => Promise<void>, dispatch: () => void): AppSecretCustody;
  evidence: Omit<CandidateBinding, "candidate">;
  // Independently reacquires endpoint + state + local source/lockfiles/SQL and
  // enforces the same local lease, rather than accepting a boolean from child.
  revalidate(): Promise<Omit<CandidateBinding, "candidate">>;
  checkWindow(): void;
  signal: AbortSignal;
  publish(evidence: ApprovalCandidate & { discord: import("./discord-alert-secret.ts").DiscordCustodyBinding; binding: CandidateBinding; bundle: string; resources: Record<string, string>; migrations: ReturnType<typeof migrationSummary> }): void;
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
  validateDiscordBinding(config.broker.discord);
  Object.freeze(config.broker.discord);
  requireEvidence(config.broker.discord.release === config.policy.head);
  checkInputTarget(config.input, config.input.target);
  const { stage } = config.input.target;
  requireEvidence(config.policy.stage === stage && config.broker.stage === stage && config.app.stage === stage &&
    config.app.slug === protectedAppSlugs[stage]);
  const initial = config.input.rows as Record<string, Record<string, Record<string, { instanceId: string; props: { stage?: string; workerName?: string }; attr: { accountId: string; workerName: string } }>>>;
  const worker = initial?.[STACK]?.[stage]?.Worker;
  const secret = initial?.[STACK]?.[stage]?.GitHubAppSecret;
  requireEvidence(worker?.attr.accountId === ACCOUNT && worker.attr.workerName === config.broker.worker && worker.instanceId && secret?.instanceId);
  requireEvidence(secret.props.stage === stage && secret.props.workerName === config.broker.worker &&
    JSON.stringify(config.broker.databases) === JSON.stringify(config.input.databases));
  // Reconstruct grants from trusted tracked source, never from child-supplied
  // SQL or a serialized plan. Source and fresh state are revalidated at handoff.
  const migrations = config.broker.databases.flatMap((identity) => {
    const dir = identity.fqn === "SupportDB" ? "migrations" : "ledger-migrations";
    const directory = join(config.repo, "worker", dir);
    const entries = readdirSync(directory);
    requireEvidence(entries.every((name) => (name.endsWith(".sql") || name === "checksums.txt") && lstatSync(join(directory, name)).isFile() && !lstatSync(join(directory, name)).isSymbolicLink()));
    const files = Object.fromEntries(entries.filter((name) => name.endsWith(".sql")).map((name) => {
      const sql = readFileSync(join(directory, name), "utf8");
      requireEvidence(config.sourceManifest.some(([path, hash]) => path === `worker/${dir}/${name}` && hash === sha256(sql)));
      return [name, sql];
    }));
    const original = initial[STACK][stage][identity.fqn];
    validateRow(original, identity.fqn); // reject old/adopting keys before wire encoding can omit undefined
    const row = JSON.parse(JSON.stringify(original)) as ResourceState;
    requireEvidence(row.props?.migrations === `./${dir}`);
    const grant = d1MigrationGrant(identity, row, files);
    return grant ? [grant] : [];
  });
  const summary = migrationSummary(migrations);
  const instances = { Worker: worker.instanceId, GitHubAppSecret: secret.instanceId };
  const nonce = randomBytes(32).toString("hex");
  let binding = Object.freeze({ ...config.evidence, candidate: digest({ ...config.evidence, nonce, stage, app: config.app, broker: config.broker, policy: config.policy, run: config.policy.run, attempt: config.policy.attempt, head: config.policy.head }) });
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
      ...config.input, release: config.policy.head, app: config.app, binding, nonce, sourceManifest: config.sourceManifest,
    }, { lifetimeMs, signal: config.signal, message: async (raw, runtimeSignal) => {
      watch(runtimeSignal);
      alive = AbortSignal.any([config.signal, runtimeSignal]);
      requireEvidence(!alive.aborted);
      const message = raw as BrokerOperation & { event?: string; binding?: CandidateBinding; nonce?: string; resources?: Record<string, string>; migrations?: ReturnType<typeof migrationSummary>; bundle?: string };
      requireEvidence(message && typeof message === "object");
      if (message.event === "ready") {
        requireEvidence(typeof message.bundle === "string" && /^[a-f0-9]{64}$/.test(message.bundle));
        const expected = { ...binding, candidate: digest({ seed: binding.candidate, bundle: message.bundle, migrations: summary }) };
        requireEvidence(!ready && Object.keys(message).sort().join() === "binding,bundle,event,migrations,nonce,resources" &&
          JSON.stringify(message.binding) === JSON.stringify(expected) && message.nonce === nonce && message.resources &&
          Object.keys(message.resources).sort().join() === "GitHubAppSecret,SupportDB,SupportLedger,Worker" &&
          JSON.stringify(message.migrations) === JSON.stringify(summary) &&
          message.resources.SupportDB === (summary.SupportDB ? "update" : "noop") && message.resources.SupportLedger === (summary.SupportLedger ? "update" : "noop") &&
          message.resources.Worker === "update" && message.resources.GitHubAppSecret === "update");
        requireEvidence(Buffer.byteLength(JSON.stringify(message)) <= 2048);
        binding = Object.freeze(expected);
        broker = planningApplyBroker({ ...config.broker, app: config.app, bundle: message.bundle, instances, migrations }, { ...config.custody, app: config.appCustody(check, dispatch) }, check, dispatch);
        ready = true;
        const readyAt = Date.now(); candidate = Object.freeze({ candidate: binding.candidate, nonce, readyAt, expiresAt: readyAt + 10 * 60_000 });
        config.publish({ ...candidate, discord: config.broker.discord, binding, bundle: message.bundle, resources: message.resources, migrations: summary }); return null;
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
