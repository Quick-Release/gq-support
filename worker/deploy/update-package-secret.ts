// Apply-only: the package read token is a credential and never enters the Alchemy resource graph or outputs.
import { SUPPORT_ACCOUNT_ID } from "./github-app.ts";
import { githubReleasePackages } from "../src/package-source.ts";

/** The Worker secret native updates read approved packages with (src/package-source.ts). */
export const UPDATE_PACKAGE_SECRET = "UPDATE_PACKAGE_TOKEN";

/**
 * Uploads the stage's narrow, read-only package token as a Worker secret, or
 * removes it when unset, which closes native updates for the stage. A value
 * that is set but malformed stops the deployment.
 */
export async function provisionUpdatePackageSecret(workerName: string, env: NodeJS.ProcessEnv = process.env, request = fetch): Promise<void> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}/secrets`;
  const value = env[UPDATE_PACKAGE_SECRET] ?? "";
  try {
    if (!env.CLOUDFLARE_API_TOKEN || (value && !githubReleasePackages({ token: value }))) throw new Error();
    const response = await request(value ? base : `${base}/${UPDATE_PACKAGE_SECRET}`, {
      method: value ? "PUT" : "DELETE",
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: value ? JSON.stringify({ name: UPDATE_PACKAGE_SECRET, type: "secret_text", text: value }) : undefined,
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!value && response.status === 404) return;
    if (!response.ok || (await response.json() as { success: boolean }).success !== true) throw new Error();
  } catch {
    throw new Error("Native update package token Worker secret update failed");
  }
}
