import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { attestEndpoint, acquireAttestedSnapshot, bundleDigest, type ReviewedEndpoint } from "../deploy/endpoint-attestation.ts";
import { ACCOUNT, STACK } from "../deploy/planning-state.ts";
import { MAX_BODY, boundedBody } from "../deploy/planning-read.ts";

const stateToken = "STATE_BEARER_CANARY";
const readToken = "CF_READ_TOKEN_CANARY";
const secret = "URL_HEADER_BODY_CANARY";
const versionId = "00000000-0000-4000-8000-000000000007";
const deploymentId = "00000000-0000-4000-8000-000000000008";
const bindings = [
  { type: "durable_object_namespace", name: "STORE", namespace_id: "a".repeat(32), class_name: "Store" },
  { type: "secrets_store_secret", name: "AUTH", store_id: "b".repeat(32), secret_name: "synthetic-auth" },
  { type: "secrets_store_secret", name: "ENCRYPTION", store_id: "b".repeat(32), secret_name: "synthetic-encryption" },
];
async function fixture() {
  const form = new FormData();
  form.append("main.js", new Blob(["export default {fetch(){}}"], { type: "application/javascript+module" }), "main.js");
  const content = new Response(form);
  const type = content.headers.get("content-type")!;
  const bytes = new Uint8Array(await content.arrayBuffer());
  const manifest: ReviewedEndpoint = {
    origin: "https://synthetic-store.synthetic-account.workers.dev", path: "/state", mainModule: "main.js", scriptEtag: "synthetic-content-hash", account: ACCOUNT,
    script: "synthetic-store", scriptDigest: await bundleDigest(bytes, type), protocol: 7,
    target: { stack: STACK, stage: "prod" }, versionId, deploymentId, bindings,
    graph: [["SupportDB", "Cloudflare.D1Database"], ["SupportLedger", "Cloudflare.D1Database"],
      ["Worker", "Cloudflare.Worker"], ["GitHubAppSecret", "GQSupport.GitHubAppSecret"]].map(([fqn, type]) => ({
        fqn, type, kind: "resource", instanceId: `instance-${fqn}`, providerVersion: 1, requiredPaths: [["attr"]],
      })), outputPaths: [["workerName"]],
    databases: ["SupportDB", "SupportLedger"].map((fqn, i) => ({ fqn: fqn as "SupportDB" | "SupportLedger",
      databaseId: `00000000-0000-4000-8000-00000000000${i + 1}`, databaseName: `fixture-${fqn}`, instanceId: `instance-${fqn}` })),
  };
  const calls: { url: string; init?: RequestInit }[] = [];
  const deployment = { deployments: [{ id: deploymentId, versions: [{ version_id: versionId, percentage: 100 }] }] };
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input); calls.push({ url, init });
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${readToken}`);
    expect(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/`)).toBe(true);
    if (url.endsWith("/content/v2")) return new Response(bytes, { headers: { "content-type": type, "cf-entrypoint": "main.js", etag: '"synthetic-content-hash"' } });
    const db = manifest.databases.find((db) => url.endsWith(`/d1/database/${db.databaseId}`));
    return envelope(db ? { uuid: db.databaseId, name: db.databaseName, jurisdiction: "eu" } :
      url.endsWith("/workers/subdomain") ? { subdomain: "synthetic-account" } :
      url.endsWith("/subdomain") ? { enabled: true, previews_enabled: false } :
      url.endsWith("/deployments") ? deployment : { id: versionId, number: 7, resources: { bindings, script: { etag: "synthetic-content-hash" } } });
  });
  return { manifest, transport, calls, bytes, type };
}
function envelope(result: unknown) { return Response.json({ success: true, errors: [], result }); }
afterEach(() => vi.restoreAllMocks());
describe("authenticated bounded endpoint attestation with synthetic first-party HTTP", () => {
  it("proves canonical account route, single active version, bundle, exact bindings and both physical DBs", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(secret));
    const f = await fixture();
    const contract = await attestEndpoint(f.manifest, readToken, f.transport);
    expect(contract).not.toBe(f.manifest); expect(Object.isFrozen(contract.bindings[0])).toBe(true);
    expect(f.calls).toHaveLength(8);
    expect(globalFetch).not.toHaveBeenCalled();
  });
  it.each(["account", "origin", "alias", "path", "script", "digest", "protocol", "version", "database", "bindings", "entrypoint", "etag"])("refuses reviewed %s mismatch", async (failure) => {
    const f = await fixture();
    const invalid = structuredClone(f.manifest);
    if (failure === "etag") Object.assign(invalid, { scriptEtag: "wrong" });
    if (failure === "entrypoint") Object.assign(invalid, { mainModule: "wrong.js" });
    if (failure === "account") Object.assign(invalid, { account: "wrong" });
    if (failure === "origin") Object.assign(invalid, { origin: `https://elsewhere.invalid/${secret}` });
    if (failure === "alias") Object.assign(invalid, { origin: "https://alias.synthetic-account.workers.dev" });
    if (failure === "path") Object.assign(invalid, { path: "/other" });
    if (failure === "script") Object.assign(invalid, { script: "../../other" });
    if (failure === "digest") Object.assign(invalid, { scriptDigest: "0".repeat(64) });
    if (failure === "protocol") Object.assign(invalid, { protocol: 5 });
    if (failure === "version") Object.assign(invalid, { versionId: "00000000-0000-4000-8000-000000000099" });
    if (failure === "database") Object.assign(invalid.databases[0], { databaseName: "wrong" });
    if (failure === "bindings") Object.assign(invalid.bindings[0], { namespace_id: "0".repeat(32) });
    await expect(attestEndpoint(invalid, readToken, f.transport)).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
  });
  it.each(["redirect", "redirected", "unavailable", "malformed", "missing", "version", "split", "changed", "route", "binding", "db", "oversized", "missing-etag", "content-version", "weak-etag"])("refuses %s metadata with sanitized diagnostics", async (failure) => {
    const f = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let deployments = 0;
    const transport: typeof fetch = async (input, init) => {
      if (failure === "redirect") return new Response(secret, { status: 302, headers: { location: `https://other.invalid/${secret}` } });
      if (failure === "redirected") { const r = envelope({}); Object.defineProperty(r, "redirected", { value: true }); return r; }
      if (failure === "unavailable") throw new Error(secret);
      if (failure === "malformed") return new Response(secret);
      if (failure === "oversized") return new Response(" ".repeat(MAX_BODY + 1));
      if (failure === "missing") return envelope({});
      const path = String(input);
      if (path.endsWith("/content/v2") && ["missing-etag", "content-version", "weak-etag"].includes(failure)) {
        const response = await f.transport(input, init);
        if (failure === "missing-etag") response.headers.delete("etag");
        else response.headers.set("etag", failure === "weak-etag" ? 'W/"synthetic-content-hash"' : '"different-version-content"');
        return response;
      }
      if (path.includes("/versions/") && failure === "version") return envelope({ id: "unexpected", resources: { bindings, script: { etag: "synthetic-content-hash" } }, number: 7 });
      if (path.endsWith("/deployments")) {
        deployments++;
        if (failure === "split") return envelope({ deployments: [{ id: deploymentId, versions: [{ version_id: versionId, percentage: 50 }, { version_id: versionId, percentage: 50 }] }] });
        if (failure === "changed" && deployments === 2) return envelope({ deployments: [] });
      }
      if (path.endsWith("/subdomain") && !path.endsWith("/workers/subdomain") && failure === "route") return envelope({ enabled: false, previews_enabled: false });
      if (path.includes("/versions/") && failure === "binding") return envelope({ id: versionId, number: 7, resources: { bindings: [] } });
      if (path.includes("/d1/") && failure === "db") return envelope({ uuid: "wrong", name: "wrong", jurisdiction: "eu" });
      return f.transport(input, init);
    };
    try { await attestEndpoint(f.manifest, readToken, transport); throw new Error("Expected refusal"); }
    catch (e) { expect(String(e)).toBe("Error: Protected planning evidence unavailable; apply blocked"); expect(String(e)).not.toContain(secret); expect(String(e)).not.toContain(readToken); }
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it("cannot acquire state through a claimed verified flag and never sends state bearer to metadata", async () => {
    const f = await fixture();
    const state = vi.fn<typeof fetch>();
    await expect(Effect.runPromise(acquireAttestedSnapshot(Object.assign(f.manifest, { verified: true }), stateToken, readToken,
      { cloudflare: async () => { throw new Error(secret); }, state }))).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
    expect(state).not.toHaveBeenCalled();
  });
  it.each(["ok", "protocol", "graph", "path", "type", "instance", "db", "output"])("checks combined attestation and decoded %s state", async (failure) => {
    const f = await fixture();
    const metadata = f.transport;
    const bypass = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(secret));
    const sourceRows = Object.fromEntries(f.manifest.graph.map((expected) => [expected.fqn, {
      fqn: expected.fqn, logicalId: expected.fqn, resourceType: expected.type, instanceId: expected.instanceId,
      providerVersion: 1, status: "created", downstream: [], bindings: [], removalPolicy: "retain",
      props: { jurisdiction: "eu" }, attr: expected.fqn.startsWith("Support") ? {
        accountId: ACCOUNT, jurisdiction: "eu", databaseId: f.manifest.databases.find((db) => db.fqn === expected.fqn)!.databaseId,
        databaseName: f.manifest.databases.find((db) => db.fqn === expected.fqn)!.databaseName,
      } : { workerName: "synthetic-worker" },
    }]));
    if (failure === "path") Object.assign(f.manifest.graph[2], { requiredPaths: [["attr", "absent"]] });
    if (failure === "type") Object.assign(sourceRows.Worker, { resourceType: "Unknown" });
    if (failure === "instance") Object.assign(sourceRows.Worker, { instanceId: "unknown" });
    if (failure === "db") sourceRows.SupportDB.attr.databaseId = "00000000-0000-4000-8000-000000000099";
    const state = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${stateToken}`);
      const url = new URL(String(input)); expect(url.origin).toBe(f.manifest.origin);
      const path = url.pathname;
      return Response.json(path === "/version" ? { version: failure === "protocol" ? 5 : 7 } : path.endsWith("/stages") ? ["prod"] :
        path.endsWith("/replaced-resources") ? [] : path.endsWith("/resources") ? Object.keys(sourceRows).filter((key) => failure !== "graph" || key !== "Worker") :
        path.endsWith("/output") ? (failure === "output" ? {} : { workerName: "synthetic-worker" }) : sourceRows[path.split("/").at(-1)!]);
    });
    const result = Effect.runPromise(acquireAttestedSnapshot(f.manifest, stateToken, readToken, { cloudflare: metadata, state }));
    if (failure === "ok") expect((await result).id).toBe("protected-snapshot");
    else await expect(result).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
    expect(metadata).toHaveBeenCalledTimes(8); expect(state).toHaveBeenCalled(); expect(bypass).not.toHaveBeenCalled();
  });
  it("bounds streaming responses without Content-Length", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY + 1)); controller.close(); } }));
    await expect(boundedBody(response)).rejects.toThrow("Protected planning evidence unavailable; apply blocked");
  });
  it("hashes multipart modules independently of boundary and refuses duplicate modules", async () => {
    const f = await fixture();
    const form = new FormData();
    form.append("main.js", new Blob(["export default {fetch(){}}"], { type: "application/javascript+module" }), "main.js");
    const response = new Response(form);
    expect(await bundleDigest(new Uint8Array(await response.arrayBuffer()), response.headers.get("content-type")!)).toBe(f.manifest.scriptDigest);
    form.append("main.js", new Blob(["bad"]), "main.js");
    const duplicate = new Response(form);
    await expect(bundleDigest(new Uint8Array(await duplicate.arrayBuffer()), duplicate.headers.get("content-type")!)).rejects.toThrow();
  });
});
