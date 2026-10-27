// Confidential process-local state. Never serialize this service or its errors.
import type { ReviewedEndpoint } from "./endpoint-attestation.ts";
import { decodeNativeState } from "./native-state-decoder.ts";
import { boundedBody, wireJson } from "./planning-read.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { State, StateStoreError, type PersistedState, type StateService } from "alchemy/State/State";

export const ACCOUNT = "8f38791a8c37b182239af2a385ab3c31";
export const DATABASE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const STACK = "GQSupportWorker";
// The normal CLI/default entry must not evade the disabled protected workflow.
// Personal stages keep the existing deployment path. This is a local code guard,
// not proof that other repositories/operators respect a live exclusive window.
export const defaultDeploymentGuard = (stage: string) =>
  ["prod", "staging"].includes(stage) ? Effect.die(refusal()) : Effect.void;
export const refusal = () => new Error("Protected planning evidence unavailable; apply blocked");
const denied = () => Effect.fail(new StateStoreError({ message: refusal().message }));
export function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw refusal();
}
export type Target = { stack: typeof STACK; stage: "prod" | "staging" };
export function checkTarget(target: Target) {
  requireEvidence(target && target.stack === STACK && ["prod", "staging"].includes(target.stage));
}

// This is a reviewed, immutable deployment contract, NOT an env-provided flag.
// No production manifest has been supplied. No production entry can acquire state.
export interface EndpointContract {
  readonly origin: string;
  readonly account: typeof ACCOUNT;
  readonly script: string;
  readonly scriptDigest: string;
  readonly protocol: 7;
  readonly target: Target;
}
export const productionEndpointContract: ReviewedEndpoint | undefined = undefined;

// transport must be a dedicated non-redirecting fetch, not an SDK/global client.
// Exact paths, no listStacks (which would expose other projects), no URL prefix grants.
export function confinedClient(contract: EndpointContract, transport: typeof fetch) {
  contract = structuredClone(contract);
  checkTarget(contract.target);
  let origin: URL;
  try { origin = new URL(contract.origin); } catch { throw refusal(); }
  requireEvidence(origin.protocol === "https:" && origin.origin === contract.origin &&
    contract.account === ACCOUNT && contract.protocol === 7 && contract.script.length > 0 &&
    /^[a-f0-9]{64}$/.test(contract.scriptDigest));
  const prefix = `/state/stacks/${STACK}/stages`;
  const stage = `${prefix}/${contract.target.stage}`;
  let received = 0, requests = 0;
  return HttpClient.make((request, url) => Effect.tryPromise({
    try: async () => {
      requireEvidence(++requests <= 300 && url.origin === contract.origin && !url.search && !url.hash &&
        !url.username && !url.password && request.method === "GET" &&
        (url.pathname === "/version" || url.pathname === prefix ||
          ["/resources", "/replaced-resources", "/output"].some((suffix) => url.pathname === stage + suffix) ||
          new RegExp(`^${stage}/resources/[A-Za-z0-9_.%~-]+$`).test(url.pathname)));
      const response = await transport(url, {
        method: "GET", headers: request.headers, redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      requireEvidence((!response.url || response.url === String(url)) && !response.redirected && response.status === 200 &&
        response.headers.get("content-type")?.startsWith("application/json"));
      const bytes = await boundedBody(response);
      received += bytes.byteLength; requireEvidence(received <= 32 * 1024 * 1024);
      const data = wireJson(bytes);
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      }));
    },
    catch: () => new HttpClientErrorForPlanning(),
  }).pipe(Effect.orDie));
}
class HttpClientErrorForPlanning extends Error {
  constructor() { super("Protected planning evidence unavailable; apply blocked"); }
}

function record(value: unknown): asserts value is Record<string, unknown> {
  requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value));
}
export function validateRow(value: unknown, fqn: string): asserts value is PersistedState {
  record(value);
  requireEvidence(value.fqn === fqn && typeof value.logicalId === "string" && value.logicalId.length > 0 &&
    Array.isArray(value.downstream) && new Set(value.downstream).size === value.downstream.length && value.downstream.every((v) => typeof v === "string"));
  const path: string[] = [value.logicalId as string];
  let namespace = value.namespace;
  for (let depth = 0; namespace !== undefined; depth++) {
    requireEvidence(depth < 32); record(namespace);
    requireEvidence(Object.keys(namespace).every((key) => ["Id", "Parent"].includes(key)) && typeof namespace.Id === "string" && /^[A-Za-z0-9_~-]+$/.test(namespace.Id));
    path.unshift(namespace.Id); namespace = namespace.Parent;
  }
  requireEvidence(path.join("/") === fqn);
  // Unsettled rows and *all* cleanup/history are deliberately refused. They
  // remain in the snapshot input and cannot be omitted as exportState does.
  requireEvidence(!("old" in value) && !("adopting" in value) && !("adoptionBlocked" in value));
  if (value.kind === "action") {
    requireEvidence(value.status === "ran" && typeof value.actionType === "string" && value.actionType.length > 0 &&
      typeof value.inputHash === "string" && /^[a-f0-9]{64}$/.test(value.inputHash) && "input" in value && "output" in value);
  } else {
    requireEvidence((value.kind === undefined || value.kind === "resource") &&
      ["created", "updated"].includes(String(value.status)) && typeof value.resourceType === "string" && value.resourceType.length > 0 &&
      typeof value.instanceId === "string" && value.instanceId.length > 0 &&
      Number.isInteger(value.providerVersion) && Number(value.providerVersion) >= 0 && Array.isArray(value.bindings) &&
      value.bindings.every((binding) => binding && typeof binding === "object" &&
        typeof binding.sid === "string" && binding.sid.length > 0 && "data" in binding) &&
      (value.providerMode === undefined || value.providerMode === "live") &&
      (value.removalPolicy === undefined || ["retain", "destroy"].includes(String(value.removalPolicy))));
    record(value.props); record(value.attr);
  }
}

