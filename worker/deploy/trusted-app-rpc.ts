// Fixed trusted apply-only RPC checker; not a graph execution endpoint.
import { writeSync } from "node:fs";
import { checkDeployedGitHubApp } from "./check-deployed-github-app.ts";
import { requireEvidence } from "./planning-state.ts";
async function main() {
  let bytes = Buffer.alloc(0);
  for await (const chunk of process.stdin) { bytes = Buffer.concat([bytes, Buffer.from(chunk)]); requireEvidence(bytes.length <= 1024); }
  const input = JSON.parse(bytes.toString()) as { metadata: Parameters<typeof checkDeployedGitHubApp>[0]; worker: string };
  requireEvidence(Object.keys(input).sort().join() === "metadata,worker" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(input.worker) && input.metadata.stage === "prod");
  writeSync(3, JSON.stringify(await checkDeployedGitHubApp(input.metadata, input.worker)));
}
main().catch(() => { process.exitCode = 1; });
