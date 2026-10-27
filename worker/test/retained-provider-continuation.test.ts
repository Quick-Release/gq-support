import { createHash, generateKeyPairSync } from "node:crypto";
import { provisionAppKey } from "../deploy/github-app.ts";
import { provisionWebhookSecrets } from "../deploy/github-webhook-secrets.ts";
import { URL, fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { continueProtectedPlan, type ProtectedContinuation } from "../deploy/protected-plan-continuation.ts";
import { confinedInput } from "./fixtures/confined-input.ts";
import { approvalHttp, approvalPolicy } from "./fixtures/approval-http.ts";
import { sourceEvidence, digest } from "../deploy/planner-evidence.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
const repo = fileURLToPath(new URL("../../", import.meta.url));
function fixture(stage: "prod" | "staging" = "prod") {
  const policy = { ...approvalPolicy, stage };
  const input = confinedInput(stage);
  const worker = stage === "prod" ? "synthetic-worker" : "synthetic-worker-staging";
  const appId = stage === "prod" ? 123 : 234;
  const http = approvalHttp(policy);
  const calls: string[] = [];
  const state: Record<string, unknown>[] = [];
  const cf: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method} ${path}`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer CF_CREDENTIAL_CANARY");
    let result: unknown;
    if (path.endsWith("/settings")) result = { bindings: [], tags: [], observability: { issues: { enabled: false } } };
    else if (path.endsWith("/subdomain")) result = path.includes("/scripts/") ? { enabled: true, previews_enabled: false } : { subdomain: "synthetic" };
    else if (path.endsWith("/schedules")) result = { schedules: [{ cron: "* * * * *" }] };
    else if (init?.method === "PUT" && path.endsWith(`/${worker}`)) result = { id: worker, tag: "1".repeat(32) };
    else throw new Error("Unexpected first-party route");
    return Response.json({ success: true, errors: [], messages: [], result });
  };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const metadata = { stage, appId, slug: stage === "prod" ? "getquick-support" : "getquick-support-staging", clientId: `synthetic-client-${stage}`, fingerprint };
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "CF_CREDENTIAL_CANARY", GITHUB_APP_ID: String(appId), GITHUB_APP_SLUG: metadata.slug,
    GITHUB_APP_CLIENT_ID: metadata.clientId, GITHUB_APP_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: "WEBHOOK_CREDENTIAL_CANARY" };
  const appHttp: typeof fetch = async (url, init) => {
    expect(init?.redirect).toBe("error");
    if (String(url) === "https://api.github.com/app") return Response.json({ id: appId, client_id: metadata.clientId, slug: metadata.slug,
      owner: { login: "Quick-Release", type: "Organization" }, permissions: { issues: "write", metadata: "read" }, events: ["issues", "public", "repository"] });
    expect(String(url)).toMatch(new RegExp(`^https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${worker}/secrets`));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer CF_CREDENTIAL_CANARY");
    return Response.json({ success: true });
  };
  const { manifest: sourceManifest, ...source } = sourceEvidence(repo);
  const evidence = { ...source, target: digest("target"), state: digest("state"), window: digest("window") };
  const custody = { cloudflareToken: "CF_CREDENTIAL_CANARY", stateBearer: "STATE_CREDENTIAL_CANARY", cloudflare: cf,
    state: vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toMatch(new RegExp(`^/state/stacks/GQSupportWorker/stages/${stage}/(?:resources/(?:Worker|GitHubAppSecret)|output)$`));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer STATE_CREDENTIAL_CANARY");
      state.push(JSON.parse(String(init?.body))); return Response.json({});
    }),
    app: { provisionKey: vi.fn((stage: string, worker: string) => provisionAppKey(stage, worker, env, appHttp)), provisionWebhook: vi.fn((worker: string, appId: number) => provisionWebhookSecrets(worker, appId, env, appHttp)), check: vi.fn(async () => ({ appId, checkedAt: new Date().toISOString() })) },
  };
  const controller = new AbortController();
  const config: ProtectedContinuation = { repo, sourceManifest, input, app: metadata, policy, githubToken: "GITHUB_CREDENTIAL_CANARY", github: http.fetch,
    appCustody: () => custody.app, broker: { stage, worker, stateOrigin: "https://state.invalid", databases: input.databases }, custody, evidence,
    revalidate: async () => ({ ...evidence }), checkWindow: () => {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
    publish: (candidate) => {
      expect(JSON.stringify(candidate)).not.toMatch(/CANARY|fingerprint|instance|databaseId|private/);
      // GitHub timestamp precision is seconds. This is post-plan creation.
      setTimeout(() => http.approve(candidate, Math.floor(Date.now() / 1000) * 1000), 1100);
    },
  };
  return { config, calls, state, http, controller, app: custody.app };
}
describe.each(["prod", "staging"] as const)("%s retained offline native candidate -> authenticated approval -> installed provider apply", (stage) => {
  it("refuses interchanged stage metadata before any write", async () => {
    for (const part of ["app", "policy", "broker", "rows", "output", "worker", "databases"] as const) {
      const { config, calls, state } = fixture(stage);
      const other = fixture(stage === "prod" ? "staging" : "prod").config;
      if (part === "app" || part === "policy" || part === "broker") config[part] = other[part] as never;
      if (part === "rows" || part === "output") config.input = { ...config.input, [part]: other.input[part] };
      if (part === "worker") config.broker = { ...config.broker, worker: other.broker.worker };
      if (part === "databases") config.broker = { ...config.broker, databases: other.broker.databases };
      await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
      expect(calls).toEqual([]); expect(state).toEqual([]);
    }
  });
  it("applies the same native graph with real installed Worker reconcile and State commits, preserving both DB identities", async () => {
    const { config, calls, state, app } = fixture(stage);
    const ambient = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("AMBIENT_CANARY"));
    try {
      await expect(continueProtectedPlan(config)).resolves.toMatchObject({ status: "applied" });
      expect(calls.some((call) => call === `PUT /client/v4/accounts/${ACCOUNT}/workers/scripts/${config.broker.worker}`)).toBe(true);
      expect(app.provisionKey).toHaveBeenCalledOnce();
      expect(app.provisionWebhook).toHaveBeenCalledOnce(); expect(app.check).toHaveBeenCalledOnce();
      expect(state.some((row) => row.fqn === "Worker" && row.status === "updated")).toBe(true);
      expect(state.some((row) => row.fqn === "GitHubAppSecret" && row.status === "updated")).toBe(true);
      expect(state.filter((row) => row.fqn === "SupportDB" || row.fqn === "SupportLedger")).toHaveLength(0);
      expect(ambient).not.toHaveBeenCalled();
    } finally { ambient.mockRestore(); }
  }, 90_000);
  it.each(["source", "lockfiles", "migrations", "target", "state", "window"] as const)("invalidates changed %s before any write", async (key) => {
    const { config, calls, app } = fixture(stage); config.revalidate = async () => ({ ...config.evidence, [key]: "changed" });
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
    expect(calls).toEqual([]); expect(config.custody.state).not.toHaveBeenCalled(); expect(app.provisionKey).not.toHaveBeenCalled();
  }, 90_000);
  it.each(["SupportDB", "SupportLedger"] as const)("refuses a native %s update without D1 mutation", async (fqn) => {
    const { config, calls, state, app } = fixture(stage);
    const input = confinedInput(stage);
    Object.assign(input.rows.GQSupportWorker[stage][fqn].attr, { readReplication: { mode: "auto" } });
    config.input = input;
    let published = false; config.publish = () => { published = true; };
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
    expect(published).toBe(false); expect(calls).toEqual([]); expect(state).toEqual([]); expect(app.provisionKey).not.toHaveBeenCalled();
  }, 90_000);
  it.each(["old", "adopting"])("rejects even undefined %s recovery metadata before wire encoding", async (key) => {
    const { config, calls, state } = fixture(stage);
    const rows = config.input.rows as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    rows.GQSupportWorker[stage].SupportLedger[key] = undefined;
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
    expect(calls).toEqual([]); expect(state).toEqual([]);
  });
  it("cancels retained scope without authorizing providers", async () => {
    const { config, controller, calls } = fixture(stage); config.publish = () => controller.abort();
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked"); expect(calls).toEqual([]);
  }, 90_000);
  it.each(["abort", "window"])("prevents first State mutation when %s occurs during dispatch authentication", async (change) => {
    const { config, controller, calls, state, http, app } = fixture(stage);
    let reads = 0, open = true;
    config.checkWindow = () => { if (!open) throw new Error("window ended"); };
    config.github = async (url, init) => {
      const response = await http.fetch(url, init);
      // Two authenticated confirmations authorize the candidate. The third
      // exact-comment read guards its first State checkpoint dispatch.
      if (String(url).endsWith("/issues/comments/789") && ++reads === 3) {
        if (change === "abort") controller.abort();
        else open = false;
      }
      return response;
    };
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
    expect(reads).toBe(3);
    expect(calls).toEqual([]); expect(state).toEqual([]);
    expect(app.provisionKey).not.toHaveBeenCalled();
  }, 90_000);
  it("retains the native updating row after an uncertain upload and stops secret/output commits", async () => {
    const { config, state, app } = fixture(stage);
    const send = config.custody.cloudflare;
    let uploads = 0;
    config.custody = { ...config.custody, cloudflare: async (url, init) => {
      if (init?.method === "PUT") { uploads++; throw new Error("UNKNOWN_UPLOAD_OUTCOME_CANARY"); }
      return send(url, init);
    } };
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
    expect(uploads).toBe(1); expect(app.provisionKey).not.toHaveBeenCalled();
    expect(state).toHaveLength(1); expect(state[0].status).toBe("updating"); expect(state[0].old).toBeDefined();
  }, 90_000);
  it("revocation after script upload prevents subsequent state/custody operations", async () => {
    const { config, state, http, app } = fixture(stage);
    const send = config.custody.cloudflare;
    config.custody = { ...config.custody, cloudflare: async (url, init) => {
      const response = await send(url, init); if (init?.method === "PUT") http.remove(); return response;
    } };
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
    expect(app.provisionKey).not.toHaveBeenCalled(); expect(state).toHaveLength(1); expect(state[0].status).toBe("updating");
  }, 90_000);

  it("keeps partial secret reconciliation unsettled and never commits output or retries custody", async () => {
    const { config, state, app } = fixture(stage);
    app.provisionWebhook.mockRejectedValue(new Error("UNCERTAIN_SECRET_OUTCOME_CANARY"));
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
    expect(app.provisionKey).toHaveBeenCalledOnce(); expect(app.provisionWebhook).toHaveBeenCalledOnce(); expect(app.check).not.toHaveBeenCalled();
    expect(state.some((row) => row.fqn === "Worker" && row.status === "updated")).toBe(true);
    expect(state.at(-1)).toMatchObject({ fqn: "GitHubAppSecret", status: "updating" });
    expect(state.every((row) => row.fqn !== undefined)).toBe(true);
  }, 90_000);

});
