// Fake remote-binding boundary only: no Wrangler process, network or credentials.
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
const proxy = vi.hoisted(() => ({ get: vi.fn(), rpc: vi.fn(), dispose: vi.fn(async () => {}) }));
vi.mock("wrangler", () => ({ getPlatformProxy: proxy.get }));
vi.mock("alchemy/Rpc", async () => {
  const Effect = await import("effect/Effect");
  return { decodeRpcResult: Effect.succeed };
});
import { checkDeployedGitHubApp } from "../deploy/check-deployed-github-app.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
afterEach(() => vi.clearAllMocks());
describe.each(["prod", "staging"] as const)("%s final custody RPC", (stage) => {
  it("uses only the reviewed Worker and stage-pinned public App metadata", async () => {
    const metadata = { stage, clientId: `synthetic-${stage}`, slug: stage === "prod" ? "getquick-support" : "getquick-support-staging", fingerprint: `public-${stage}` };
    const worker = `synthetic-${stage}-worker`;
    proxy.get.mockImplementation(async (options) => {
      expect(options).toMatchObject({ envFiles: [], persist: false, remoteBindings: true });
      const config = JSON.parse(await readFile(options.configPath, "utf8"));
      expect(config.account_id).toBe(ACCOUNT);
      expect(config.services).toEqual([{ binding: "SUPPORT", service: worker, remote: true }]);
      return { env: { SUPPORT: { checkGitHubAppKey: proxy.rpc } }, dispose: proxy.dispose };
    });
    proxy.rpc.mockResolvedValue({ ok: true, appId: 123, ...metadata });
    await expect(checkDeployedGitHubApp(metadata, worker)).resolves.toMatchObject({ appId: 123 });
    expect(proxy.rpc).toHaveBeenCalledExactlyOnceWith(metadata.clientId, metadata.slug);
    expect(proxy.dispose).toHaveBeenCalledOnce();
    proxy.get.mockClear();
    await expect(checkDeployedGitHubApp({ ...metadata, slug: stage === "prod" ? "getquick-support-staging" : "getquick-support" }, worker)).rejects.toThrow("connection");
    expect(proxy.get).not.toHaveBeenCalled();
  });
  it("refuses a remote App from the other stage and disposes the proxy", async () => {
    proxy.get.mockResolvedValue({ env: { SUPPORT: { checkGitHubAppKey: proxy.rpc } }, dispose: proxy.dispose });
    const slug = stage === "prod" ? "getquick-support" : "getquick-support-staging";
    proxy.rpc.mockResolvedValue({ ok: true, appId: 123, clientId: "other-stage", slug, fingerprint: "other-key" });
    await expect(checkDeployedGitHubApp({ stage, clientId: `synthetic-${stage}`, slug, fingerprint: "public" }, `synthetic-${stage}`)).rejects.toThrow("identity");
    expect(proxy.dispose).toHaveBeenCalledOnce();
  });
});
