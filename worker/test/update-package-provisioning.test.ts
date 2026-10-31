import { expect, it } from "vitest";
import { provisionUpdatePackageSecret } from "../deploy/update-package-secret.ts";
import { SUPPORT_ACCOUNT_ID } from "../deploy/github-app.ts";

// #142: the narrow native-update package read token reaches the Worker only through the gated deploy.
const token = "github_pat_test_read_only_contents_0123456789";
const env = { CLOUDFLARE_API_TOKEN: "test-deployment-token" };

it("uploads the package read token as a Worker secret, and removes it when unset, closing native updates", async () => {
  const calls: { method?: string; url: string; body: unknown }[] = [];
  const record = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ success: init?.method !== "DELETE" }, { status: init?.method === "DELETE" ? 404 : 200 });
  };
  await provisionUpdatePackageSecret("stage-worker", { ...env, UPDATE_PACKAGE_TOKEN: token }, record);
  await provisionUpdatePackageSecret("stage-worker", env, record);
  const base = `https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/stage-worker/secrets`;
  expect(calls).toEqual([
    { method: "PUT", url: base, body: { name: "UPDATE_PACKAGE_TOKEN", type: "secret_text", text: token } },
    { method: "DELETE", url: `${base}/UPDATE_PACKAGE_TOKEN`, body: null },
  ]);
});

it("rejects a malformed token before uploading anything, and never echoes the token", async () => {
  let calls = 0;
  await expect(provisionUpdatePackageSecret("stage-worker", { ...env, UPDATE_PACKAGE_TOKEN: "not a token" }, async () => {
    calls++; return Response.json({ success: true });
  })).rejects.toThrow(/^Native update package token Worker secret update failed$/);
  expect(calls).toBe(0);
  await expect(provisionUpdatePackageSecret("stage-worker", { ...env, UPDATE_PACKAGE_TOKEN: token },
    async () => Response.json({ success: false, errors: [{ message: token }] }, { status: 400 })))
    .rejects.toThrow(/^Native update package token Worker secret update failed$/);
});
