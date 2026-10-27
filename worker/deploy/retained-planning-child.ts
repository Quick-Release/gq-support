import "./planning-runtime-guard.mjs";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { encodeState } from "alchemy/State/StateEncoding";
import type { StateService } from "alchemy/State/State";
import { d1MigrationGrant, migrationSummary } from "./d1-migration-profile.ts";
import { digest } from "./planner-evidence.ts";
import { validateCopiedSource, type SourceManifest } from "./planning-source.ts";
import { planOffline, type OfflinePlanInput } from "./confined-planning-child.ts";
import { planningApplyCapability } from "./planning-apply-capability.ts";
import { privateChannel } from "./retained-child-channel.ts";
import { retainCandidate, type CandidateBinding } from "./retained-plan.ts";
import { requireEvidence, refusal, STACK } from "./planning-state.ts";
import { boundedBody } from "./planning-read.ts";

const channel = privateChannel();
const capability = planningApplyCapability();
async function main() {
  const input = await channel.receive() as OfflinePlanInput & { binding: CandidateBinding; nonce: string; sourceManifest: SourceManifest };
  validateCopiedSource(input.sourceManifest, input.binding.source);
  const client = HttpClient.make((request, url) => Effect.promise(async () => {
    capability.check();
    let body: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let contentType = request.headers["content-type"] ?? "";
    if (request.body._tag === "Uint8Array") body = Buffer.from(request.body.body);
    else if (request.body._tag === "FormData") {
      const encoded = new Response(request.body.formData);
      body = Buffer.from(await boundedBody(encoded, 32 * 1024 * 1024));
      contentType = encoded.headers.get("content-type") ?? "";
    } else requireEvidence(request.body._tag === "Empty");
    const response = await channel.request({ op: "cloudflare", url: String(url), method: request.method, contentType, body: body.toString("base64") }) as { body: string; status: number };
    requireEvidence(response && typeof response.body === "string" && response.status === 200);
    return HttpClientResponse.fromWeb(request, new Response(Buffer.from(response.body, "base64"), { status: 200, headers: { "content-type": "application/json" } }));
  }));
  await planOffline(input, { capability, client, custody: {
    provisionKey: async (stage, worker) => {
      capability.check(); requireEvidence(stage === input.target.stage);
      return await channel.request({ op: "app-key", worker }) as Awaited<ReturnType<typeof import("./github-app.ts").provisionAppKey>>;
    },
    provisionWebhook: async (worker, appId) => { capability.check(); await channel.request({ op: "app-webhook", worker, appId }); },
    check: async (metadata, worker) => {
      capability.check();
      return await channel.request({ op: "app-check", worker, metadata }) as { appId: number; checkedAt: string };
    },
  }, retain: async (native, context, evidence, snapshot, resources, bundle, checkBundle) => {
    const migrations = migrationSummary(evidence.databases.flatMap((identity) => {
      const node = native.resources[identity.fqn];
      if (node.action !== "update") return [];
      const grant = d1MigrationGrant(identity, node.state!, evidence.migrationFiles![identity.fqn].files);
      requireEvidence(grant); return [grant];
    }));
    const binding = { ...input.binding, candidate: digest({ seed: input.binding.candidate, bundle, migrations }) };
    const retained = retainCandidate({ native, stack: { name: STACK, stage: input.target.stage }, session: { context } }, evidence, binding);
    // Only the approved bounded evidence/summary crosses this public event.
    await channel.send({ event: "ready", binding, nonce: input.nonce, resources, bundle, migrations });
    const authorized = await channel.request({ op: "authorize" });
    requireEvidence(JSON.stringify(authorized) === JSON.stringify(binding));
    await checkBundle(); // before opening the phase gate or the first State checkpoint
    const target = (request: { stack: string; stage: string }) => {
      capability.check(); requireEvidence(request.stack === STACK && request.stage === input.target.stage);
    };
    const writer: StateService = { ...snapshot,
      set: (request) => Effect.promise(async () => {
        target(request); requireEvidence(["SupportDB", "SupportLedger", "Worker", "GitHubAppSecret"].includes(request.fqn));
        await channel.request({ op: "state-set", fqn: request.fqn, value: encodeState(request.value) });
        return request.value;
      }),
      setOutput: (request) => Effect.promise(async () => { target(request); await channel.request({ op: "state-output", value: encodeState(request.value) }); return request.value; }),
      delete: () => Effect.die(refusal()), deleteStack: () => Effect.die(refusal()),
    };
    await Effect.runPromise(capability.run(retained.apply({ revalidate: () => Effect.succeed({ binding, writer }) })));
  } });
  await channel.send({ event: "applied" });
}
main().catch(() => { process.exitCode = 1; }).finally(() => { capability.revoke(); channel.close(); });
