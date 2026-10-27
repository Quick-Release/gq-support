// Evidence stays in this process. This module cannot load credentials or repair
// a store. The reviewed manifest is a trust anchor, not an environment claim.
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { ACCOUNT, checkTarget, acquireHttpSnapshot, refusal, requireEvidence, type EndpointContract } from "./planning-state.ts";
import { boundedBody, credential, wireJson, checkWire } from "./planning-read.ts";

export interface ReviewedEndpoint extends EndpointContract {
  readonly path: "/state";
  readonly mainModule: string;
  readonly scriptEtag: string;
  readonly versionId: string;
  readonly deploymentId: string;
  // Exact non-secret binding metadata from version.resources.bindings.
  // Includes Store DO namespace/class and Secrets Store store_id/secret_name;
  // no secret text values are supported in this metadata contract.
  readonly bindings: readonly Readonly<Record<string, unknown>>[];
  // Every listed resource/action must have an exact reviewed identity and
  // required decoded paths. Unknown extra rows cannot silently enter a plan.
  readonly graph: readonly {
    readonly fqn: string;
    readonly type: string;
    readonly kind: "resource" | "action";
    readonly instanceId?: string;
    readonly providerVersion?: number;
    readonly requiredPaths: readonly (readonly string[])[];
  }[];
  readonly outputPaths: readonly (readonly string[])[];
  readonly databases: readonly {
    readonly fqn: "SupportDB" | "SupportLedger";
    readonly databaseId: string;
    readonly databaseName: string;
    readonly instanceId: string;
  }[];
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function object(value: unknown): Record<string, unknown> {
  requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value);
}
function bindingSet(value: unknown): string {
  requireEvidence(Array.isArray(value) && value.length > 0 && value.length <= 64);
  const names = new Set<string>();
  return canonical(value.map((v) => {
    const b = object(v);
    requireEvidence(typeof b.name === "string" && !names.has(b.name)); names.add(b.name);
    // Never accept secret text or arbitrarily shaped service bindings.
    const keys = b.type === "durable_object_namespace" ? ["type", "name", "namespace_id", "class_name", "script_name", "environment"] :
      b.type === "secrets_store_secret" ? ["type", "name", "store_id", "secret_name"] : [];
    requireEvidence(keys.length > 0 && Object.keys(b).every((key) => keys.includes(key)) &&
      Object.values(b).every((v) => typeof v === "string" && v.length > 0));
    if (b.type === "durable_object_namespace") requireEvidence(typeof b.namespace_id === "string" && /^[a-f0-9]{32}$/.test(b.namespace_id) && typeof b.class_name === "string");
    else requireEvidence(typeof b.store_id === "string" && /^[a-f0-9]{32}$/.test(b.store_id) && typeof b.secret_name === "string");
    return b;
  }).sort((a, b) => compare(String(a.name), String(b.name))));
}

// Hash content/v2 modules independently of the random multipart boundary.
// Manifest algorithm: SHA256(JSON(sorted [name, filename, MIME type, SHA256(bytes)] rows)).
export async function bundleDigest(bytes: Uint8Array, contentType: string, mainModule?: string): Promise<string> {
  requireEvidence(bytes.byteLength > 0 && bytes.byteLength <= 8 * 1024 * 1024);
  requireEvidence(/^multipart\/form-data;/.test(contentType));
  const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  const modules: string[][] = [];
  const names = new Set<string>();
  for (const [name, value] of form.entries()) {
    requireEvidence(!names.has(name) && /^[A-Za-z0-9_./~-]+$/.test(name) && !name.split("/").includes("..") && typeof value !== "string");
    names.add(name);
    modules.push([name, value.name, value.type, createHash("sha256").update(new Uint8Array(await value.arrayBuffer())).digest("hex")]);
  }
  requireEvidence(modules.length > 0 && modules.length <= 256 &&
    (mainModule === undefined || modules.some(([name, filename]) => name === mainModule && filename === mainModule)));
  return createHash("sha256").update(JSON.stringify(modules.sort(([a], [b]) => compare(a, b)))).digest("hex");
}

