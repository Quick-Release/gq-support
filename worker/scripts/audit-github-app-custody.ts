import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey } from "node:crypto";
import { appConfig, SUPPORT_ACCOUNT_ID } from "../deploy/github-app.ts";
import { keyLeakCheck, scanKeyFiles } from "../deploy/key-custody-scan.ts";

try {
  const config = appConfig(process.argv[2], process.env);
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!pem || !token) throw new Error();
  const assertClean = keyLeakCheck(pem);
  const profile = process.env.ALCHEMY_PROFILE ?? "default";
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error();
  const stateCredentials = JSON.parse(await readFile(
    join(homedir(), ".alchemy", "credentials", profile, "cloudflare-state-store.json"), "utf8",
  ));
  if (stateCredentials.accountId !== SUPPORT_ACCOUNT_ID) throw new Error();
  const stateUrl = new URL(stateCredentials.url);
  if (stateUrl.protocol !== "https:" || !stateUrl.hostname.endsWith(".workers.dev")) throw new Error();
  // Inspect raw HTTP state records before the SDK can replace Redacted values
  // with display placeholders. Never print or write a state dump.
  const readState = async (path: string): Promise<unknown> => {
    const response = await fetch(new URL(path, stateUrl), {
      headers: { Authorization: `Bearer ${stateCredentials.authToken}` },
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error();
    const text = await response.text();
    assertClean(text);
    return JSON.parse(text);
  };
  const statePath = `/state/stacks/GQSupportWorker/stages/${config.stage}`;
  const resources = await readState(`${statePath}/resources`);
  if (!Array.isArray(resources) || resources.length === 0) throw new Error();
  for (const name of resources) {
    if (typeof name !== "string") throw new Error();
    await readState(`${statePath}/resources/${encodeURIComponent(name)}`);
  }
  await readState(`${statePath}/replaced-resources`);
  const output = await readState(`${statePath}/output`);
  if (typeof output !== "object" || output === null || !("workerName" in output) ||
      typeof output.workerName !== "string") throw new Error();
  const workerName = output.workerName;
  const root = `https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}`;
  const headers = { Authorization: `Bearer ${token}` };
  const settingsResponse = await fetch(`${root}/settings`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!settingsResponse.ok) throw new Error();
  const settings = await settingsResponse.json() as {
    success: boolean; result: { bindings: Array<{ name: string; type: string; text?: string }> };
  };
  const binding = settings.result.bindings.find((entry) => entry.name === "GITHUB_APP_PRIVATE_KEY");
  if (!settings.success || binding?.type !== "secret_text" || binding.text !== undefined) throw new Error();
  assertClean(JSON.stringify(settings));
  const content = await fetch(`${root}/content/v2`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!content.ok) throw new Error();
  // The deployed bundle is bounded by the platform's script-size limit.
  assertClean(new Uint8Array(await content.arrayBuffer()));
  let files = await scanKeyFiles(join(import.meta.dirname, "../.."), assertClean);
  files += await scanKeyFiles(join(homedir(), ".alchemy", "logs"), assertClean);
  files += await scanKeyFiles(join(homedir(), ".config", ".wrangler", "logs"), assertClean);
  const fingerprint = createHash("sha256")
    .update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("base64");
  console.log(JSON.stringify({ stage: config.stage, workerName, fingerprint,
    stateEntries: resources.length + 2, scannedFiles: files, binding: "secret_text", custody: "passed" }));
} catch {
  console.error("GitHub App custody audit failed; raw state, bindings and credentials have been suppressed");
  process.exitCode = 1;
}
