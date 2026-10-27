import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfinedPlan, runOfflineModule } from "../deploy/planning-execution.ts";
import { SUPPORT_ACCOUNT_ID } from "../deploy/github-app.ts";

import { planningPreflight } from "../deploy/planning-preflight.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const accountId = SUPPORT_ACCOUNT_ID;
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("AMBIENT_FETCH_CANARY")); });
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
function fixture() {
  const database = (fqn: string, dir: string, id: number) => ({
    fqn, logicalId: fqn, instanceId: `instance-${fqn}`, resourceType: "Cloudflare.D1Database",
    providerVersion: 1, providerMode: "live", status: "created", downstream: ["Worker"], bindings: [], removalPolicy: "retain",
    props: { jurisdiction: "eu", migrations: dir },
    attr: { databaseId: `00000000-0000-4000-8000-00000000000${id}`, databaseName: `synthetic-${fqn}`, accountId, jurisdiction: "eu",
      migrationsDir: dir, migrationsTable: "__alchemy_migrations", migrationsHashes: Object.fromEntries(readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((n) => n.endsWith(".sql")).map((name) => [name, createHash("sha256").update(readFileSync(new URL(`../${dir}/${name}`, import.meta.url))).digest("hex")])) },
  });
  const rows = {
    SupportDB: database("SupportDB", "./migrations", 1), SupportLedger: database("SupportLedger", "./ledger-migrations", 2),
    Worker: { fqn: "Worker", logicalId: "Worker", instanceId: "instance-Worker", resourceType: "Cloudflare.Worker", providerVersion: 1, providerMode: "live", status: "created", downstream: ["GitHubAppSecret"], bindings: [], props: {}, attr: { accountId, workerName: "synthetic-worker", workerId: "00000000000000000000000000000001", url: "https://synthetic-worker.example.workers.dev", urls: ["https://synthetic-worker.example.workers.dev"], crons: ["* * * * *"], hash: {} } },
    GitHubAppSecret: { fqn: "GitHubAppSecret", logicalId: "GitHubAppSecret", instanceId: "instance-secret", resourceType: "GQSupport.GitHubAppSecret", providerVersion: 1, providerMode: "live", status: "created", downstream: [], bindings: [], props: { stage: "prod", workerName: "synthetic-worker" }, attr: {} },
  };
  return { target: { stack: "GQSupportWorker" as const, stage: "prod" as const }, databases: [
    { fqn: "SupportDB" as const, instanceId: "instance-SupportDB", databaseId: "00000000-0000-4000-8000-000000000001", databaseName: "synthetic-SupportDB" },
    { fqn: "SupportLedger" as const, instanceId: "instance-SupportLedger", databaseId: "00000000-0000-4000-8000-000000000002", databaseName: "synthetic-SupportLedger" },
  ], rows: { GQSupportWorker: { prod: rows } }, output: { GQSupportWorker: { prod: {} } } };
}
async function preflight() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return planningPreflight({ CLOUDFLARE_ACCOUNT_ID: accountId, GITHUB_APP_SLUG: "getquick-support", GITHUB_APP_CLIENT_ID: "synthetic-client", GITHUB_APP_ID: "123", GITHUB_WEBHOOK_SECRET: "WEBHOOK_CANARY",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }, async (url, init) => {
    expect(url).toBe("https://api.github.com/app"); expect(init?.redirect).toBe("error");
    return Response.json({ id: 123, slug: "getquick-support", client_id: "synthetic-client", owner: { login: "Quick-Release", type: "Organization" }, permissions: { issues: "write", metadata: "read" }, events: ["issues", "public", "repository"] });
  });
}
describe("offline shared declaration and installed providers", () => {
  it("refuses accidental unconfined direct invocation before graph imports", () => {
    const result = spawnSync(process.execPath, ["--import", join(repo, "worker/deploy/planning-runtime-guard.mjs"), "-e", "process.exit(23)"], { env: {}, encoding: "utf8" });
    expect(result.status).not.toBe(23);
    expect(result.stderr).toContain("Protected planning evidence unavailable; apply blocked");
  });
  it("plans the real four-resource application graph", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const summary = await runConfinedPlan(repo, fixture(), preflight);
      expect(summary).toEqual({ status: "planned", resources: { SupportDB: "noop", SupportLedger: "noop", Worker: "update", GitHubAppSecret: "update" } });
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  }, 90_000);
  it("blocks direct fetch, HTTP(S), HTTP2, TLS/TCP, DNS, UDP, host sockets and subprocess network", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "planning-host-canary-"));
    const hostFile = join(scratch, "private"); const canary = "PLANNING_CONFIDENTIAL_CANARY";
    writeFileSync(hostFile, canary);
    vi.stubEnv("PLANNING_CANARY", canary);
    vi.stubEnv("HTTP_PROXY", "http://1.1.1.1:80");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const output = await runOfflineModule(repo, "test/fixtures/planning-io-probe.mjs", { hostFile, canary });
      expect(JSON.parse(output)).toEqual({ denied: Array(13).fill(true) });
      expect(output).not.toContain(canary); expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { rmSync(scratch, { recursive: true, force: true }); vi.unstubAllEnvs(); log.mockRestore(); error.mockRestore(); }
  });
  it.each(["SupportDB", "SupportLedger", "Worker", "GitHubAppSecret"] as const)("refuses missing %s before ownership reads or bootstrap", async (fqn) => {
    const input = fixture(); delete (input.rows.GQSupportWorker.prod as Partial<typeof input.rows.GQSupportWorker.prod>)[fqn];
    await expect(runConfinedPlan(repo, input, preflight)).rejects.toThrow(/^Protected planning evidence unavailable; apply blocked$/);
  }, 90_000);
  it("refuses an independently tracked DiscordAlertSecret until its graph/provider/custody contract is reviewed", async () => {
    const input = fixture();
    Object.assign(input.rows.GQSupportWorker.prod, { DiscordAlertSecret: {
      ...input.rows.GQSupportWorker.prod.GitHubAppSecret,
      fqn: "DiscordAlertSecret", logicalId: "DiscordAlertSecret", instanceId: "synthetic-discord",
      resourceType: "GQSupport.DiscordAlertSecret",
    } });
    await expect(runConfinedPlan(repo, input, preflight)).rejects.toThrow(/^Protected planning evidence unavailable; apply blocked$/);
  }, 90_000);
  it("sanitizes preflight failure and refuses without executing the graph", async () => {
    await expect(runConfinedPlan(repo, fixture(), () => Promise.reject(new Error("PLANNING_CONFIDENTIAL_CANARY"))))
      .rejects.toThrow(/^Protected planning evidence unavailable; apply blocked$/);
  });

  it("plans native Plan/Apply/StateEncoding/HTTP fixtures through the shared declaration", async () => {
    const input = { ...fixture(), app: await preflight() };
    const result = JSON.parse(await runOfflineModule(repo, "test/fixtures/planning-native-fixture.ts", input));
    expect(result).toEqual({ status: "planned", resources: { SupportDB: "noop", SupportLedger: "noop", Worker: "update", GitHubAppSecret: "update" } });
  }, 90_000);

  it("removes all provider read/write/bootstrap/telemetry lifecycles and refuses POST queries", async () => {
    const result = JSON.parse(await runOfflineModule(repo, "test/fixtures/planning-provider-probe.mjs", {}));
    expect(result).toEqual({ denied: Array(20).fill(true) });
  });
  it("never emits raw state, Redacted payloads or progress", async () => {
    const input = fixture();
    Object.assign(input.output.GQSupportWorker.prod, { confidential: { __redacted__: "STATE_PAYLOAD_CANARY" } });
    Object.assign(input.rows.GQSupportWorker.prod.Worker.attr, { confidential: { __redacted__: "STATE_PAYLOAD_CANARY" } });
    const result = await runConfinedPlan(repo, input, preflight);
    expect(JSON.stringify(result)).not.toMatch(/CANARY|authorization|Bearer|fingerprint|instance|databaseId|hash/);
  }, 90_000);
  it("rejects disagreement with the independently supplied DB identities", async () => {
    const input = fixture(); input.databases[0].databaseId = "00000000-0000-4000-8000-000000000099";
    await expect(runConfinedPlan(repo, input, preflight)).rejects.toThrow(/^Protected planning evidence unavailable; apply blocked$/);
  }, 90_000);

});

describe("GitHub preflight transport isolation", () => {
  it.each([401, 403, 404, 429, 500, 302, "malformed", "oversize", "error"] as const)("refuses %s without retries, mutation or sensitive diagnostics", async (outcome) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://api.github.com/app"); expect(init?.method ?? "GET").toBe("GET"); expect(init?.redirect).toBe("error");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
      if (outcome === "error") throw new Error("SENSITIVE_HEADER_CANARY");
      if (typeof outcome === "number") return new Response(null, { status: outcome });
      return new Response(outcome === "oversize" ? "x".repeat(65537) : "SENSITIVE_HEADER_CANARY", { headers: { "content-type": "application/json" } });
    });
    await expect(planningPreflight({ CLOUDFLARE_ACCOUNT_ID: accountId, GITHUB_APP_SLUG: "getquick-support", GITHUB_APP_CLIENT_ID: "synthetic-client", GITHUB_APP_ID: "123", GITHUB_WEBHOOK_SECRET: "WEBHOOK_CANARY", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, transport)).rejects.toThrow(/^Protected planning evidence unavailable; apply blocked$/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
