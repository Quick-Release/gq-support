import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { runWebhookSpike, STAGING_WEBHOOK } from "../scripts/github-webhook-spike.ts";
import { SUPPORT_ACCOUNT_ID } from "../deploy/github-app.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const env = { CLOUDFLARE_ACCOUNT_ID: SUPPORT_ACCOUNT_ID, GITHUB_APP_ID: "5355960", GITHUB_APP_SLUG: "getquick-support-staging",
  GITHUB_APP_CLIENT_ID: "Iv1.test", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: "current-test-secret" };
const app = { id: 5355960, slug: env.GITHUB_APP_SLUG, client_id: env.GITHUB_APP_CLIENT_ID,
  owner: { login: "Quick-Release", type: "Organization" }, permissions: { issues: "write", metadata: "read" },
  events: ["issues", "public", "repository"] };

it("configures only staging's HTTPS JSON webhook without returning its secret", async () => {
  const result = await runWebhookSpike("configure", env, async (url, init) => {
    if (String(url).endsWith("/app")) return Response.json(app);
    expect(String(url)).toBe("https://api.github.com/app/hook/config");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ url: STAGING_WEBHOOK, content_type: "json", insecure_ssl: "0", secret: env.GITHUB_WEBHOOK_SECRET });
    return Response.json({ secret: "********" });
  });
  expect(JSON.stringify(result)).not.toContain(env.GITHUB_WEBHOOK_SECRET);
});

it("checks the webhook configuration without returning its secret", async () => {
  const result = await runWebhookSpike("config", env, async (url, init) => {
    if (String(url).endsWith("/app")) return Response.json(app);
    expect(String(url)).toBe("https://api.github.com/app/hook/config");
    expect(init?.method).toBe("GET");
    return Response.json({ url: STAGING_WEBHOOK, content_type: "json", insecure_ssl: "0", secret: "current-test-secret" });
  });
  expect(result).toEqual({ url: STAGING_WEBHOOK, contentType: "json", tlsVerified: true, secretConfigured: true });
  expect(JSON.stringify(result)).not.toContain(env.GITHUB_WEBHOOK_SECRET);
});

it("reports an unexpected webhook URL without echoing it", async () => {
  const result = await runWebhookSpike("config", env, async (url) => String(url).endsWith("/app") ? Response.json(app)
    : Response.json({ url: "https://attacker.example/hook?token=private", content_type: "form", insecure_ssl: "1" }));
  expect(result).toEqual({ url: "unexpected", contentType: "unexpected", tlsVerified: false, secretConfigured: false });
});

it("breaks delivery with a random secret it never returns, leaving the URL", async () => {
  let sent: Record<string, string> = {};
  const result = await runWebhookSpike("break", env, async (url, init) => {
    if (String(url).endsWith("/app")) return Response.json(app);
    expect(init?.method).toBe("PATCH");
    sent = JSON.parse(String(init?.body));
    return Response.json({ secret: "********" });
  });
  expect(Object.keys(sent)).toEqual(["secret"]);
  expect(sent.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(sent.secret).not.toBe(env.GITHUB_WEBHOOK_SECRET);
  expect(JSON.stringify(result)).not.toContain(sent.secret!);
});

it("collects actual receiver byte counts, never serialized payload estimates or signatures", async () => {
  const result = await runWebhookSpike("collect", env, async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/app") return Response.json(app);
    if (path === "/app/hook/deliveries") return Response.json([
      { id: 12, delivered_at: "2026-10-18T12:00:00Z", event: "issues", action: "opened", redelivery: false, status_code: 204 },
    ]);
    return Response.json({ url: STAGING_WEBHOOK, request: { headers: {
      "X-GitHub-Hook-Installation-Target-Type": "integration", "X-GitHub-Hook-Installation-Target-ID": "5355960",
      "X-Hub-Signature-256": "private-signature",
    }, payload: { body: "Private report content" } }, response: { headers: { "X-GQ-Webhook-Bytes": "65536", "X-GQ-Webhook-Key": "previous" } } });
  });
  expect(JSON.stringify(result)).not.toMatch(/Private report|private-signature|current-test-secret/);
  expect(result).toMatchObject({ deliveries: [{ id: "12", bytes: 65536, key: "previous", targetType: "integration", targetId: "5355960" }] });
});

it("always attempts to restore the sandbox installation after suspension fails", async () => {
  const methods: string[] = [];
  await expect(runWebhookSpike("installation", env, async (url, init) => {
    if (String(url).endsWith("/app")) return Response.json(app);
    if (!String(url).endsWith("/suspended")) return Response.json({ account: { login: "Quick-Release" }, repository_selection: "selected", app_id: 5355960 });
    methods.push(init!.method!);
    return new Response(null, { status: init?.method === "PUT" ? 500 : 204 });
  })).rejects.toThrow("github_api");
  expect(methods).toEqual(["PUT", "DELETE"]);
});

it("keeps pending delivery responses without inventing byte measurements", async () => {
  const result = await runWebhookSpike("collect", env, async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/app") return Response.json(app);
    if (path === "/app/hook/deliveries") return Response.json([
      { id: 13, delivered_at: "2026-10-18T12:00:00Z", event: "installation", action: "suspend", redelivery: false, status_code: 0 },
    ]);
    return Response.json({ url: STAGING_WEBHOOK, request: null, response: null });
  });
  expect(result).toMatchObject({ deliveries: [{ id: "13", bytes: null, key: null }] });
});

it("preserves GitHub's 64-bit delivery IDs in detail and redelivery URLs", async () => {
  const result = await runWebhookSpike("collect", env, async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/app") return Response.json(app);
    if (path === "/app/hook/deliveries") return new Response('[{"id":3849000772266098688,"delivered_at":"2026-10-18T12:00:00Z","event":"issues","action":"opened","status_code":204,"redelivery":false}]');
    expect(path).toBe("/app/hook/deliveries/3849000772266098688");
    return Response.json({ url: STAGING_WEBHOOK, request: { headers: {} }, response: { headers: {} } });
  });
  expect(result).toMatchObject({ deliveries: [{ id: "3849000772266098688" }] });
});

it("denies production configuration before any mutation", async () => {
  let mutations = 0;
  await expect(runWebhookSpike("configure", { ...env, GITHUB_APP_SLUG: "getquick-support" }, async (_, init) => {
    if (init?.method && init.method !== "GET") mutations++;
    return Response.json(app);
  })).rejects.toThrow("Wrong GitHub App");
  expect(mutations).toBe(0);
});
