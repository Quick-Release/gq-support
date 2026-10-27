import { discord } from "./fixtures/discord-custody.ts";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as execution from "../deploy/planning-execution.ts";
import { createHash, generateKeyPairSync } from "node:crypto";
import { trustedAppCustody } from "../deploy/trusted-app-custody.ts";
import type { AppSecretCustody } from "../deploy/github-app-secret.ts";
import { discordApi, privateDiscordURL } from "./fixtures/discord-api.ts";

import { URL, fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { continueProtectedPlan, type ProtectedContinuation } from "../deploy/protected-plan-continuation.ts";
import { confinedInput } from "./fixtures/confined-input.ts";
import { approvalHttp, approvalPolicy } from "./fixtures/approval-http.ts";
import { exclusiveLocalWindow, sourceEvidence, digest } from "../deploy/planner-evidence.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
// Only the remote RPC process is synthetic. The retained offline child still runs under bwrap.
vi.mock("node:child_process", async (load) => {
  const actual = await load<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (!Array.isArray(args[1]) || !args[1].some((arg) => arg.endsWith("/trusted-app-rpc.ts"))) return actual.spawn(...args);
    const options = args[2];
    expect(Object.keys(options?.env ?? {}).sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "HOME", "PATH", "WRANGLER_SEND_METRICS"]);
    expect(JSON.stringify(options?.env)).not.toContain(privateDiscordURL);
    const child = new EventEmitter(), output = new PassThrough();
    const stdin = new Writable({ write(chunk, _encoding, done) {
      const { metadata } = JSON.parse(String(chunk));
      queueMicrotask(() => { output.emit("data", Buffer.from(JSON.stringify({ appId: metadata.appId, checkedAt: new Date().toISOString() }))); child.emit("close", 0); });
      done();
    } });
    return Object.assign(child, { stdin, stdio: [stdin, null, null, output] });
  } };
});
const repo = fileURLToPath(new URL("../../", import.meta.url));
function fixture(stage: "prod" | "staging" = "prod", enabled = false) {
  const binding = { ...discord, enabled };
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
    GITHUB_SHA: binding.release, DISCORD_ALERTS_ENABLED: String(enabled), ...(enabled ? { DISCORD_ALERT_WEBHOOK_URL: privateDiscordURL } : {}),
    GITHUB_APP_CLIENT_ID: metadata.clientId, GITHUB_APP_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: "WEBHOOK_CREDENTIAL_CANARY" };
  const alerts = discordApi(worker);
  const appHttp: typeof fetch = async (url, init) => {
    expect(init?.redirect).toBe("error");
    if (String(url) === "https://api.github.com/app") return Response.json({ id: appId, client_id: metadata.clientId, slug: metadata.slug,
      owner: { login: "Quick-Release", type: "Organization" }, permissions: { issues: "write", metadata: "read" }, events: ["issues", "public", "repository"] });
    expect(String(url)).toMatch(new RegExp(`^https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${worker}/(?:secrets|settings|script-settings)`));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer CF_CREDENTIAL_CANARY");
    return alerts.request(url, init);
  };
  const { manifest: sourceManifest, ...source } = sourceEvidence(repo);
  const evidence = { ...source, target: digest("target"), state: digest("state"), window: digest("window") };
  let trusted: AppSecretCustody;
  const custody = { cloudflareToken: "CF_CREDENTIAL_CANARY", stateBearer: "STATE_CREDENTIAL_CANARY", cloudflare: cf,
    state: vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toMatch(new RegExp(`^/state/stacks/GQSupportWorker/stages/${stage}/(?:resources/(?:Worker|GitHubAppSecret)|output)$`));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer STATE_CREDENTIAL_CANARY");
      state.push(JSON.parse(String(init?.body))); return Response.json({});
    }),
    app: { discord: binding,
      provisionDiscord: vi.fn((worker: string) => trusted.provisionDiscord(worker)),
      provisionKey: vi.fn((stage: string, worker: string) => trusted.provisionKey(stage, worker)),
      provisionWebhook: vi.fn((worker: string, appId: number) => trusted.provisionWebhook(worker, appId)),
      check: vi.fn((metadata: Parameters<AppSecretCustody["check"]>[0], worker: string) => trusted.check(metadata, worker)),
    },
  };
  const controller = new AbortController();
  const config: ProtectedContinuation = { repo, sourceManifest, input, app: metadata, policy, githubToken: "GITHUB_CREDENTIAL_CANARY", github: http.fetch,
    appCustody: (check, dispatch) => { trusted = trustedAppCustody(env, worker, appHttp, check, dispatch, stage, binding); return custody.app; }, broker: { discord: binding, stage, worker, stateOrigin: "https://state.invalid", databases: input.databases }, custody, evidence,
    revalidate: async () => ({ ...evidence }), checkWindow: () => {}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
    publish: (candidate) => {
      expect(JSON.stringify(candidate)).not.toMatch(/CANARY|fingerprint|instance|databaseId|private/);
      // GitHub timestamp precision is seconds. This is post-plan creation.
      setTimeout(() => http.approve(candidate, Math.floor(Date.now() / 1000) * 1000), 1100);
    },
  };
  return { config, calls, state, http, controller, alerts, env, app: custody.app };
}
describe.each(["prod", "staging"] as const)("%s retained offline native candidate -> authenticated approval -> installed provider apply", (stage) => {
  it("refuses a release different from the reviewed candidate head before launching the offline child", async () => {
    const { config, state, calls } = fixture(stage);
    config.broker = { ...config.broker, discord: { ...discord, release: "e".repeat(40) } };
    config.publish = () => { throw new Error("unexpected candidate"); };
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
    expect(state).toEqual([]); expect(calls).toEqual([]);
  });
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
  it.each([false, true])("applies enabled=%s through the same native graph with real installed Worker reconcile and State commits, preserving both DB identities", async (enabled) => {
    const { config, calls, state, app, alerts, env } = fixture(stage, enabled);
    const publish = config.publish;
    config.publish = (candidate) => { publish(candidate); env.DISCORD_ALERT_WEBHOOK_URL = "mutated-after-candidate"; env.GITHUB_SHA = "e".repeat(40); env.DISCORD_ALERTS_ENABLED = String(!enabled); };
    const execute = execution.runOfflineModule;
    const offline = vi.spyOn(execution, "runOfflineModule").mockImplementation((repo, entry, input, channel) => {
      expect(JSON.stringify(input)).not.toContain(privateDiscordURL);
      expect(JSON.stringify(input)).not.toMatch(/STATE_CREDENTIAL_CANARY|PRIVATE KEY/);
      return execute(repo, entry, input, channel);
    });
    const ambient = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("AMBIENT_CANARY"));
    try {
      await expect(continueProtectedPlan(config)).resolves.toMatchObject({ status: "applied" });
      expect(calls.some((call) => call === `PUT /client/v4/accounts/${ACCOUNT}/workers/scripts/${config.broker.worker}`)).toBe(true);
      expect(app.provisionKey).toHaveBeenCalledOnce();
      expect(app.provisionWebhook).toHaveBeenCalledOnce(); expect(app.provisionDiscord).toHaveBeenCalledOnce(); expect(app.check).toHaveBeenCalledOnce();
      expect(state.some((row) => row.fqn === "Worker" && row.status === "updated")).toBe(true);
      expect(state.some((row) => row.fqn === "GitHubAppSecret" && row.status === "updated")).toBe(true);
      expect(state.filter((row) => row.fqn === "SupportDB" || row.fqn === "SupportLedger")).toHaveLength(0);
      expect(alerts.observability).toMatchObject({ logs: { enabled: true }, traces: { enabled: !enabled } });
      expect(alerts.secrets.get("DISCORD_ALERT_WEBHOOK_URL")).toBe(enabled ? privateDiscordURL : undefined);
      expect(alerts.secrets.get("DISCORD_ALERT_RELEASE")).toBe(enabled ? discord.release : undefined);
      expect(JSON.stringify(state)).not.toContain(privateDiscordURL);
      expect(alerts.request.mock.calls.every(([url]) => String(url).startsWith("https://api.cloudflare.com/"))).toBe(true);
      expect(ambient).not.toHaveBeenCalled();
    } finally { ambient.mockRestore(); offline.mockRestore(); }
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

  it.each([false, true])("retains the writer marker and native checkpoint after lost Discord response enabled=%s", async (enabled) => {
    const { config, state, app, alerts } = fixture(stage, enabled);
    const directory = mkdtempSync(join(tmpdir(), "discord-native-marker-")), path = join(directory, "lock");
    const now = Date.now();
    const spec = { target: config.input.target, id: "d".repeat(64), startsAt: now, expiresAt: now + 120_000,
      duty: "exclude-every-state-writer-and-endpoint-deployer" as const };
    const window = exclusiveLocalWindow(path, spec);
    config.checkWindow = window.check;
    const send = alerts.request.getMockImplementation()!;
    alerts.request.mockImplementation(async (url, init) => {
      const response = await send(url, init);
      if (String(init?.body).includes("DISCORD_ALERTS_ENABLED")) throw new Error(privateDiscordURL);
      return response;
    });
    try {
      await expect(window.runApply(() => continueProtectedPlan(config))).rejects.toThrow(/^Protected planning evidence unavailable; apply blocked$/);
      window.close();
      expect(existsSync(path)).toBe(true);
      expect(() => exclusiveLocalWindow(path, spec)).toThrow();
      expect(alerts.request).toHaveBeenCalledTimes(4); expect(app.check).not.toHaveBeenCalled();
      expect(state.at(-1)).toMatchObject({ fqn: "GitHubAppSecret", status: "updating" });
      expect(state.every((row) => row.fqn !== undefined)).toBe(true);
      expect(JSON.stringify(state)).not.toContain(privateDiscordURL);
    } finally { window.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 90_000);

  it("keeps partial secret reconciliation unsettled and never commits output or retries custody", async () => {
    const { config, state, app } = fixture(stage);
    app.provisionWebhook.mockRejectedValue(new Error("UNCERTAIN_SECRET_OUTCOME_CANARY"));
    await expect(continueProtectedPlan(config)).rejects.toThrow("apply blocked");
    expect(app.provisionKey).toHaveBeenCalledOnce(); expect(app.provisionWebhook).toHaveBeenCalledOnce(); expect(app.provisionDiscord).not.toHaveBeenCalled(); expect(app.check).not.toHaveBeenCalled();
    expect(state.some((row) => row.fqn === "Worker" && row.status === "updated")).toBe(true);
    expect(state.at(-1)).toMatchObject({ fqn: "GitHubAppSecret", status: "updating" });
    expect(state.every((row) => row.fqn !== undefined)).toBe(true);
  }, 90_000);

});
