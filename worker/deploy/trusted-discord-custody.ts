// Fixed helper protocol, not a child-accessible HTTP proxy.
import { isDeepStrictEqual } from "node:util";
import { checkedObservability, provisionDiscordAlertSecret, validateDiscordAlertConfig, validateDiscordBinding, type DiscordCustodyBinding } from "./discord-alert-secret.ts";
import { ACCOUNT, requireEvidence, refusal } from "./planning-state.ts";
import { boundedBody } from "./planning-read.ts";

export function trustedDiscordCustody(env: NodeJS.ProcessEnv, worker: string, binding: DiscordCustodyBinding,
  transport: typeof fetch, check: () => Promise<void>, dispatch: () => void) {
  env = { ...env }; binding = structuredClone(binding);
  validateDiscordBinding(binding); validateDiscordAlertConfig(env);
  requireEvidence(env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT && /^[a-z0-9][a-z0-9-]{0,62}$/.test(worker) &&
    binding.enabled === (env.DISCORD_ALERTS_ENABLED === "true") && binding.release === env.GITHUB_SHA &&
    (binding.enabled || env.DISCORD_ALERT_WEBHOOK_URL === undefined));
  const script = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${worker}`;
  const put = (name: string, text: string): [string, string, unknown] => ["PUT", "/secrets", { name, type: "secret_text", text }];
  const steps: [string, string, unknown?][] = [put("DISCORD_ALERTS_ENABLED", "false"), ["GET", "/settings"],
    ...(binding.enabled ? [put("DISCORD_ALERT_WEBHOOK_URL", env.DISCORD_ALERT_WEBHOOK_URL!), put("DISCORD_ALERT_RELEASE", binding.release), put("DISCORD_ALERTS_ENABLED", "true")]
      : [["DELETE", "/secrets/DISCORD_ALERT_WEBHOOK_URL"], ["DELETE", "/secrets/DISCORD_ALERT_RELEASE"]] as [string, string][]),
    ["GET", "/settings"], ...(!binding.enabled ? [["PATCH", "/script-settings"], ["GET", "/settings"]] as [string, string][] : []),
  ];
  let used = false, poisoned = false, cursor = 0;
  let observed: ReturnType<typeof checkedObservability> | undefined;
  // Exported closure only for use by the real helper and focused contract tests.
  const request: typeof fetch = async (url, init) => {
    try {
      requireEvidence(used && !poisoned);
      const step = steps[cursor++]; // consumed before authentication or dispatch
      requireEvidence(step && String(url) === script + step[1] && (init?.method ?? "GET") === step[0] && init?.redirect === "error");
      const expected = step[0] === "PATCH" ? { observability: { ...observed, traces: { ...observed?.traces, enabled: true } } } : step[2];
      requireEvidence(expected === undefined ? init?.body === undefined : typeof init?.body === "string" && isDeepStrictEqual(JSON.parse(init.body), expected));
      const headers = new Headers(init?.headers);
      requireEvidence(headers.get("authorization") === `Bearer ${env.CLOUDFLARE_API_TOKEN}` && headers.get("content-type") === "application/json");
      await check(); requireEvidence(!poisoned); dispatch(); // final synchronous local guard after authentication
      const response = await transport(url, init);
      requireEvidence(!response.redirected && (!response.url || response.url === String(url)));
      if (response.status === 404 && step[0] === "DELETE") return new Response(null, { status: 404 });
      requireEvidence(response.status === 200 && response.headers.get("content-type")?.startsWith("application/json"));
      const body = JSON.parse(Buffer.from(await boundedBody(response, 64 * 1024)).toString());
      requireEvidence(body.success === true);
      if (step[0] !== "GET") return Response.json({ success: true });
      observed = checkedObservability(body.result?.observability);
      requireEvidence(Array.isArray(body.result?.bindings));
      const bindings = body.result.bindings.map((b: { name?: unknown; type?: unknown }) => {
        requireEvidence(typeof b?.name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(b.name) && typeof b.type === "string" && ["secret_text", "plain_text", "d1"].includes(b.type));
        return { name: b.name, type: b.type };
      });
      return Response.json({ success: true, result: { bindings, observability: observed } });
    } catch { poisoned = true; throw refusal(); }
  };
  return Object.freeze({ binding: Object.freeze(binding), request,
    run: async () => {
      try {
        requireEvidence(!used && !poisoned); used = true;
        await provisionDiscordAlertSecret(worker, env, request);
        requireEvidence(cursor === steps.length && !poisoned);
        await check(); dispatch();
      } catch { poisoned = true; throw refusal(); }
    },
  });
}
