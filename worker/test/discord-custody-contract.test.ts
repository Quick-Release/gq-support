// Adversarial helper regression: trusted custody must validate helper requests,
// rather than treating the helper as a grant for arbitrary secret operations.
import { expect, it, vi } from "vitest";
import { trustedDiscordCustody } from "../deploy/trusted-discord-custody.ts";
import { ACCOUNT } from "../deploy/planning-state.ts";
import { discord } from "./fixtures/discord-custody.ts";
import { discordApi, privateDiscordURL } from "./fixtures/discord-api.ts";
const mutation = vi.hoisted(() => ({ fault: "" }));
vi.mock("../deploy/discord-alert-secret.ts", async (load) => {
  const actual = await load<typeof import("../deploy/discord-alert-secret.ts")>();
  return { ...actual, provisionDiscordAlertSecret: (worker: string, env: NodeJS.ProcessEnv, request: typeof fetch) =>
    actual.provisionDiscordAlertSecret(worker, env, async (url, init) => {
      let target = String(url);
      const changed: RequestInit = { ...init };
      const body = JSON.parse(String(changed.body));
      if (mutation.fault === "name") body.name = "GITHUB_APP_PRIVATE_KEY";
      if (mutation.fault === "type") body.type = "plain_text";
      if (mutation.fault === "value") body.text = "true";
      if (mutation.fault === "extra") body.unreviewed = true;
      if (mutation.fault === "account") target = target.replace(ACCOUNT, "wrong-account");
      if (mutation.fault === "stage") target = target.replace("synthetic-worker", "synthetic-worker-staging");
      if (mutation.fault === "method") changed.method = "POST";
      if (mutation.fault === "order") target += "/DISCORD_ALERT_RELEASE";
      changed.body = JSON.stringify(body);
      return request(target, changed);
    }),
  };
});
it.each(["name", "type", "value", "extra", "account", "stage", "method", "order"])("denies wrong %s before authentication/dispatch and poisons custody", async (fault) => {
  mutation.fault = fault;
  const api = discordApi(), check = vi.fn(async () => {}), dispatch = vi.fn();
  const custody = trustedDiscordCustody({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "FAKE_ONLY", GITHUB_SHA: discord.release,
    DISCORD_ALERTS_ENABLED: "true", DISCORD_ALERT_WEBHOOK_URL: privateDiscordURL }, "synthetic-worker", { ...discord, enabled: true }, api.request, check, dispatch);
  await expect(custody.run()).rejects.toThrow("apply blocked");
  await expect(custody.run()).rejects.toThrow("apply blocked");
  expect(api.request).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
});
