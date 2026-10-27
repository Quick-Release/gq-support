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
    if (enabled) {
      const response = await request(`${base.slice(0, -8)}/settings`, {
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      const settings = await response.json() as { success?: boolean; result?: { observability?: { traces?: { enabled?: boolean } } } };
      if (!response.ok || settings.success !== true || settings.result?.observability?.traces?.enabled !== false) throw new Error();
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
  } catch { throw new Error("Discord alert Worker secret update failed"); }
}
