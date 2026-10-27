import { describe, expect, it, vi } from "vitest";
import { trustedDiscordCustody } from "../deploy/trusted-discord-custody.ts";
import { provisionDiscordAlertSecret } from "../deploy/discord-alert-secret.ts";
import { verifyDispatch } from "../deploy/protected-plan-continuation.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
import { discord } from "./fixtures/discord-custody.ts";
import { discordApi, privateDiscordURL } from "./fixtures/discord-api.ts";
const worker = "synthetic-worker";
const script = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${worker}`;
function fixture(enabled: boolean, request?: typeof fetch, check = async () => {}, dispatch = () => {}) {
  const api = discordApi(worker);
  // An old retained URL must also remain safe during disablement.
  api.secrets.set("DISCORD_ALERT_WEBHOOK_URL", privateDiscordURL);
  api.secrets.set("DISCORD_ALERT_RELEASE", "b".repeat(40));
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "FAKE_ONLY", DISCORD_ALERTS_ENABLED: String(enabled), GITHUB_SHA: discord.release,
    ...(enabled ? { DISCORD_ALERT_WEBHOOK_URL: privateDiscordURL } : {}) };
  const custody = trustedDiscordCustody(env, worker, { ...discord, enabled }, request ?? api.request, check, dispatch);
  return { custody, api, env };
}
describe.each([false, true])("bounded Discord custody enabled=%s", (enabled) => {
  const count = enabled ? 6 : 7;
  it("performs exactly the reviewed transition once and never contacts Discord", async () => {
    const { custody, api, env } = fixture(enabled);
    env.GITHUB_SHA = "e".repeat(40);
    if (enabled) Object.assign(env, { DISCORD_ALERT_WEBHOOK_URL: "changed private input" });
    await custody.run();
    expect(api.request).toHaveBeenCalledTimes(count);
    expect(api.request.mock.calls.every(([url]) => String(url).startsWith(script))).toBe(true);
    expect(api.observability).toMatchObject({ logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 }, traces: { enabled: !enabled } });
    expect(api.secrets.get("DISCORD_ALERTS_ENABLED")).toBe(String(enabled));
    expect(api.secrets.get("DISCORD_ALERT_WEBHOOK_URL")).toBe(enabled ? privateDiscordURL : undefined);
    expect(api.secrets.get("DISCORD_ALERT_RELEASE")).toBe(enabled ? discord.release : undefined);
    await expect(custody.run()).rejects.toThrow("apply blocked");
    expect(api.request).toHaveBeenCalledTimes(count);
  });
  it.each(Array.from({ length: count }, (_, i) => i + 1))("stops after HTTP failure/lost response at request %s without replay", async (at) => {
    for (const fault of ["http", "lost", "readback"]) {
      const api = discordApi(worker); let calls = 0;
      const request: typeof fetch = async (url, init) => {
        const response = await api.request(url, init);
        if (++calls === at) {
          if (fault === "lost") throw new Error(privateDiscordURL);
          return Response.json({ success: false, result: { private: privateDiscordURL } }, { status: fault === "http" ? 503 : 200 });
        }
        return response;
      };
      const { custody } = fixture(enabled, request);
      await expect(custody.run()).rejects.toThrow(/^Protected planning evidence unavailable; apply blocked$/);
      expect(calls).toBe(at);
      await expect(custody.run()).rejects.toThrow("apply blocked"); expect(calls).toBe(at);
    }
  });
  it.each(["abort", "expiry", "window"])("stops at every nested authentication boundary on %s", async (fault) => {
    for (let at = 1; at <= count + 1; at++) {
      const controller = new AbortController(); let calls = 0, now = 1, open = true;
      const candidate = { candidate: "c".repeat(64), nonce: "d".repeat(64), readyAt: 0, expiresAt: 2 };
      const local = () => { if (!open || controller.signal.aborted || now >= 2) throw new Error("expired"); };
      const check = () => verifyDispatch(controller.signal, candidate, local, async () => {
        if (++calls === at) { if (fault === "abort") controller.abort(); if (fault === "expiry") now = 2; if (fault === "window") open = false; }
        return true;
      }, () => now);
      const { custody, api } = fixture(enabled, undefined, check, local);
      await expect(custody.run()).rejects.toThrow("apply blocked");
      expect(api.request).toHaveBeenCalledTimes(Math.min(at - 1, count));
      await expect(custody.run()).rejects.toThrow("apply blocked");
    }
  });
  it.each(["traces-on", "traces-unknown", "logs-off", "unknown-settings", "wrong-type", "duplicate", "retained-credential", "changed-logs"])("denies unexpected %s readback", async (fault) => {
    const api = discordApi(worker); let reads = 0;
    const request: typeof fetch = async (url, init) => {
      const response = await api.request(url, init);
      if ((init?.method ?? "GET") !== "GET") return response;
      const body = await response.json() as { result: { bindings: { name: string; type: string }[];
        observability: { logs: { enabled: boolean; head_sampling_rate?: number }; traces: { enabled?: boolean }; unreviewed?: string } } }; reads++;
      if (fault === "traces-on") body.result.observability.traces.enabled = true;
      if (fault === "traces-unknown") delete body.result.observability.traces.enabled;
      if (fault === "logs-off") body.result.observability.logs.enabled = false;
      if (fault === "unknown-settings") body.result.observability.unreviewed = privateDiscordURL;
      if (reads === 2) {
        if (fault === "wrong-type") body.result.bindings.find((b: { name: string }) => b.name === "DISCORD_ALERTS_ENABLED")!.type = "plain_text";
        if (fault === "duplicate") body.result.bindings.push({ name: "DISCORD_ALERTS_ENABLED", type: "secret_text" });
        if (fault === "retained-credential") {
          if (enabled) body.result.bindings = body.result.bindings.filter((b: { name: string }) => b.name !== "DISCORD_ALERT_RELEASE");
          else body.result.bindings.push({ name: "DISCORD_ALERT_WEBHOOK_URL", type: "secret_text" });
        }
        if (fault === "changed-logs") body.result.observability.logs.head_sampling_rate = 0.5;
      }
      return Response.json(body);
    };
    const { custody } = fixture(enabled, request);
    await expect(custody.run()).rejects.toThrow("apply blocked");
    expect(api.request.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });
});

it.each(["logs", "traces", "url", "release"])("refuses failed final disabled %s restoration readback", async (fault) => {
  const api = discordApi(); let reads = 0;
  const request: typeof fetch = async (url, init) => {
    const response = await api.request(url, init);
    if ((init?.method ?? "GET") !== "GET" || ++reads !== 3) return response;
    const body = await response.json() as { result: { observability: { logs: { enabled: boolean }; traces: { enabled: boolean } }; bindings: { name: string; type: string }[] } };
    if (fault === "logs") body.result.observability.logs.enabled = false;
    if (fault === "traces") body.result.observability.traces.enabled = false;
    if (fault === "url" || fault === "release") body.result.bindings.push({ name: fault === "url" ? "DISCORD_ALERT_WEBHOOK_URL" : "DISCORD_ALERT_RELEASE", type: "secret_text" });
    return Response.json(body);
  };
  const { custody } = fixture(false, request);
  await expect(custody.run()).rejects.toThrow("apply blocked");
  await expect(custody.run()).rejects.toThrow("apply blocked"); expect(api.request).toHaveBeenCalledTimes(7);
});

it.each(["account", "mode", "revision", "commitment", "url", "disabled-url"])("denies mismatched private/public %s before network", (fault) => {
  const request = vi.fn<typeof fetch>();
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "FAKE_ONLY", GITHUB_SHA: discord.release, DISCORD_ALERTS_ENABLED: "true", DISCORD_ALERT_WEBHOOK_URL: privateDiscordURL };
  const binding = { ...discord, enabled: true };
  if (fault === "account") env.CLOUDFLARE_ACCOUNT_ID = "wrong";
  if (fault === "mode") binding.enabled = false;
  if (fault === "revision") env.GITHUB_SHA = "e".repeat(40);
  if (fault === "commitment") binding.commitment = "invalid";
  if (fault === "url") env.DISCORD_ALERT_WEBHOOK_URL += "?token=private";
  if (fault === "disabled-url") { env.DISCORD_ALERTS_ENABLED = "false"; binding.enabled = false; }
  expect(() => trustedDiscordCustody(env, worker, binding, request, async () => {}, () => {})).toThrow();
  expect(request).not.toHaveBeenCalled();
});

it.each([
  ["PUT", "/secrets", { name: "UNREVIEWED", type: "secret_text", text: "bad" }],
  ["PUT", "/secrets", { name: "DISCORD_ALERTS_ENABLED", type: "plain_text", text: "false" }],
  ["PUT", "/secrets", { name: "DISCORD_ALERTS_ENABLED", type: "secret_text", text: "true" }],
  ["DELETE", "/secrets/GITHUB_APP_PRIVATE_KEY", undefined],
  ["GET", "/settings?wrong-stage", undefined],
])("poisons an out-of-order %s %s before nested dispatch", async (method, path, body) => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const { custody, api } = fixture(true, undefined, () => paused);
  const run = custody.run();
  await expect(custody.request(script + path, { method, redirect: "error", body: body && JSON.stringify(body) })).rejects.toThrow("apply blocked");
  release(); await expect(run).rejects.toThrow("apply blocked");
  expect(api.request).not.toHaveBeenCalled();
});

it("also freezes ordinary helper environment before its first await", async () => {
  const api = discordApi(worker);
  const env = { DISCORD_ALERTS_ENABLED: "true", DISCORD_ALERT_WEBHOOK_URL: privateDiscordURL, GITHUB_SHA: discord.release, CLOUDFLARE_API_TOKEN: "FAKE_ONLY" };
  const promise = provisionDiscordAlertSecret(worker, env, api.request);
  env.DISCORD_ALERT_WEBHOOK_URL = "changed"; env.GITHUB_SHA = "e".repeat(40);
  await promise;
  expect(api.secrets.get("DISCORD_ALERT_WEBHOOK_URL")).toBe(privateDiscordURL);
  expect(api.secrets.get("DISCORD_ALERT_RELEASE")).toBe(discord.release);
});

it.each([
  { policy: ["accept"] }, { policy: ["authenticated"] }, { policy: {} },
  { policy: true }, { policy: 1 }, { policy: "unsupported" },
])("rejects malformed propagation policy $policy before restoration PATCH", async ({ policy }) => {
  const api = discordApi(worker);
  Object.assign(api.observability.traces, { propagation_policy: policy });
  const { custody } = fixture(false, api.request);
  await expect(custody.run()).rejects.toThrow("apply blocked");
  expect(api.request.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  const calls = api.request.mock.calls.length;
  await expect(custody.run()).rejects.toThrow("apply blocked");
  expect(api.request).toHaveBeenCalledTimes(calls);
});
it.each([null, "accept", "authenticated"])("normalizes supported propagation policy %s", async (policy) => {
  const api = discordApi(worker);
  Object.assign(api.observability.traces, { propagation_policy: policy });
  const { custody } = fixture(false, api.request);
  await custody.run();
  const patch = api.request.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(patch).toBeDefined();
  expect(JSON.parse(String(patch?.[1]?.body)).observability.traces.propagation_policy).toBe(policy ?? undefined);
});
