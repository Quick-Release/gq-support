// Apply-only, following App/webhook custody: no secret values in Alchemy props/state.
import { SUPPORT_ACCOUNT_ID } from "./github-app.ts";
import { webhookURL } from "../src/discord-alerts.ts";

export function validateDiscordAlertConfig(env: NodeJS.ProcessEnv): void {
  if (env.DISCORD_ALERTS_ENABLED && !["true", "false"].includes(env.DISCORD_ALERTS_ENABLED)) throw new Error("Discord alert configuration invalid");
  if (env.DISCORD_ALERTS_ENABLED === "true" &&
      (!webhookURL(env.DISCORD_ALERT_WEBHOOK_URL) || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""))) {
    throw new Error("Discord alert configuration invalid");
  }
}
export async function provisionDiscordAlertSecret(workerName: string, env = process.env, request = fetch): Promise<void> {
  validateDiscordAlertConfig(env);
  const enabled = env.DISCORD_ALERTS_ENABLED === "true";
  const base = `https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}/secrets`;
  try {
    if (!env.CLOUDFLARE_API_TOKEN) throw new Error();
    const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" };
    const settings = async () => {
      const response = await request(`${base.slice(0, -8)}/settings`, {
        headers, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json() as { success?: boolean; result?: {
        bindings?: Array<{ name: string; type: string }>;
        observability?: { enabled?: boolean; traces?: { enabled?: boolean }; [key: string]: unknown };
      } };
      if (!response.ok || body.success !== true || !body.result) throw new Error();
      return body.result;
    };
    if (enabled) {
      if ((await settings()).observability?.traces?.enabled !== false) throw new Error();
    }
    // Disable first. Enable only after URL and revision binding are installed.
    for (const [name, value] of [
      ["DISCORD_ALERTS_ENABLED", "false"],
      ["DISCORD_ALERT_WEBHOOK_URL", enabled ? env.DISCORD_ALERT_WEBHOOK_URL : undefined],
      ["DISCORD_ALERT_RELEASE", enabled ? env.GITHUB_SHA : undefined],
      ...(enabled ? [["DISCORD_ALERTS_ENABLED", "true"]] : []),
    ]) {
      const response = await request(value ? base : `${base}/${name}`, {
        method: value ? "PUT" : "DELETE", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        body: value ? JSON.stringify({ name, type: "secret_text", text: value }) : undefined,
      });
      if (!value && response.status === 404) continue;
      if (!response.ok || (await response.json() as { success: boolean }).success !== true) throw new Error();
    }
    if (!enabled) {
      // Worker upload temporarily keeps traces off even during disablement.
      // Only restore them after the API confirms removal of the credential.
      const removed = await settings();
      if (!Array.isArray(removed.bindings) || removed.bindings.some((binding) =>
        ["DISCORD_ALERT_WEBHOOK_URL", "DISCORD_ALERT_RELEASE"].includes(binding.name)) ||
        removed.observability?.enabled !== true) throw new Error();
      const response = await request(`${base.slice(0, -8)}/script-settings`, {
        method: "PATCH", headers, redirect: "error", signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ observability: { ...removed.observability,
          traces: { ...removed.observability.traces, enabled: true } } }),
      });
      if (!response.ok || (await response.json() as { success: boolean }).success !== true) throw new Error();
      const verified = await settings();
      if (verified.observability?.traces?.enabled !== true || !Array.isArray(verified.bindings) ||
          verified.bindings.some((binding) => ["DISCORD_ALERT_WEBHOOK_URL", "DISCORD_ALERT_RELEASE"].includes(binding.name))) throw new Error();
    }
  } catch { throw new Error("Discord alert Worker secret update failed"); }
}
