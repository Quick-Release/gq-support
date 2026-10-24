// Deployment-only: never import this module from the Worker entrypoint.
import { createHash, createPublicKey, webcrypto } from "node:crypto";

export const SUPPORT_ACCOUNT_ID = "8f38791a8c37b182239af2a385ab3c31";
const slugs = { staging: "getquick-support-staging", prod: "getquick-support" };
const permissions = { issues: "write", metadata: "read" };
// GitHub delivers `installation` and `installation_repositories` automatically.
// Installation target is selected separately and audited in the UI; /app's
// events array reports only the repository subscriptions below.
const events = ["issues", "public", "repository"];

export function appConfig(stage: string, env: NodeJS.ProcessEnv) {
  if (stage !== "staging" && stage !== "prod") throw new Error("Expected staging or prod");
  const clientId = env.GITHUB_APP_CLIENT_ID;
  if (!clientId || !/^[A-Za-z0-9_.-]+$/.test(clientId)) throw new Error("Missing GitHub App client ID");
  if (env.GITHUB_APP_SLUG !== slugs[stage]) throw new Error("Wrong GitHub App for stage");
  if (env.CLOUDFLARE_ACCOUNT_ID !== SUPPORT_ACCOUNT_ID) throw new Error("Wrong Cloudflare account");
  return { stage, clientId, slug: slugs[stage] };
}

export type AppConfig = ReturnType<typeof appConfig>;

/** Verifies PKCS#8 Web Crypto import and proves the key belongs to the pinned App. */
export async function verifyApp(config: AppConfig, pem: string, request = fetch) {
  try {
    if (!/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\s*$/.test(pem)) {
      throw new Error();
    }
    const der = Buffer.from(pem.replace(/-----[^\n]+-----|\s/g, ""), "base64");
    const key = await webcrypto.subtle.importKey(
      "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
    );
    if ((key.algorithm as webcrypto.RsaHashedKeyAlgorithm).modulusLength < 2048) throw new Error();
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: config.clientId })}`;
    const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(input));
    const response = await request("https://api.github.com/app", {
      headers: {
        Authorization: `Bearer ${input}.${Buffer.from(signature).toString("base64url")}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "getquick-support-provisioning",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error();
    const app = await response.json() as {
      id: number; slug: string; client_id: string; owner: { login: string; type: string };
      permissions: Record<string, string>; events: string[];
    };
    if (!Number.isSafeInteger(app.id) || app.id <= 0 || app.slug !== config.slug || app.client_id !== config.clientId ||
        app.owner.login !== "Quick-Release" || app.owner.type !== "Organization" ||
        JSON.stringify(Object.entries(app.permissions).sort()) !== JSON.stringify(Object.entries(permissions).sort()) ||
        JSON.stringify([...app.events].sort()) !== JSON.stringify(events)) throw new Error();
    const publicKey = createPublicKey(pem).export({ type: "spki", format: "der" });
    return { ...config, appId: app.id, fingerprint: createHash("sha256").update(publicKey).digest("base64") };
  } catch {
    // Never propagate crypto, transport or provider errors: they can contain
    // key material, Authorization headers or raw provider responses.
    throw new Error("GitHub App verification failed (key, identity, permissions or events)");
  }
}

/** Only called by the Alchemy provider during apply; no secret enters props or outputs. */
export async function provisionAppKey(stage: string, workerName: string, env = process.env, request = fetch) {
  const config = appConfig(stage, env);
  const pem = env.GITHUB_APP_PRIVATE_KEY;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!pem || !token) throw new Error("Missing GitHub App or Cloudflare deployment secret");
  const verified = await verifyApp(config, pem, request);
  try {
    const response = await request(
      `https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}/secrets`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "GITHUB_APP_PRIVATE_KEY", type: "secret_text", text: pem }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok || (await response.json() as { success: boolean }).success !== true) throw new Error();
  } catch {
    throw new Error("GitHub App Worker secret upload failed");
  }
  return verified;
}
