import { expect, it } from "vitest";
import { provisionDiscordSecrets, validateDiscordSecrets } from "../deploy/discord-secrets.ts";
import { SUPPORT_ACCOUNT_ID } from "../deploy/github-app.ts";
import { webhookUrl } from "./fake-discord.ts";

const requests = webhookUrl("111111111111111111");
const incidents = webhookUrl("222222222222222222");
const env = { CLOUDFLARE_API_TOKEN: "test-deployment-token" };

it("uploads both Discord destinations as Worker secrets", async () => {
  const bindings: unknown[] = [];
  await provisionDiscordSecrets("stage-worker", { ...env, DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL: requests,
    DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL: incidents }, async (url, init) => {
    expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/stage-worker/secrets`);
    expect(init?.method).toBe("PUT");
    bindings.push(JSON.parse(String(init?.body)));
    return Response.json({ success: true });
  });
  expect(bindings).toEqual([
    { name: "DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL", type: "secret_text", text: requests },
    { name: "DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL", type: "secret_text", text: incidents },
  ]);
});

it("removes an unset destination, closing that channel, and tolerates one never configured", async () => {
  const calls: string[] = [];
  await provisionDiscordSecrets("stage-worker", { ...env, DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL: incidents }, async (url, init) => {
    calls.push(`${init?.method} ${String(url).split("/secrets")[1]}`);
    return Response.json({ success: init?.method !== "DELETE" }, { status: init?.method === "DELETE" ? 404 : 200 });
  });
  expect(calls).toEqual(["DELETE /DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL", "PUT "]);
});

it.each([
  { DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL: "https://example.com/hook" },
  { DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL: requests, DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL: requests },
])("rejects a malformed or shared destination before uploading anything", async (configuration) => {
  expect(() => validateDiscordSecrets(configuration)).toThrow("Discord notification configuration invalid");
  let calls = 0;
  await expect(provisionDiscordSecrets("stage-worker", { ...env, ...configuration }, async () => {
    calls++; return Response.json({ success: true });
  })).rejects.toThrow("Discord notification configuration invalid");
  expect(calls).toBe(0);
});

it("does not echo a webhook credential when the upload fails", async () => {
  const failure = provisionDiscordSecrets("stage-worker", { ...env, DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL: requests },
    async () => Response.json({ success: false, errors: [{ message: requests }] }, { status: 400 }));
  await expect(failure).rejects.toThrow(/^Discord notification Worker secret update failed$/);
});
