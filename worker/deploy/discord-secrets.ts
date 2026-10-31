// Apply-only: webhook URLs are credentials and never enter the Alchemy resource graph or outputs.
import { SUPPORT_ACCOUNT_ID } from "./github-app.ts";
import { discordDestinations } from "../src/notifications.ts";

/** The Worker secrets for the two Discord destinations (src/notifications.ts). */
export const DISCORD_SECRETS = {
  support_requests: "DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL",
  operational_incidents: "DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL",
} as const;

/**
 * Each destination is optional, but a value that is set must be a Discord
 * webhook URL, and the two channels must use different webhooks. Anything else
 * stops the deployment rather than silently disabling or merging a channel.
 */
export function validateDiscordSecrets(env: NodeJS.ProcessEnv): void {
  const requests = env[DISCORD_SECRETS.support_requests] ?? "";
  const incidents = env[DISCORD_SECRETS.operational_incidents] ?? "";
  const configured = discordDestinations(requests, incidents);
  if ((requests && !configured.support_requests) || (incidents && !configured.operational_incidents)) {
    throw new Error("Discord notification configuration invalid");
  }
}

/** Uploads each configured webhook as a Worker secret and removes an unset one, closing that channel. */
export async function provisionDiscordSecrets(workerName: string, env = process.env, request = fetch): Promise<void> {
  validateDiscordSecrets(env);
  const base = `https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}/secrets`;
  try {
    if (!env.CLOUDFLARE_API_TOKEN) throw new Error();
    for (const name of Object.values(DISCORD_SECRETS)) {
      const value = env[name];
      const response = await request(value ? base : `${base}/${name}`, {
        method: value ? "PUT" : "DELETE",
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        body: value ? JSON.stringify({ name, type: "secret_text", text: value }) : undefined,
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!value && response.status === 404) continue;
      if (!response.ok || (await response.json() as { success: boolean }).success !== true) throw new Error();
    }
  } catch {
    throw new Error("Discord notification Worker secret update failed");
  }
}