export const acquireSnapshot = (source: StateService, target: Target) => Effect.gen(function* () {
  checkTarget(target);
  target = { ...target };
  requireEvidence((yield* source.getVersion()) === 7);
  requireEvidence((yield* source.listStages(target.stack)).includes(target.stage));
  const listed = yield* source.list(target);
  requireEvidence(listed.length > 0 && listed.length <= 256 && new Set(listed).size === listed.length);
  const rows = new Map<string, PersistedState>();
  for (const fqn of listed) {
    requireEvidence(typeof fqn === "string" && /^[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+)*$/.test(fqn));
    const row = yield* source.get({ ...target, fqn });
    validateRow(row, fqn);
    rows.set(fqn, row);
  }
  for (const row of rows.values()) requireEvidence(row.downstream.every((fqn) => rows.has(fqn)));
  const identities = ["SupportDB", "SupportLedger"].map((fqn) => {
    const row = rows.get(fqn);
    requireEvidence(row && row.kind !== "action" && row.resourceType === "Cloudflare.D1Database" &&
      row.logicalId === fqn && row.removalPolicy === "retain" && (row.providerMode === undefined || row.providerMode === "live") &&
      row.attr?.accountId === ACCOUNT && row.attr?.jurisdiction === "eu" && row.props?.jurisdiction === "eu" &&
      typeof row.attr.databaseId === "string" && DATABASE_ID.test(row.attr.databaseId) &&
      typeof row.attr.databaseName === "string" && row.attr.databaseName.length > 0);
    return row.attr;
  });
  requireEvidence(new Set(identities.map((a) => a.databaseId)).size === 2 &&
    new Set(identities.map((a) => a.databaseName)).size === 2);
  requireEvidence((yield* source.getReplacedResources(target)).length === 0);
  const output = yield* source.getOutput(target);
  const graph = { target, rows, output };
  // Resolve all references against exactly this complete listed graph. No reads
  // outside this project/stage or discovery of arbitrary reference targets.
  const decoded = new Map<string, PersistedState>();
  for (const [fqn, row] of rows) decoded.set(fqn, decodeNativeState(row, graph) as PersistedState);
  const savedOutput = decodeNativeState(output, graph);
  const savedGraph = { target, rows: decoded, output: savedOutput };
  requireEvidence(output !== undefined);
  const same = (r: { stack: string; stage: string }) => r.stack === target.stack && r.stage === target.stage;
  const service: StateService = {
    id: "protected-snapshot",
    getVersion: () => Effect.succeed(7),
    listStacks: () => Effect.succeed([target.stack]),
    listStages: (stack) => stack === target.stack ? Effect.succeed([target.stage]) : denied(),
    list: (r) => same(r) ? Effect.succeed(Object.freeze([...rows.keys()])) : denied(),
    get: (r) => same(r) ? Effect.sync(() => decodeNativeState(decoded.get(r.fqn), savedGraph) as PersistedState | undefined) : denied(),
    getOutput: (r) => same(r) ? Effect.sync(() => decodeNativeState(savedOutput, savedGraph)) : denied(),
    getReplacedResources: (r) => same(r) ? Effect.succeed([]) : denied(),
    set: denied, delete: denied, deleteStack: denied, setOutput: denied,
  };
  return Object.freeze(service);
}).pipe(Effect.catchCause(() => Effect.die(refusal())));

export function snapshotLayer(service: StateService) {
  return Layer.effect(State, Effect.cached(Effect.succeed(service)));
}

// Only the confined HTTP client is in scope; no Cloudflare.state()/auth fallback.
export const acquireHttpSnapshot = (contract: EndpointContract, bearer: string, transport: typeof fetch) =>
  Effect.gen(function* () {
    requireEvidence(typeof bearer === "string" && bearer.length > 0 && !/[\s\r\n]/.test(bearer));
    const source = yield* makeHttpStateStore({ url: contract.origin, authToken: bearer, id: "protected-http" });
    return yield* acquireSnapshot(source, contract.target);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, confinedClient(contract, transport)),
    Effect.catchCause(() => Effect.die(refusal())),
  );
