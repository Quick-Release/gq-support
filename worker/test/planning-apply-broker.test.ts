import { discord, observer } from "./fixtures/discord-custody.ts";
import { describe, expect, it, vi } from "vitest";
import { planningApplyBroker } from "../deploy/planning-apply-broker.ts";
import { verifyDispatch } from "../deploy/protected-plan-continuation.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
const app = { stage: "prod", clientId: "synthetic", slug: "getquick-support", appId: 123, fingerprint: "synthetic-public" };
const origin = "https://api.cloudflare.com";
const script = `${origin}/client/v4/accounts/${ACCOUNT}/workers/scripts/synthetic-worker`;
function fixture(check = vi.fn(async () => {}), dispatch = () => {}, stage: "prod" | "staging" = "prod") {
  const metadata = { ...app, stage, slug: stage === "prod" ? "getquick-support" : "getquick-support-staging" };
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, result: { observability: { issues: { enabled: false } } } }));
  const custody = { cloudflareToken: "CF_CANARY", stateBearer: "STATE_CANARY", cloudflare: transport, state: transport,
    app: { observer: { ...observer, stage }, discord, provisionDiscord: async () => {}, provisionKey: vi.fn(async () => metadata), provisionWebhook: vi.fn(async () => {}), check: vi.fn(async () => ({ appId: 123, checkedAt: new Date().toISOString() })) } };
  const broker = planningApplyBroker({ observer: { ...observer, stage }, discord, stage, instances: { Worker: "i", GitHubAppSecret: "j" }, bundle: "b".repeat(64), worker: "synthetic-worker", stateOrigin: "https://state.invalid", databases: [{ fqn: "SupportDB", databaseId: "db1", databaseName: "db1", instanceId: "d1" }, { fqn: "SupportLedger", databaseId: "db2", databaseName: "db2", instanceId: "d2" }], app: metadata }, custody, check, dispatch);
  return { broker, transport, custody, check };
}
describe("narrow real-provider broker", () => {
  it.each([
    ["GET", `${origin}/client/v4/accounts/other/workers/scripts/synthetic-worker/settings`],
    ["GET", `${script}/settings?token=bad`], ["GET", `${script}/../another/settings`],
    ["PUT", `${script}/secrets`], ["POST", `${origin}/client/v4/accounts/${ACCOUNT}/d1/database/db1/query`],
    ["DELETE", script], ["GET", "http://api.cloudflare.com/client/v4/accounts/x"],
  ])("denies %s %s and poisons the session before custody", async (method, url) => {
    const { broker, transport } = fixture();
    await expect(broker.handle({ op: "cloudflare", method, url, body: "", contentType: "" })).rejects.toThrow("apply blocked");
    await expect(broker.handle({ op: "cloudflare", method: "GET", url: script + "/settings", body: "", contentType: "" })).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["enabled", "release", "commitment"] as const)("denies interchanged Discord %s before transport", (key) => {
    const config = { observer, discord, stage: "prod" as const, instances: { Worker: "i", GitHubAppSecret: "j" }, bundle: "b".repeat(64), worker: "synthetic-worker", stateOrigin: "https://state.invalid", databases: [], app };
    const transport = vi.fn<typeof fetch>();
    const changed = { ...discord, [key]: key === "enabled" ? true : key === "release" ? "e".repeat(40) : "e".repeat(64) };
    expect(() => planningApplyBroker(config, { cloudflareToken: "CF_CANARY", stateBearer: "STATE_CANARY", cloudflare: transport, state: transport,
      app: { observer, discord: changed, provisionDiscord: async () => {}, provisionKey: async () => app, provisionWebhook: async () => {}, check: vi.fn() } }, async () => {}, () => {})).toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
  });
  it("returns no private response fields or binding values to the child", async () => {
    const { broker, transport } = fixture();
    transport.mockResolvedValueOnce(Response.json({ success: true, errors: [{ message: "PRIVATE_RESPONSE" }], result: {
      bindings: [{ type: "secret_text", name: "DISCORD_ALERT_WEBHOOK_URL", text: "PRIVATE_RESPONSE" }],
      observability: { issues: { enabled: false } }, private: "PRIVATE_RESPONSE",
    } }));
    const response = await broker.handle({ op: "cloudflare", method: "GET", url: script + "/settings", body: "", contentType: "" }) as { body: string };
    const text = Buffer.from(response.body, "base64").toString();
    expect(text).not.toMatch(/PRIVATE_RESPONSE|DISCORD_ALERT_WEBHOOK_URL/);
    expect(JSON.parse(text)).toEqual({ success: true, result: { bindings: [], observability: { issues: { enabled: false } } } });
  });
  it("authenticates at each call and never forwards child headers", async () => {
    const { broker, transport, check } = fixture();
    await broker.handle({ op: "cloudflare", method: "GET", url: script + "/settings", body: "", contentType: "" });
    expect(check).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer CF_CANARY");
  });
  it("revokes immediately before State writes", async () => {
    const { broker, transport } = fixture(vi.fn(async () => { throw new Error("REVOKED_CANARY"); }));
    await expect(broker.handle({ op: "state-set", fqn: "Worker", value: { fqn: "Worker", instanceId: "i", status: "updated" } })).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
  });
  it("rechecks the local grant synchronously after the authentication promise resolves", async () => {
    const { broker, transport } = fixture(vi.fn(async () => {}), () => { throw new Error("local grant expired"); });
    await expect(broker.handle({ op: "state-set", fqn: "Worker", value: { fqn: "Worker", instanceId: "i", status: "updated" } })).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["abort", "expiry", "window"])("denies a State dispatch after %s during authentication", async (change) => {
    const controller = new AbortController();
    let time = 1000, open = true;
    const candidate = { candidate: "b".repeat(64), nonce: "c".repeat(64), readyAt: 0, expiresAt: 2000 };
    const { broker, transport } = fixture(vi.fn(() => verifyDispatch(controller.signal, candidate,
      () => { if (!open) throw new Error("window ended"); }, async () => {
        if (change === "abort") controller.abort();
        if (change === "expiry") time = 2000;
        if (change === "window") open = false;
        return true;
      }, () => time)));
    await expect(broker.handle({ op: "state-set", fqn: "Worker", value: { fqn: "Worker", instanceId: "i", status: "updated" } })).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
    expect(broker.outcome()).toMatchObject({ closed: true, mutations: 0 });
  });
  it("preserves the native updating checkpoint and never retries uncertain commits", async () => {
    const { broker, transport } = fixture(); transport.mockRejectedValue(new Error("PRIVATE_TRANSPORT_CANARY"));
    const operation = { op: "state-set" as const, fqn: "Worker", value: { fqn: "Worker", instanceId: "i", status: "updating", old: { fqn: "Worker", instanceId: "i", status: "updated" } } };
    await expect(broker.handle(operation)).rejects.toThrow("apply blocked");
    await expect(broker.handle(operation)).rejects.toThrow("apply blocked"); expect(transport).toHaveBeenCalledOnce();
    expect(broker.outcome()).toEqual({ closed: true, mutations: 1, completed: false });
  });
  it("rejects replacement cleanup and premature secret/output operations", async () => {
    const { broker, transport } = fixture();
    await expect(broker.handle({ op: "state-set", fqn: "Worker", value: { fqn: "Worker", status: "replaced", old: {} } })).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
    const next = fixture(); await expect(next.broker.handle({ op: "app-key", worker: "synthetic-worker" })).rejects.toThrow("apply blocked");
    expect(next.custody.app.provisionKey).not.toHaveBeenCalled();
    await expect(fixture().broker.handle({ op: "state-output", value: {} })).rejects.toThrow("apply blocked");
  });
});

it("rejects changed approved bundle bytes before the script PUT", async () => {
  const app = { stage: "prod", clientId: "synthetic", slug: "getquick-support", appId: 123, fingerprint: "public" };
  const send = vi.fn<typeof fetch>();
  const broker = planningApplyBroker({ observer, discord, stage: "prod", worker: "synthetic-worker", stateOrigin: "https://state.invalid", instances: { Worker: "i", GitHubAppSecret: "j" }, databases: [{ fqn: "SupportDB", databaseId: "db1", databaseName: "db1", instanceId: "d1" }, { fqn: "SupportLedger", databaseId: "db2", databaseName: "db2", instanceId: "d2" }], app, bundle: "b".repeat(64) }, {
    cloudflareToken: "CF_CANARY", stateBearer: "STATE_CANARY", cloudflare: send, state: send,
    app: { observer, discord, provisionDiscord: async () => {}, provisionKey: async () => app, provisionWebhook: async () => {}, check: async () => ({ appId: 123, checkedAt: new Date().toISOString() }) },
  }, async () => {}, () => {});
  const form = new FormData();
  form.append("metadata", JSON.stringify({ main_module: "main.js", bindings: [{ type: "d1", name: "DB", id: "db1" }, { type: "d1", name: "LEDGER", id: "db2" }] }));
  form.append("main.js", new File(["changed code"], "main.js", { type: "application/javascript" }));
  const encoded = new Response(form);
  await expect(broker.handle({ op: "cloudflare", method: "PUT", url: script, contentType: encoded.headers.get("content-type")!, body: Buffer.from(await encoded.arrayBuffer()).toString("base64") })).rejects.toThrow("apply blocked");
  expect(send).not.toHaveBeenCalled();
});


describe.each(["prod", "staging"] as const)("%s broker stage isolation", (stage) => {
  it.each(["SupportDB", "SupportLedger", "../prod/Worker", "Worker/other"])("denies State resource %s before transport", async (fqn) => {
    const { broker, transport } = fixture(undefined, undefined, stage);
    await expect(broker.handle({ op: "state-set", fqn, value: {} })).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
  });
  it("denies another stage's App row even with the expected native instance", async () => {
    const { broker, transport } = fixture(undefined, undefined, stage);
    await expect(broker.handle({ op: "state-set", fqn: "GitHubAppSecret", value: {
      fqn: "GitHubAppSecret", instanceId: "j", status: "updated", props: { stage: stage === "prod" ? "staging" : "prod", workerName: "synthetic-worker" },
    } })).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
  });
  it("denies another reviewed Worker path", async () => {
    const { broker, transport } = fixture(undefined, undefined, stage);
    await expect(broker.handle({ op: "cloudflare", method: "GET", url: script.replace("synthetic-worker", "other-stage-worker") + "/settings", body: "", contentType: "" })).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
  });
});

it.each(["missing", "candidate", "stage", "secret", "duplicate"])("refuses %s public release identity before any native upload", async (change) => {
  const { broker, transport } = fixture();
  const bindings: Array<{ type: string; name: string; text?: string; id?: string }> = [
    { type: "d1", name: "DB", id: "db1" }, { type: "d1", name: "LEDGER", id: "db2" },
    { type: "plain_text", name: "SUPPORT_RELEASE_CANDIDATE", text: discord.release },
    { type: "plain_text", name: "SUPPORT_RELEASE_STAGE", text: "prod" },
  ];
  if (change === "missing") bindings.pop();
  if (change === "candidate") bindings[2].text = "e".repeat(40);
  if (change === "stage") bindings[3].text = "staging";
  if (change === "secret") bindings[2].type = "secret_text";
  if (change === "duplicate") bindings.push({ ...bindings[2] });
  const form = new FormData();
  form.append("metadata", JSON.stringify({ main_module: "main.js", bindings,
    observability: { enabled: true, logs: { enabled: true, invocation_logs: true }, traces: { enabled: false } } }));
  form.append("main.js", new File(["synthetic"], "main.js", { type: "application/javascript" }));
  const encoded = new Response(form);
  await expect(broker.handle({ op: "cloudflare", method: "PUT", url: script,
    contentType: encoded.headers.get("content-type")!, body: Buffer.from(await encoded.arrayBuffer()).toString("base64") })).rejects.toThrow("apply blocked");
  expect(transport).not.toHaveBeenCalled();
});
it.each(["SUPPORT_OBSERVER_ENABLED", "SUPPORT_OBSERVER_READ_TOKEN", "SUPPORT_OBSERVER_STAGE", "SUPPORT_OBSERVER_RELEASE"])("refuses App-owned %s through generic native upload before any privileged dispatch", async name => {
  const { planningBundleDigest } = await import("../deploy/planning-bundle.ts");
  const transport = vi.fn<typeof fetch>();
  const code = "export default {}", bundle = planningBundleDigest("main.js", [["main.js", code]]);
  const broker = planningApplyBroker({ observer, discord, stage: "prod", worker: "synthetic-worker", stateOrigin: "https://state.invalid",
    instances: { Worker: "i", GitHubAppSecret: "j" }, bundle, app,
    databases: [{ fqn: "SupportDB", databaseId: "db1", databaseName: "db1", instanceId: "d1" }, { fqn: "SupportLedger", databaseId: "db2", databaseName: "db2", instanceId: "d2" }] },
  { cloudflareToken: "FAKE_ONLY", stateBearer: "FAKE_ONLY", cloudflare: transport, state: transport,
    app: { observer, discord, provisionDiscord: async () => {}, provisionKey: vi.fn(), provisionWebhook: vi.fn(), check: vi.fn() } }, async () => {}, () => {});
  const form = new FormData();
  form.append("metadata", JSON.stringify({ main_module: "main.js", bindings: [
    { type: "d1", name: "DB", id: "db1" }, { type: "d1", name: "LEDGER", id: "db2" },
    { type: "plain_text", name: "SUPPORT_RELEASE_STAGE", text: "prod" }, { type: "plain_text", name: "SUPPORT_RELEASE_CANDIDATE", text: discord.release },
    { type: "plain_text", name, text: "unreviewed" }], observability: { enabled: true, logs: { enabled: true }, traces: { enabled: false } } }));
  form.append("main.js", new File([code], "main.js", { type: "application/javascript" }));
  const encoded = new Response(form);
  await expect(broker.handle({ op: "cloudflare", method: "PUT", url: script, contentType: encoded.headers.get("content-type")!,
    body: Buffer.from(await encoded.arrayBuffer()).toString("base64") })).rejects.toThrow("apply blocked");
  expect(transport).not.toHaveBeenCalled();
});
