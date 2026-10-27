import { discord } from "./fixtures/discord-custody.ts";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { trustedAppCustody } from "../deploy/trusted-app-custody.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "CF_CREDENTIAL_CANARY", GITHUB_APP_ID: "123", GITHUB_APP_SLUG: "getquick-support", GITHUB_APP_CLIENT_ID: "synthetic-client",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), GITHUB_WEBHOOK_SECRET: "WEBHOOK_CREDENTIAL_CANARY" };
function fixture(stage: "prod" | "staging" = "prod") {
  const appEnv = { ...env, GITHUB_APP_SLUG: stage === "prod" ? "getquick-support" : "getquick-support-staging" };
  const check = vi.fn(async () => {});
  const transport = vi.fn<typeof fetch>(async (url) => String(url) === "https://api.github.com/app" ? Response.json({ id: 123, slug: appEnv.GITHUB_APP_SLUG, client_id: env.GITHUB_APP_CLIENT_ID,
    owner: { login: "Quick-Release", type: "Organization" }, permissions: { issues: "write", metadata: "read" }, events: ["issues", "public", "repository"] }) : Response.json({ success: true }));
  return { custody: trustedAppCustody({ ...appEnv, GITHUB_SHA: discord.release }, "synthetic-worker", transport, check, () => {}, stage, discord), transport, check };
}
describe.each(["prod", "staging"] as const)("%s trusted App custody direct fetches", (stage) => {
  it("uses existing real provisioning helpers with exact first-party routes and checks each call", async () => {
    const { custody, transport, check } = fixture(stage);
    const metadata = await custody.provisionKey(stage, "synthetic-worker");
    await custody.provisionWebhook("synthetic-worker", metadata.appId);
    expect(transport.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      ["https://api.github.com/app", "GET"],
      [`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/synthetic-worker/secrets`, "PUT"],
      [`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/synthetic-worker/secrets`, "PUT"],
      [`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/synthetic-worker/secrets/GITHUB_WEBHOOK_PREVIOUS_SECRET`, "DELETE"],
    ]);
    expect(check).toHaveBeenCalledTimes(4); expect(JSON.stringify(metadata)).not.toMatch(/CANARY|PRIVATE KEY/);
  });
  it.each(["id", "client_id", "slug"])("refuses interchanged App %s before the first secret write", async (key) => {
    const { custody, transport } = fixture(stage);
    transport.mockImplementation(async () => Response.json({ id: key === "id" ? 999 : 123,
      slug: key === "slug" ? (stage === "prod" ? "getquick-support-staging" : "getquick-support") : (stage === "prod" ? "getquick-support" : "getquick-support-staging"),
      client_id: key === "client_id" ? "other-client" : env.GITHUB_APP_CLIENT_ID,
      owner: { login: "Quick-Release", type: "Organization" }, permissions: { issues: "write", metadata: "read" }, events: ["issues", "public", "repository"] }));
    await expect(custody.provisionKey(stage, "synthetic-worker")).rejects.toThrow("apply blocked");
    expect(transport).toHaveBeenCalledOnce(); expect(transport.mock.calls[0][0]).toBe("https://api.github.com/app");
  });
  it("refuses other-stage RPC metadata before launching remote custody", async () => {
    const { custody } = fixture(stage);
    const metadata = await custody.provisionKey(stage, "synthetic-worker");
    await expect(custody.check({ ...metadata, stage: stage === "prod" ? "staging" : "prod" }, "synthetic-worker")).rejects.toThrow("apply blocked");
  });
  it("cannot send custody to a different worker or stage", async () => {
    const { custody, transport } = fixture(stage);
    await expect(custody.provisionKey(stage, "other-worker")).rejects.toThrow("apply blocked");
    await expect(custody.provisionKey(stage === "prod" ? "staging" : "prod", "synthetic-worker")).rejects.toThrow("apply blocked");
    await expect(custody.provisionWebhook("other-worker", 123)).rejects.toThrow("apply blocked"); expect(transport).not.toHaveBeenCalled();
  });
  it("refuses revoked authorization before any key or webhook request", async () => {
    const { custody, transport, check } = fixture(stage); check.mockRejectedValue(new Error("REVOKED_PRIVATE_CANARY"));
    await expect(custody.provisionKey(stage, "synthetic-worker")).rejects.toThrow("apply blocked");
    await expect(custody.provisionWebhook("synthetic-worker", 123)).rejects.toThrow("apply blocked"); expect(transport).not.toHaveBeenCalled();
  });
});
