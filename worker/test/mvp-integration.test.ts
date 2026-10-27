import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { GitHubAppSecret, GitHubAppSecretProvider } from "../deploy/github-app-secret.ts";
import { provisionDiscordAlertSecret } from "../deploy/discord-alert-secret.ts";
import { planningApplyBroker } from "../deploy/planning-apply-broker.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
import { assertIntegratedCustodyReady, integrationCodeBlockers } from "../deploy/planning-entry.ts";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("../deploy/github-app.ts", async (original) => ({ ...await original<object>(),
  provisionAppKey: async () => { calls.push("key"); return { appId: 123 }; },
}));
vi.mock("../deploy/github-webhook-secrets.ts", () => ({
  provisionWebhookSecrets: async () => { calls.push("webhook"); },
}));
vi.mock("../deploy/check-deployed-github-app.ts", async (original) => ({ ...await original<object>(),
  checkDeployedGitHubApp: async () => { calls.push("check"); return { appId: 123, checkedAt: "synthetic" }; },
}));
vi.mock("../deploy/discord-alert-secret.ts", async (original) => ({ ...await original<object>(),
  provisionDiscordAlertSecret: vi.fn(async () => { calls.push("discord"); }),
}));

describe("combined App and Discord custody", () => {
  it("retains Discord disable/removal/trace restoration in the ordinary apply provider", async () => {
    calls.length = 0;
    const provider = await Effect.runPromise(GitHubAppSecret.Provider.pipe(Effect.provide(GitHubAppSecretProvider())));
    // Exercise the provider lifecycle, rather than only the standalone helper.
    await Effect.runPromise(provider.reconcile({ news: { stage: "prod", workerName: "synthetic-worker" } } as Parameters<typeof provider.reconcile>[0]));
    expect(calls).toEqual(["key", "webhook", "discord", "check"]);
  });

  it("keeps injected protected custody free of ambient Discord I/O", async () => {
    calls.length = 0;
    const provider = await Effect.runPromise(GitHubAppSecret.Provider.pipe(Effect.provide(GitHubAppSecretProvider({
      provisionKey: async () => { calls.push("injected-key"); return { stage: "prod", appId: 123, clientId: "synthetic", slug: "getquick-support", fingerprint: "synthetic" }; },
      provisionWebhook: async () => { calls.push("injected-webhook"); },
      check: async () => { calls.push("injected-check"); return { appId: 123, checkedAt: "synthetic" }; },
    }))));
    await Effect.runPromise(provider.reconcile({ news: { stage: "prod", workerName: "synthetic-worker" } } as Parameters<typeof provider.reconcile>[0]));
    expect(calls).toEqual(["injected-key", "injected-webhook", "injected-check"]);
  });

  it("cannot report successful custody after failed Discord removal or trace read-back", async () => {
    calls.length = 0;
    vi.mocked(provisionDiscordAlertSecret).mockRejectedValueOnce(new Error("Discord alert Worker secret update failed"));
    const provider = await Effect.runPromise(GitHubAppSecret.Provider.pipe(Effect.provide(GitHubAppSecretProvider())));
    await expect(Effect.runPromise(provider.reconcile({ news: { stage: "prod", workerName: "synthetic-worker" } } as Parameters<typeof provider.reconcile>[0]))).rejects.toThrow("GitHub App secret provisioning failed");
    expect(calls).toEqual(["key", "webhook"]);
  });
});

describe("unsupported integrated Discord broker path stays closed", () => {
  it("blocks protected entry even with default-disabled alerts until the protocol covers verified removal and traces", () => {
    expect(integrationCodeBlockers).toEqual([expect.stringContaining("Discord")]);
    expect(() => assertIntegratedCustodyReady()).toThrow("apply blocked");
  });
  it.each([false, true])("cannot run the real Discord custody helper through the current broker (enabled=%s)", async (enabled) => {
    const { provisionDiscordAlertSecret: provision } = await vi.importActual<typeof import("../deploy/discord-alert-secret.ts")>("../deploy/discord-alert-secret.ts");
    const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true,
      result: { observability: { enabled: true, traces: { enabled: false } }, bindings: [] },
    }));
    const broker = planningApplyBroker({ stage: "prod", worker: "synthetic-worker", stateOrigin: "https://state.invalid",
      instances: { Worker: "worker-instance", GitHubAppSecret: "app-instance" }, bundle: "b".repeat(64), databases: [],
      app: { stage: "prod", appId: 123, clientId: "synthetic", slug: "getquick-support", fingerprint: "synthetic" },
    }, { cloudflareToken: "CF_SYNTHETIC", stateBearer: "STATE_SYNTHETIC", cloudflare: transport, state: transport,
      app: { provisionKey: vi.fn(), provisionWebhook: vi.fn(), check: vi.fn() },
    }, async () => {}, () => {});
    const bridge: typeof fetch = async (url, init) => {
      const result = await broker.handle({ op: "cloudflare", method: init?.method ?? "GET", url: String(url),
        body: Buffer.from(String(init?.body ?? "")).toString("base64"), contentType: new Headers(init?.headers).get("content-type") ?? "" }) as { body: string };
      return new Response(Buffer.from(result.body, "base64"), { headers: { "content-type": "application/json" } });
    };
    await expect(provision("synthetic-worker", { CLOUDFLARE_API_TOKEN: "SYNTHETIC_ONLY", DISCORD_ALERTS_ENABLED: String(enabled),
      DISCORD_ALERT_WEBHOOK_URL: `https://discord.com/api/webhooks/123456789012345678/${"x".repeat(64)}`, GITHUB_SHA: "b".repeat(40),
    }, bridge)).rejects.toThrow("Discord alert Worker secret update failed");
    expect(transport).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(broker.outcome()).toMatchObject({ closed: true, mutations: 0, completed: false });
  });
  it.each([
    ["PUT", "/secrets"], ["DELETE", "/secrets/DISCORD_ALERT_WEBHOOK_URL"], ["PATCH", "/script-settings"],
  ])("refuses Discord %s %s before any privileged dispatch", async (method, suffix) => {
    const transport = vi.fn<typeof fetch>();
    const broker = planningApplyBroker({ stage: "prod", worker: "synthetic-worker", stateOrigin: "https://state.invalid",
      instances: { Worker: "worker-instance", GitHubAppSecret: "app-instance" }, bundle: "b".repeat(64), databases: [],
      app: { stage: "prod", appId: 123, clientId: "synthetic", slug: "getquick-support", fingerprint: "synthetic" },
    }, { cloudflareToken: "CF_SYNTHETIC", stateBearer: "STATE_SYNTHETIC", cloudflare: transport, state: transport,
      app: { provisionKey: vi.fn(), provisionWebhook: vi.fn(), check: vi.fn() },
    }, async () => {}, () => {});
    await expect(broker.handle({ op: "cloudflare", method, url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/synthetic-worker${suffix}`,
      body: "", contentType: "" })).rejects.toThrow("apply blocked");
    expect(transport).not.toHaveBeenCalled();
    expect(broker.outcome()).toMatchObject({ closed: true, mutations: 0, completed: false });
  });
});
