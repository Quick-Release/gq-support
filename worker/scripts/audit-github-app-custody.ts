import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey } from "node:crypto";
import { appConfig, SUPPORT_ACCOUNT_ID } from "../deploy/github-app.ts";
import { keyLeakCheck, scanKeyFiles } from "../deploy/key-custody-scan.ts";
import * as Effect from "effect/Effect";
import * as Alchemist from "alchemy/Alchemist";
import * as Cloudflare from "alchemy/Cloudflare";
import { State } from "alchemy/State";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { encodeState } from "alchemy/State/StateEncoding";

let step = "configuration";
try {
  const config = appConfig(process.argv[2], process.env);
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!pem || !token) throw new Error();
  const assertClean = keyLeakCheck(pem);
  const profile = process.env.ALCHEMY_PROFILE ?? "default";
  if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error();
  step = "state authentication";
  // Alchemy deliberately does not persist state-store credentials in CI.
  // Use its authenticated state service instead of a local credential cache.
  const state = await Effect.runPromise(Effect.flatten(State).pipe(
    Effect.provide(Cloudflare.state()),
    Effect.provideService(AuthProviders, {}),
    Effect.provide(Alchemist.layer()),
    Effect.scoped,
  ));
  // Re-encode wrappers to inspect their actual contents: JSON.stringify alone
  // would conceal a persisted Redacted key behind a display placeholder.
  const inspectState = (value: unknown) => assertClean(JSON.stringify(encodeState(value)) ?? "");
  const address = { stack: "GQSupportWorker", stage: config.stage };
  step = "state resources";
  const resources = await Effect.runPromise(state.list(address));
  if (resources.length === 0) throw new Error();
  for (const fqn of resources) {
    inspectState(await Effect.runPromise(state.get({ ...address, fqn })));
  }
  inspectState(await Effect.runPromise(state.getReplacedResources(address)));
  step = "state output";
  const output = await Effect.runPromise(state.getOutput(address));
  inspectState(output);
  if (typeof output !== "object" || output === null || !("workerName" in output) ||
      typeof output.workerName !== "string") throw new Error();
  const workerName = output.workerName;
  const root = `https://api.cloudflare.com/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}`;
  const headers = { Authorization: `Bearer ${token}` };
  step = "Worker binding";
  const settingsResponse = await fetch(`${root}/settings`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!settingsResponse.ok) throw new Error();
  const settings = await settingsResponse.json() as {
    success: boolean; result: { bindings: Array<{ name: string; type: string; text?: string }> };
  };
  const binding = settings.result.bindings.find((entry) => entry.name === "GITHUB_APP_PRIVATE_KEY");
  if (!settings.success || binding?.type !== "secret_text" || binding.text !== undefined) throw new Error();
  assertClean(JSON.stringify(settings));
  step = "Worker bundle";
  const content = await fetch(`${root}/content/v2`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!content.ok) throw new Error();
  // The deployed bundle is bounded by the platform's script-size limit.
  assertClean(new Uint8Array(await content.arrayBuffer()));
  step = "files and logs";
  let files = await scanKeyFiles(join(import.meta.dirname, "../.."), assertClean);
  files += await scanKeyFiles(join(homedir(), ".alchemy", "logs"), assertClean);
  files += await scanKeyFiles(join(homedir(), ".config", ".wrangler", "logs"), assertClean);
  const fingerprint = createHash("sha256")
    .update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("base64");
  console.log(JSON.stringify({ stage: config.stage, workerName, fingerprint,
    stateEntries: resources.length + 2, scannedFiles: files, binding: "secret_text", custody: "passed" }));
} catch {
  console.error(`GitHub App custody audit failed (${step}); raw state, bindings and credentials have been suppressed`);
  process.exitCode = 1;
}
