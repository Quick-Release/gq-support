import { generateKeyPairSync, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { appConfig, provisionAppKey, SUPPORT_ACCOUNT_ID, verifyApp } from "../deploy/github-app.ts";

// Ephemeral test material only; no PEM fixtures or live credentials on disk.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const env = {
  GITHUB_APP_CLIENT_ID: "Iv1.staging",
  GITHUB_APP_SLUG: "getquick-support-staging",
  GITHUB_APP_PRIVATE_KEY: pem,
  CLOUDFLARE_ACCOUNT_ID: SUPPORT_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: "test-deployment-token",
};
const app = {
  slug: "getquick-support-staging", client_id: "Iv1.staging",
  owner: { login: "Quick-Release", type: "Organization" },
  permissions: { issues: "write", metadata: "read" },
  events: ["repository", "issues", "public"],
};

describe("GitHub App provisioning boundary", () => {
  it("imports PKCS#8 for Web Crypto and sends a verifiable, short-lived App JWT", async () => {
    const result = await verifyApp(appConfig("staging", env), pem, async (url, init) => {
      expect(url).toBe("https://api.github.com/app");
      const jwt = new Headers(init?.headers).get("Authorization")!.slice(7);
      const [header, payload, signature] = jwt.split(".");
      expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      expect(claims.iss).toBe("Iv1.staging");
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
      expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
      expect(init?.redirect).toBe("error");
      return Response.json(app);
    });
    expect(result.fingerprint).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it("denies a staging App on prod and any other Cloudflare account", () => {
    expect(() => appConfig("prod", env)).toThrow("Wrong GitHub App");
    expect(() => appConfig("staging", { ...env, CLOUDFLARE_ACCOUNT_ID: "other" })).toThrow("Wrong Cloudflare account");
    expect(() => appConfig("dev_valerio", env)).toThrow("Expected staging or prod");
  });

  it.each([
    { ...app, permissions: { ...app.permissions, contents: "read" } },
    { ...app, permissions: { issues: "read", metadata: "read" } },
    { ...app, events: [...app.events, "issue_comment"] },
    { ...app, events: ["issues", "repository"] },
    { ...app, slug: "getquick-support" },
    { ...app, client_id: "Iv1.prod" },
    { ...app, owner: { login: "someone-else", type: "User" } },
  ])("denies registration drift before uploading any key: %j", async (registration) => {
    let calls = 0;
    await expect(provisionAppKey("staging", "stage-worker", env, async () => {
      calls++;
      return Response.json(registration);
    })).rejects.toThrow("GitHub App verification failed");
    expect(calls).toBe(1);
  });

  it("rejects unconverted PKCS#1 without making a network call", async () => {
    const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
    await expect(verifyApp(appConfig("staging", env), pkcs1, async () => {
      throw new Error("must not call GitHub");
    })).rejects.toThrow("GitHub App verification failed");
  });

  it("verifies the runbook's one-time OpenSSL PKCS#1 to PKCS#8 conversion", async () => {
    const conversion = spawnSync("openssl", ["pkcs8", "-topk8", "-nocrypt"], {
      input: privateKey.export({ format: "pem", type: "pkcs1" }), encoding: "utf8",
    });
    expect(conversion.status).toBe(0);
    const original = await verifyApp(appConfig("staging", env), pem, async () => Response.json(app));
    const converted = await verifyApp(appConfig("staging", env), conversion.stdout, async () => Response.json(app));
    expect(converted.fingerprint).toBe(original.fingerprint);
  });

  it("uploads only a Worker secret and returns only public evidence for Alchemy state", async () => {
    const calls: string[] = [];
    const result = await provisionAppKey("staging", "stage-worker", env, async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1) return Response.json(app);
      expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/stage-worker/secrets`);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({ name: "GITHUB_APP_PRIVATE_KEY", type: "secret_text", text: pem });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-deployment-token");
      return Response.json({ success: true });
    });
    expect(calls).toHaveLength(2);
    expect(Object.keys(result).sort()).toEqual(["clientId", "fingerprint", "slug", "stage"]);
  });

  it.each(["github", "cloudflare"])("sanitizes %s failures even when a transport error contains secrets", async (provider) => {
    let calls = 0;
    try {
      await provisionAppKey("staging", "stage-worker", env, async () => {
        calls++;
        if (provider === "cloudflare" && calls === 1) return Response.json(app);
        throw new Error(`${pem} ${env.CLOUDFLARE_API_TOKEN}`);
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/verification failed|secret upload failed/);
      expect(String(error)).not.toContain("PRIVATE KEY");
      expect(String(error)).not.toContain(env.CLOUDFLARE_API_TOKEN);
      expect(error).not.toHaveProperty("cause");
    }
  });
});
