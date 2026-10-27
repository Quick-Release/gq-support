import { describe, expect, it, vi } from "vitest";
import { planningApplyBroker } from "../deploy/planning-apply-broker.ts";
import { verifyDispatch } from "../deploy/protected-plan-continuation.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
const app = { stage: "prod", clientId: "synthetic", slug: "getquick-support", appId: 123, fingerprint: "synthetic-public" };
const origin = "https://api.cloudflare.com";
const script = `${origin}/client/v4/accounts/${ACCOUNT}/workers/scripts/synthetic-worker`;
function fixture(check = vi.fn(async () => {}), dispatch = () => {}, stage: "prod" | "staging" = "prod") {
  const metadata = { ...app, stage, slug: stage === "prod" ? "getquick-support" : "getquick-support-staging" };
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, result: {} }));
  const custody = { cloudflareToken: "CF_CANARY", stateBearer: "STATE_CANARY", cloudflare: transport, state: transport,
    app: { provisionKey: vi.fn(async () => metadata), provisionWebhook: vi.fn(async () => {}), check: vi.fn(async () => ({ appId: 123, checkedAt: new Date().toISOString() })) } };
  const broker = planningApplyBroker({ stage, instances: { Worker: "i", GitHubAppSecret: "j" }, bundle: "b".repeat(64), worker: "synthetic-worker", stateOrigin: "https://state.invalid", databases: [{ fqn: "SupportDB", databaseId: "db1", databaseName: "db1", instanceId: "d1" }, { fqn: "SupportLedger", databaseId: "db2", databaseName: "db2", instanceId: "d2" }], app: metadata }, custody, check, dispatch);
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
  const broker = planningApplyBroker({ stage: "prod", worker: "synthetic-worker", stateOrigin: "https://state.invalid", instances: { Worker: "i", GitHubAppSecret: "j" }, databases: [{ fqn: "SupportDB", databaseId: "db1", databaseName: "db1", instanceId: "d1" }, { fqn: "SupportLedger", databaseId: "db2", databaseName: "db2", instanceId: "d2" }], app, bundle: "b".repeat(64) }, {
    cloudflareToken: "CF_CANARY", stateBearer: "STATE_CANARY", cloudflare: send, state: send,
    app: { provisionKey: async () => app, provisionWebhook: async () => {}, check: async () => ({ appId: 123, checkedAt: new Date().toISOString() }) },
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
