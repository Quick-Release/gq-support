// Apply-only: secret values never enter the Alchemy resource graph or outputs.
import { SUPPORT_ACCOUNT_ID } from "./github-app.ts";

export function validateWebhookSecrets(env: NodeJS.ProcessEnv, expectedAppId?: number): void {
  if (!env.GITHUB_WEBHOOK_SECRET || !/^[1-9][0-9]*$/.test(env.GITHUB_APP_ID ?? "") ||
      !Number.isSafeInteger(Number(env.GITHUB_APP_ID)) ||
      (expectedAppId !== undefined && String(expectedAppId) !== env.GITHUB_APP_ID)) {
    throw new Error("GitHub webhook configuration invalid");
  }
}

export async function provisionWebhookSecrets(workerName: string, appId: number, env = process.env, request = fetch): Promise<void> {
  validateWebhookSecrets(env, appId);
  const base = `https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}/secrets`;
  try {
    if (!env.CLOUDFLARE_API_TOKEN) throw new Error();
    for (const [name, value] of [
      ["GITHUB_WEBHOOK_SECRET", env.GITHUB_WEBHOOK_SECRET],
      ["GITHUB_WEBHOOK_PREVIOUS_SECRET", env.GITHUB_WEBHOOK_PREVIOUS_SECRET],
    ]) {
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
    throw new Error("GitHub webhook Worker secret update failed");
  }
}
