import { expect, it } from "vitest";
import { provisionWebhookSecrets, validateWebhookSecrets } from "../deploy/github-webhook-secrets.ts";
import { SUPPORT_ACCOUNT_ID } from "../deploy/github-app.ts";

const env = { GITHUB_APP_ID: "123", GITHUB_WEBHOOK_SECRET: "test-current-webhook-secret",
  CLOUDFLARE_API_TOKEN: "test-deployment-token" };

it("uploads webhook secrets without returning secret material to Alchemy state", async () => {
  const bindings: unknown[] = [];
  const result = await provisionWebhookSecrets("stage-worker", 123, { ...env, GITHUB_WEBHOOK_PREVIOUS_SECRET: "test-previous" }, async (url, init) => {
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/stage-worker/secrets`);
    expect(init?.method).toBe("PUT");
    bindings.push(JSON.parse(String(init?.body)));
    return Response.json({ success: true });
  });
  expect(bindings).toEqual([
    { name: "GITHUB_WEBHOOK_SECRET", type: "secret_text", text: env.GITHUB_WEBHOOK_SECRET },
    { name: "GITHUB_WEBHOOK_PREVIOUS_SECRET", type: "secret_text", text: "test-previous" },
  ]);
  expect(result).toBeUndefined();
});

it("removes the previous Worker secret when the rotation window ends", async () => {
  const calls: { url: string; method: string | undefined }[] = [];
  await provisionWebhookSecrets("stage-worker", 123, env, async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return Response.json({ success: true });
  });
  expect(calls.map((call) => call.method)).toEqual(["PUT", "DELETE"]);
  expect(calls[1]!.url).toMatch(/\/secrets\/GITHUB_WEBHOOK_PREVIOUS_SECRET$/);
});

it("tolerates a previous secret that was never configured", async () => {
  await provisionWebhookSecrets("stage-worker", 123, env, async (_, init) =>
    Response.json({ success: init?.method !== "DELETE" }, { status: init?.method === "DELETE" ? 404 : 200 }));
});

it.each([
  { ...env, GITHUB_WEBHOOK_SECRET: "" }, { ...env, GITHUB_APP_ID: "" }, { ...env, GITHUB_APP_ID: "456" },
])("rejects invalid configuration before uploading secrets", async (configuration) => {
  let calls = 0;
  await expect(provisionWebhookSecrets("stage-worker", 123, configuration, async () => {
    calls++; return Response.json({ success: true });
  })).rejects.toThrow("GitHub webhook configuration invalid");
  expect(calls).toBe(0);
});

it("rejects missing webhook configuration in the preflight", () => {
  expect(() => validateWebhookSecrets({})).toThrow("GitHub webhook configuration invalid");
});

it.each(["throw", "response"])("sanitizes upload failures: %s", async (failure) => {
  await expect(provisionWebhookSecrets("stage-worker", 123, env, async () => {
    if (failure === "throw") throw new Error(env.GITHUB_WEBHOOK_SECRET + env.CLOUDFLARE_API_TOKEN);
    return Response.json({ success: false, message: env.GITHUB_WEBHOOK_SECRET });
  })).rejects.toThrow(/^GitHub webhook Worker secret update failed$/);
});