export async function attestEndpoint(manifest: ReviewedEndpoint, readToken: string, transport: typeof fetch): Promise<Readonly<ReviewedEndpoint>> {
  try {
    // Detach all reviewed inputs before the first await.
    checkWire(manifest);
    const contract: ReviewedEndpoint = JSON.parse(JSON.stringify(manifest));
    checkTarget(contract.target); credential(readToken);
    requireEvidence(contract.account === ACCOUNT && contract.protocol === 7 && contract.path === "/state" &&
      /^[a-z0-9][a-z0-9-]{0,62}$/.test(contract.script) && /^[a-f0-9]{64}$/.test(contract.scriptDigest) &&
      uuid.test(contract.versionId) && uuid.test(contract.deploymentId) &&
      typeof contract.scriptEtag === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(contract.scriptEtag) &&
      typeof contract.mainModule === "string" && /^[A-Za-z0-9_./~-]+$/.test(contract.mainModule) && !contract.mainModule.split("/").includes(".."));
    requireEvidence(contract.graph.length >= 4 && contract.graph.length <= 256 &&
      new Set(contract.graph.map((row) => row.fqn)).size === contract.graph.length);
    for (const row of contract.graph) {
      requireEvidence(/^[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+)*$/.test(row.fqn) && row.type.length > 0 &&
        ["resource", "action"].includes(row.kind));
      if (row.kind === "resource") requireEvidence(typeof row.instanceId === "string" && row.instanceId.length > 0 &&
        Number.isInteger(row.providerVersion) && Number(row.providerVersion) >= 0);
      checkPaths(row.requiredPaths);
    }
    checkPaths(contract.outputPaths);
    for (const [fqn, type] of [["SupportDB", "Cloudflare.D1Database"], ["SupportLedger", "Cloudflare.D1Database"],
      ["Worker", "Cloudflare.Worker"], ["GitHubAppSecret", "GQSupport.GitHubAppSecret"]]) {
      requireEvidence(contract.graph.some((row) => row.fqn === fqn && row.type === type && row.kind === "resource"));
    }
    const expectedBindings = bindingSet(contract.bindings);
    requireEvidence(contract.bindings.some((b) => b.type === "durable_object_namespace") &&
      contract.bindings.filter((b) => b.type === "secrets_store_secret").length >= 2);
    for (const binding of contract.bindings) if (binding.type === "durable_object_namespace")
      requireEvidence(binding.script_name === undefined || binding.script_name === contract.script);
    requireEvidence(contract.databases.length === 2 && new Set(contract.databases.map((db) => db.fqn)).size === 2 &&
      new Set(contract.databases.map((db) => db.databaseId)).size === 2 && new Set(contract.databases.map((db) => db.databaseName)).size === 2);
    for (const db of contract.databases) requireEvidence(["SupportDB", "SupportLedger"].includes(db.fqn) &&
      uuid.test(db.databaseId) && typeof db.databaseName === "string" && db.databaseName.length > 0 &&
      typeof db.instanceId === "string" && db.instanceId.length > 0);
    const account = `/accounts/${ACCOUNT}`;
    const script = `${account}/workers/scripts/${contract.script}`;
    const allowed = new Set([`${account}/workers/subdomain`, `${script}/subdomain`, `${script}/deployments`,
      `${script}/versions/${contract.versionId}`, `${script}/content/v2`, ...contract.databases.map((db) => `${account}/d1/database/${db.databaseId}`)]);
    const get = async (path: string) => {
      requireEvidence(allowed.has(path));
      const response = await transport(`https://api.cloudflare.com/client/v4${path}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${readToken}` },
      });
      requireEvidence(!response.url || response.url === `https://api.cloudflare.com/client/v4${path}`);
      return { etag: response.headers.get("etag"), mainModule: response.headers.get("cf-entrypoint"), bytes: await boundedBody(response), type: response.headers.get("content-type") ?? "" };
    };
    const json = async (path: string) => {
      const response = await get(path);
      requireEvidence(response.type.startsWith("application/json"));
      const envelope = object(wireJson(response.bytes));
      requireEvidence(envelope.success === true && Array.isArray(envelope.errors) && envelope.errors.length === 0);
      return object(envelope.result);
    };
    const subdomain = (await json(`${account}/workers/subdomain`)).subdomain;
    requireEvidence(typeof subdomain === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(subdomain) &&
      contract.origin === `https://${contract.script}.${subdomain}.workers.dev`);
    const route = await json(`${script}/subdomain`);
    requireEvidence(route.enabled === true && route.previews_enabled === false);
    const deployment = async () => {
      const list = (await json(`${script}/deployments`)).deployments;
      requireEvidence(Array.isArray(list) && list.length > 0);
      const active = object(list[0]);
      requireEvidence(active.id === contract.deploymentId && Array.isArray(active.versions) && active.versions.length === 1);
      const version = object(active.versions[0]);
      requireEvidence(version.version_id === contract.versionId && version.percentage === 100);
    };
    await deployment();
    const version = await json(`${script}/versions/${contract.versionId}`);
    requireEvidence(version.id === contract.versionId && Number.isInteger(version.number) && Number(version.number) > 0 &&
      bindingSet(object(version.resources).bindings) === expectedBindings &&
      object(object(version.resources).script).etag === contract.scriptEtag);
    const bundle = await get(`${script}/content/v2`);
    // Strong ETag connects the content response to version.resources.script.
    // Never assume the script-wide content endpoint returns the active version.
    requireEvidence((bundle.etag === contract.scriptEtag || bundle.etag === `"${contract.scriptEtag}"`) &&
      bundle.mainModule === contract.mainModule && await bundleDigest(bundle.bytes, bundle.type, contract.mainModule) === contract.scriptDigest);
    for (const db of contract.databases) {
      const physical = await json(`${account}/d1/database/${db.databaseId}`);
      requireEvidence(physical.uuid === db.databaseId && physical.name === db.databaseName && physical.jurisdiction === "eu");
    }
    await deployment(); // Detect changes during code read; no CAS/ABA claim.
    return deepFreeze(contract);
  } catch { throw refusal(); }
}
function checkPaths(paths: readonly (readonly string[])[]) {
  requireEvidence(Array.isArray(paths) && paths.length > 0 && paths.length <= 256);
  for (const path of paths) requireEvidence(Array.isArray(path) && path.length > 0 && path.length < 32 &&
    path.every((key) => typeof key === "string" && /^[A-Za-z0-9_~-]+$/.test(key) && !["__proto__", "constructor", "prototype"].includes(key)));
}
function requiredPaths(value: unknown, paths: readonly (readonly string[])[]) {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      const parent = object(current);
      requireEvidence(Object.hasOwn(parent, key)); current = parent[key];
    }
    requireEvidence(current !== undefined && current !== null);
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}

