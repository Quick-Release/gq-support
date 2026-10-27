import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { trustedObserverCustody } from "../deploy/observer-read-secret.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
import { verifyDispatch } from "../deploy/protected-plan-continuation.ts";
import { discordApi } from "./fixtures/discord-api.ts";
const worker = "synthetic-worker";
function fixture(enabled: boolean, send?: typeof fetch, check = async () => {}, dispatch = () => {}) {
  const api = discordApi(worker), token = randomBytes(32).toString("hex");
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "FAKE_ONLY", ...(enabled ? { SUPPORT_OBSERVER_READ_TOKEN: token } : {}) };
  api.secrets.set("SUPPORT_OBSERVER_READ_TOKEN", randomBytes(32).toString("hex"));
  const binding = { enabled, stage: "staging" as const, release: "a".repeat(40), commitment: randomBytes(32).toString("hex") };
  return { api, token, env, binding, custody: trustedObserverCustody(env, worker, binding, send ?? api.request, check, dispatch) };
}
it.each([false, true])("owns the exact secret transition once (enabled=%s), without changing observability", async enabled => {
  const { api, token, env, binding, custody } = fixture(enabled);
  env.SUPPORT_OBSERVER_READ_TOKEN = randomBytes(32).toString("hex");
  await custody.run();
  expect(api.secrets.get("SUPPORT_OBSERVER_ENABLED")).toBe(String(enabled));
  expect(api.secrets.get("SUPPORT_OBSERVER_READ_TOKEN")).toBe(enabled ? token : undefined);
  expect(api.secrets.get("SUPPORT_OBSERVER_STAGE")).toBe(enabled ? "staging" : undefined);
  expect(api.secrets.get("SUPPORT_OBSERVER_RELEASE")).toBe(enabled ? binding.release : undefined);
  expect(api.observability.traces.enabled).toBe(false);
  expect(JSON.stringify(custody.binding)).not.toContain(token);
  expect(api.request.mock.calls.map(([, init]) => init?.method)).toEqual(enabled ? ["PUT", "GET", "PUT", "PUT", "PUT", "PUT", "GET"] : ["PUT", "GET", "DELETE", "DELETE", "DELETE", "GET"]);
  await expect(custody.run()).rejects.toThrow("apply blocked");
});
it.each([false, true])("stops at every nested abort/deadline/window boundary and never replays enabled=%s", async enabled => {
  const count = enabled ? 7 : 6;
  for (const fault of ["abort", "expiry", "window"]) for (let at = 1; at <= count + 1; at++) {
    const api = discordApi(worker), controller = new AbortController(); let calls = 0, now = 1, open = true;
    const local = () => { if (!open || controller.signal.aborted || now >= 2) throw new Error(); };
    const candidate = { candidate: "c".repeat(64), nonce: "d".repeat(64), readyAt: 0, expiresAt: 2 };
    const check = () => verifyDispatch(controller.signal, candidate, local, async () => {
      if (++calls === at) { if (fault === "abort") controller.abort(); if (fault === "expiry") now = 2; if (fault === "window") open = false; }
      return true;
    }, () => now);
    const { custody } = fixture(enabled, api.request, check, local);
    await expect(custody.run()).rejects.toThrow("apply blocked");
    expect(api.request).toHaveBeenCalledTimes(Math.min(at - 1, count));
    await expect(custody.run()).rejects.toThrow("apply blocked");
  }
});
it.each([false, true])("rejects every uncertain dispatch or malformed final readback enabled=%s", async enabled => {
  const count = enabled ? 7 : 6;
  for (let at = 1; at <= count; at++) {
    const api = discordApi(worker); let calls = 0;
    const send: typeof fetch = async (url, init) => { const result = await api.request(url, init); if (++calls === at) throw new Error(`gqcanary_${crypto.randomUUID()}`); return result; };
    const { custody } = fixture(enabled, send);
    await expect(custody.run()).rejects.toThrow(/^Protected planning evidence unavailable; apply blocked$/);
    expect(calls).toBe(at); await expect(custody.run()).rejects.toThrow("apply blocked"); expect(calls).toBe(at);
  }
  for (const fault of ["type", "duplicate", "retained", "logs", "traces"]) {
    const api = discordApi(worker); let reads = 0;
    const send: typeof fetch = async (url, init) => {
      const response = await api.request(url, init);
      if (init?.method !== "GET" || ++reads !== 2) return response;
      const body = await response.json() as { result: { bindings: { name: string; type: string }[]; observability: { logs: { enabled: boolean }; traces: { enabled: boolean } } } };
      if (fault === "type") body.result.bindings.find(b => b.name === "SUPPORT_OBSERVER_ENABLED")!.type = "plain_text";
      if (fault === "duplicate") body.result.bindings.push({ name: "SUPPORT_OBSERVER_ENABLED", type: "secret_text" });
      if (fault === "retained") { if (enabled) body.result.bindings = body.result.bindings.filter(b => b.name !== "SUPPORT_OBSERVER_STAGE"); else body.result.bindings.push({ name: "SUPPORT_OBSERVER_READ_TOKEN", type: "secret_text" }); }
      if (fault === "logs") body.result.observability.logs.enabled = false;
      if (fault === "traces") body.result.observability.traces.enabled = true;
      return Response.json(body);
    };
    await expect(fixture(enabled, send).custody.run()).rejects.toThrow("apply blocked");
  }
});
it("denies token/mode/account mismatches before any private dispatch", () => {
  for (const token of [undefined, "short", `gqcanary_${crypto.randomUUID()}`]) {
    const request = vi.fn<typeof fetch>(), { binding, env } = fixture(true);
    expect(() => trustedObserverCustody({ ...env, SUPPORT_OBSERVER_READ_TOKEN: token }, worker, binding, request, async () => {}, () => {})).toThrow();
    expect(request).not.toHaveBeenCalled();
  }
});
it("requires strict strings and exact public custody pins", () => {
  const { binding, env } = fixture(false), transport = vi.fn<typeof fetch>();
  for (const bad of [{ ...binding, release: [binding.release] }, { ...binding, commitment: [binding.commitment] },
    { ...binding, stage: "dev_test" }, { ...binding, extra: "unreviewed" }]) {
    expect(() => trustedObserverCustody(env, worker, bad as typeof binding, transport, async () => {}, () => {})).toThrow();
  }
  expect(transport).not.toHaveBeenCalled();
});
