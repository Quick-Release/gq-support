/** Read-only custody check. Called through a service binding, never HTTP. */
export async function checkBoundGitHubAppKey(
  pem: unknown,
  expected: { clientId: string; slug: string },
  request = fetch,
) {
  try {
    if (typeof pem !== "string" || !pem.startsWith("-----BEGIN PRIVATE KEY-----") ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(expected.clientId) ||
        !["getquick-support-staging", "getquick-support"].includes(expected.slug)) throw new Error();
    const binary = atob(pem.replace(/-----[^\n]+-----|\s/g, ""));
    const der = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
    );
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
    const now = Math.floor(Date.now() / 1000);
    const input = `${json({ alg: "RS256", typ: "JWT" })}.${json({ iat: now - 60, exp: now + 540, iss: expected.clientId })}`;
    // A new signature and GitHub request on every invocation; no token cache.
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
    const response = await request("https://api.github.com/app", {
      headers: {
        Authorization: `Bearer ${input}.${encode(new Uint8Array(signature))}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "getquick-support-key-custody-check",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 32_768) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const app = JSON.parse(new TextDecoder().decode(bytes));
    if (app.slug !== expected.slug || app.client_id !== expected.clientId ||
        app.owner?.login !== "Quick-Release" || app.owner?.type !== "Organization" ||
        !Number.isSafeInteger(app.id)) throw new Error();
    const spki = createPublicKey(pem).export({ format: "der", type: "spki" });
    const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(spki).buffer);
    const fingerprint = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return { ok: true as const, appId: app.id as number, clientId: expected.clientId, slug: expected.slug, fingerprint };
  } catch {
    // Never return a key, JWT, provider response or exception to the caller.
    return { ok: false as const };
  }
}
import { createPublicKey } from "node:crypto";