// The only combined acquisition interface. Distinct tokens and transports;
// an interface value or verified:true cannot skip authenticated attestation.
export const acquireAttestedSnapshot = (manifest: ReviewedEndpoint, stateBearer: string, readToken: string,
  transports: { readonly cloudflare: typeof fetch; readonly state: typeof fetch }) => Effect.gen(function* () {
  credential(stateBearer); credential(readToken); requireEvidence(stateBearer !== readToken);
  const contract = yield* Effect.promise(() => attestEndpoint(manifest, readToken, transports.cloudflare));
  const snapshot = yield* acquireHttpSnapshot(contract, stateBearer, transports.state);
  const listed = yield* snapshot.list(contract.target);
  requireEvidence(listed.length === contract.graph.length && listed.every((fqn) => contract.graph.some((row) => row.fqn === fqn)));
  for (const expected of contract.graph) {
    const row = yield* snapshot.get({ ...contract.target, fqn: expected.fqn });
    requireEvidence(row);
    if (expected.kind === "action") requireEvidence(row.kind === "action" && row.actionType === expected.type);
    else requireEvidence(row.kind !== "action" && row.resourceType === expected.type && row.instanceId === expected.instanceId &&
      row.providerVersion === expected.providerVersion && (row.providerMode === undefined || row.providerMode === "live"));
    requiredPaths(row, expected.requiredPaths);
  }
  requiredPaths(yield* snapshot.getOutput(contract.target), contract.outputPaths);
  requireEvidence(contract.databases.length === 2 && new Set(contract.databases.map((db) => db.fqn)).size === 2);
  for (const db of contract.databases) {
    requireEvidence(["SupportDB", "SupportLedger"].includes(db.fqn));
    const row = yield* snapshot.get({ ...contract.target, fqn: db.fqn });
    requireEvidence(row && row.kind !== "action" && row.instanceId === db.instanceId &&
      row.attr?.databaseId === db.databaseId && row.attr?.databaseName === db.databaseName);
  }
  return snapshot;
}).pipe(Effect.catchCause(() => Effect.die(refusal())));
