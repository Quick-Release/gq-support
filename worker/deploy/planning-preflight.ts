// Credential-bearing code stays in the trusted launcher, before graph execution.
import { appConfig, verifyApp } from "./github-app.ts";
import { validateWebhookSecrets } from "./github-webhook-secrets.ts";
import { boundedBody, wireJson } from "./planning-read.ts";
import { refusal, requireEvidence } from "./planning-state.ts";

export async function planningPreflight(env: NodeJS.ProcessEnv, transport: typeof fetch) {
  try {
    const config = appConfig("prod", env);
    const result = await verifyApp(config, env.GITHUB_APP_PRIVATE_KEY ?? "", async (input, init) => {
      requireEvidence(input === "https://api.github.com/app" && (init?.method ?? "GET") === "GET" &&
        init?.body === undefined && init?.redirect === "error");
      const headers = new Headers(init.headers);
      requireEvidence([...headers.keys()].sort().join() === "accept,authorization,user-agent,x-github-api-version" &&
        /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(headers.get("authorization") ?? ""));
      // A dedicated first-party transport must honor redirect:error. No retry,
      // token minting, installation token API or response/log passthrough.
      const response = await transport(input, init);
      requireEvidence((!response.url || response.url === "https://api.github.com/app") &&
        response.headers.get("content-type")?.startsWith("application/json"));
      const value = wireJson(await boundedBody(response, 64 * 1024));
      return Response.json(value);
    });
    validateWebhookSecrets(env, result.appId);
    return result;
  } catch { throw refusal(); }
}
