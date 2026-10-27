// Existing App custody owns this transition. No resource or generic secret proxy.
import { isDeepStrictEqual } from "node:util";
import { ACCOUNT, requireEvidence, refusal, type ProtectedStage } from "./planning-state.ts";
import { boundedBody } from "./planning-read.ts";
import { checkedObservability } from "./discord-alert-secret.ts";
import { validObserverToken } from "../src/observer-http.ts";
export interface ObserverCustodyBinding {
  readonly enabled: boolean; readonly stage: ProtectedStage; readonly release: string; readonly commitment: string;
}
export function validateObserverBinding(b: ObserverCustodyBinding): void {
  requireEvidence(b && Object.keys(b).sort().join() === "commitment,enabled,release,stage" && typeof b.enabled === "boolean" &&
    ["staging", "prod"].includes(b.stage) && typeof b.release === "string" && /^[a-f0-9]{40}$/.test(b.release) && typeof b.commitment === "string" && /^[a-f0-9]{64}$/.test(b.commitment));
}
export const disabledObserver = (stage: ProtectedStage, release: string, commitment: string): ObserverCustodyBinding => ({ enabled: false, stage, release, commitment });
export function trustedObserverCustody(env: NodeJS.ProcessEnv, worker: string, binding: ObserverCustodyBinding,
  transport: typeof fetch, check: () => Promise<void>, dispatch: () => void) {
  env = { ...env }; binding = Object.freeze(structuredClone(binding));
  validateObserverBinding(binding);
  requireEvidence(env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT && /^[a-z0-9][a-z0-9-]{0,62}$/.test(worker) &&
    !!env.CLOUDFLARE_API_TOKEN && (binding.enabled ? validObserverToken(env.SUPPORT_OBSERVER_READ_TOKEN) : env.SUPPORT_OBSERVER_READ_TOKEN === undefined));
  const script = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${worker}`;
  const put = (name: string, text: string): [string, string, unknown] => ["PUT", "/secrets", { name, text, type: "secret_text" }];
  const names = ["SUPPORT_OBSERVER_READ_TOKEN", "SUPPORT_OBSERVER_STAGE", "SUPPORT_OBSERVER_RELEASE"];
  const steps: [string, string, unknown?][] = [put("SUPPORT_OBSERVER_ENABLED", "false"), ["GET", "/settings"],
    ...(binding.enabled ? [put(names[0], env.SUPPORT_OBSERVER_READ_TOKEN!), put(names[1], binding.stage), put(names[2], binding.release), put("SUPPORT_OBSERVER_ENABLED", "true")]
      : names.map(name => ["DELETE", `/secrets/${name}`] as [string, string])), ["GET", "/settings"]];
  let used = false, poisoned = false;
  return Object.freeze({ binding, run: async () => {
    try {
      requireEvidence(!used && !poisoned); used = true;
      let before: ReturnType<typeof checkedObservability> | undefined;
      for (const [method, path, body] of steps) {
        await check(); requireEvidence(!poisoned); dispatch();
        const response = await transport(script + path, { method, redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        requireEvidence(!response.redirected && (!response.url || response.url === script + path));
        if (method === "DELETE" && response.status === 404) continue;
        requireEvidence(response.status === 200 && response.headers.get("content-type")?.startsWith("application/json"));
        const value = JSON.parse(Buffer.from(await boundedBody(response, 64 * 1024)).toString());
        requireEvidence(value.success === true);
        if (method !== "GET") continue;
        const obs = checkedObservability(value.result?.observability);
        requireEvidence(obs.traces.enabled === false && Array.isArray(value.result?.bindings));
        const bindings = value.result.bindings as { name: unknown; type: unknown }[];
        requireEvidence(bindings.every(b => b && typeof b.name === "string" && typeof b.type === "string") && new Set(bindings.map(b => b.name)).size === bindings.length);
        if (!before) { before = obs; continue; }
        requireEvidence(isDeepStrictEqual(obs, before));
        requireEvidence(bindings.some(b => b.name === "SUPPORT_OBSERVER_ENABLED" && b.type === "secret_text"));
        for (const name of names) requireEvidence(binding.enabled ? bindings.some(b => b.name === name && b.type === "secret_text") : !bindings.some(b => b.name === name));
      }
      await check(); dispatch();
    } catch { poisoned = true; throw refusal(); }
  } });
}

/** Ordinary deploys remain guarded by the existing protected-stage refusal.
 * Disabled mode still verifies removal before Discord may restore traces. */
export async function provisionObserverReadSecret(worker: string, env = process.env, transport: typeof fetch = fetch): Promise<void> {
  requireEvidence(env.SUPPORT_OBSERVER_ENABLED === undefined || env.SUPPORT_OBSERVER_ENABLED === "false");
  requireEvidence((env.DEPLOY_STAGE === "staging" || env.DEPLOY_STAGE === "prod") && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""));
  const stage = env.DEPLOY_STAGE as ProtectedStage;
  await trustedObserverCustody(env, worker, disabledObserver(stage, env.GITHUB_SHA!, "0".repeat(64)), transport, async () => {}, () => {}).run();
}
