// Apply-only custody. Neither private configuration nor response bodies enter the graph.
import { isDeepStrictEqual } from "node:util";
import { SUPPORT_ACCOUNT_ID } from "./github-app.ts";
import { webhookURL } from "../src/discord-alerts.ts";

export interface DiscordCustodyBinding {
  readonly enabled: boolean;
  readonly release: string;
  // Random session identifier, never a digest of the URL/token.
  readonly commitment: string;
}
export function validateDiscordBinding(value: DiscordCustodyBinding): void {
  if (!value || Object.keys(value).sort().join() !== "commitment,enabled,release" ||
      typeof value.enabled !== "boolean" || !/^[a-f0-9]{40}$/.test(value.release) ||
      !/^[a-f0-9]{64}$/.test(value.commitment)) throw new Error("Discord alert configuration invalid");
}
export function validateDiscordAlertConfig(env: NodeJS.ProcessEnv): void {
  if (env.DISCORD_ALERTS_ENABLED && !["true", "false"].includes(env.DISCORD_ALERTS_ENABLED)) throw new Error("Discord alert configuration invalid");
  if (env.DISCORD_ALERTS_ENABLED === "true" &&
      (!webhookURL(env.DISCORD_ALERT_WEBHOOK_URL) || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""))) {
    throw new Error("Discord alert configuration invalid");
  }
}
interface Observability {
  enabled: boolean;
  logs: { enabled: boolean; [key: string]: unknown };
  traces: { enabled: boolean; [key: string]: unknown };
  [key: string]: unknown;
}
// Fail closed on unrecognized API fields; never reflect arbitrary response data into PATCH.
export function checkedObservability(value: unknown): Observability {
  const check = (v: unknown, keys: string[]) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    for (const [key, field] of Object.entries(v)) {
      if (!keys.includes(key)) throw new Error();
      if (["enabled", "persist", "invocation_logs", "redact_query_string"].includes(key) && typeof field !== "boolean") throw new Error();
      if (key === "head_sampling_rate" && (typeof field !== "number" || !Number.isFinite(field) || field < 0 || field > 1)) throw new Error();
      if (key === "destinations" && (!Array.isArray(field) || field.some((item) => item !== "cloudflare"))) throw new Error();
    }
  };
  check(value, ["enabled", "head_sampling_rate", "redact_query_string", "logs", "traces", "issues"]);
  const obs = structuredClone(value) as Observability;
  check(obs.logs, ["enabled", "head_sampling_rate", "invocation_logs", "persist", "destinations"]);
  check(obs.traces, ["enabled", "head_sampling_rate", "persist", "destinations", "propagation_policy"]);
  if (obs.traces.propagation_policy === null) delete obs.traces.propagation_policy;
  if (obs.traces.propagation_policy !== undefined && !["authenticated", "accept"].includes(String(obs.traces.propagation_policy))) throw new Error();
  if (obs.issues !== undefined) check(obs.issues, ["enabled"]);
  if (obs.enabled !== true || obs.logs.enabled !== true || typeof obs.traces.enabled !== "boolean") throw new Error();
  return obs;
}
export async function provisionDiscordAlertSecret(workerName: string, env = process.env, request = fetch): Promise<void> {
  // Freeze private configuration before any await (including an ambient ordinary deployment).
  env = { ...env };
  validateDiscordAlertConfig(env);
  const enabled = env.DISCORD_ALERTS_ENABLED === "true";
  const script = `https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}`;
  try {
    if (!env.CLOUDFLARE_API_TOKEN) throw new Error();
    const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
    const settings = async () => {
      const response = await request(`${script}/settings`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const body = await response.json() as { success?: boolean; result?: { bindings?: Array<{ name: string; type: string }>; observability?: unknown } };
      if (!response.ok || body.success !== true || !Array.isArray(body.result?.bindings)) throw new Error();
      const bindings = body.result.bindings;
      if (bindings.some((b) => !b || typeof b.name !== "string" || typeof b.type !== "string") || new Set(bindings.map((b) => b.name)).size !== bindings.length) throw new Error();
      return { bindings, observability: checkedObservability(body.result.observability) };
    };
    const put = async (name: string, text?: string) => {
      const response = await request(text === undefined ? `${script}/secrets/${name}` : `${script}/secrets`, {
        method: text === undefined ? "DELETE" : "PUT", headers, redirect: "error", signal: AbortSignal.timeout(15_000),
        body: text === undefined ? undefined : JSON.stringify({ name, type: "secret_text", text }),
      });
      if (text === undefined && response.status === 404) return;
      if (!response.ok || (await response.json() as { success?: boolean }).success !== true) throw new Error();
    };
    // Disable before inspecting or changing custody, even when enablement was requested.
    await put("DISCORD_ALERTS_ENABLED", "false");
    const before = await settings();
    if (before.observability.traces.enabled !== false) throw new Error();
    if (enabled) {
      await put("DISCORD_ALERT_WEBHOOK_URL", env.DISCORD_ALERT_WEBHOOK_URL);
      await put("DISCORD_ALERT_RELEASE", env.GITHUB_SHA);
      await put("DISCORD_ALERTS_ENABLED", "true");
    } else {
      await put("DISCORD_ALERT_WEBHOOK_URL");
      await put("DISCORD_ALERT_RELEASE");
    }
    const verified = await settings();
    const names = ["DISCORD_ALERT_WEBHOOK_URL", "DISCORD_ALERT_RELEASE"];
    const bound = (name: string) => verified.bindings.some((b) => b.name === name && b.type === "secret_text");
    if (!bound("DISCORD_ALERTS_ENABLED") || names.some((name) => enabled ? !bound(name) : verified.bindings.some((b) => b.name === name)) ||
        !isDeepStrictEqual(verified.observability, before.observability)) throw new Error();
    if (!enabled) {
      const observability = { ...verified.observability, traces: { ...verified.observability.traces, enabled: true } };
      const response = await request(`${script}/script-settings`, { method: "PATCH", headers, redirect: "error", signal: AbortSignal.timeout(15_000), body: JSON.stringify({ observability }) });
      if (!response.ok || (await response.json() as { success?: boolean }).success !== true) throw new Error();
      const restored = await settings();
      if (!isDeepStrictEqual(restored.observability, observability) || !isDeepStrictEqual(restored.bindings, verified.bindings)) throw new Error();
    }
  } catch { throw new Error("Discord alert Worker secret update failed"); }
}
