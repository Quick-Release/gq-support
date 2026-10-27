import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { decodeRpcResult } from "alchemy/Rpc";
import * as Effect from "effect/Effect";
import { SUPPORT_ACCOUNT_ID, type AppConfig } from "./github-app.ts";

import { checkStage, protectedAppSlugs } from "./planning-state.ts";

export class DeployedGitHubAppCheckError extends Error {
  constructor(step: "connection" | "rpc" | "identity" | "fingerprint") {
    super(`Deployed GitHub App key check failed (${step})`);
  }
}

/** The remote binding invokes the owning Worker; it never copies its secret. */
export async function checkDeployedGitHubApp(config: AppConfig & { fingerprint: string }, workerName: string) {
  const directory = await mkdtemp(join(tmpdir(), "gq-key-custody-"));
  let step: ConstructorParameters<typeof DeployedGitHubAppCheckError>[0] = "connection";
  try {
    checkStage(config.stage);
    if (config.slug !== protectedAppSlugs[config.stage]) throw new Error();
    const configPath = join(directory, "wrangler.jsonc");
    await writeFile(configPath, JSON.stringify({
      name: "gq-key-custody-check",
      account_id: SUPPORT_ACCOUNT_ID,
      compatibility_date: "2026-10-17",
      services: [{ binding: "SUPPORT", service: workerName, remote: true }],
    }));
    const proxy = await getPlatformProxy<{
      SUPPORT: { checkGitHubAppKey: (clientId: string, slug: string) => Promise<unknown> };
    }>({ configPath, envFiles: [], persist: false, remoteBindings: true });
    try {
      step = "rpc";
      const result = await Effect.runPromise(decodeRpcResult(
        await proxy.env.SUPPORT.checkGitHubAppKey(config.clientId, config.slug),
      ));
      step = "identity";
      if (typeof result !== "object" || result === null ||
          !("ok" in result) || result.ok !== true ||
          !("clientId" in result) || result.clientId !== config.clientId ||
          !("slug" in result) || result.slug !== config.slug ||
          !("appId" in result) || !Number.isSafeInteger(result.appId)) {
        throw new Error();
      }
      step = "fingerprint";
      if (!("fingerprint" in result) || result.fingerprint !== config.fingerprint) throw new Error();
      return { appId: Number(result.appId), checkedAt: new Date().toISOString() };
    } finally {
      // Preserve the original failing stage if validation failed.
      await proxy.dispose();
    }
  } catch {
    throw new DeployedGitHubAppCheckError(step);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
