// Apply-only trusted broker operation. No graph/plan is imported in the RPC
// checker, and no state bearer is inherited by Wrangler or its subprocesses.
import { isDeepStrictEqual } from "node:util";
import { trustedDiscordCustody } from "./trusted-discord-custody.ts";
import type { DiscordCustodyBinding } from "./discord-alert-secret.ts";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { provisionAppKey, SUPPORT_ACCOUNT_ID } from "./github-app.ts";
import { provisionWebhookSecrets } from "./github-webhook-secrets.ts";
import type { AppSecretCustody } from "./github-app-secret.ts";
import { requireEvidence, refusal, checkStage, protectedAppSlugs, type ProtectedStage } from "./planning-state.ts";
import { boundedBody } from "./planning-read.ts";

export function trustedAppCustody(env: NodeJS.ProcessEnv, workerName: string, transport: typeof fetch, check: () => Promise<void>, dispatch: () => void, targetStage: ProtectedStage, discord: DiscordCustodyBinding): AppSecretCustody {
  env = { ...env };
  checkStage(targetStage);
  requireEvidence(env.GITHUB_APP_SLUG === protectedAppSlugs[targetStage]);
  const alerts = trustedDiscordCustody(env, workerName, discord, transport, check, dispatch);
  let running = false, closed = false, phase = 0, ticket = 0;
  const expected: [string, string, unknown?][] = [
    ["GET", "https://api.github.com/app"],
    ["PUT", "", { name: "GITHUB_APP_PRIVATE_KEY", type: "secret_text", text: env.GITHUB_APP_PRIVATE_KEY }],
    ["PUT", "", { name: "GITHUB_WEBHOOK_SECRET", type: "secret_text", text: env.GITHUB_WEBHOOK_SECRET }],
    env.GITHUB_WEBHOOK_PREVIOUS_SECRET ? ["PUT", "", { name: "GITHUB_WEBHOOK_PREVIOUS_SECRET", type: "secret_text", text: env.GITHUB_WEBHOOK_PREVIOUS_SECRET }] : ["DELETE", "/GITHUB_WEBHOOK_PREVIOUS_SECRET"],
  ];
  const guard = async <T>(next: number, run: () => Promise<T>): Promise<T> => {
    try { requireEvidence(!closed && !running && phase === next); running = true; phase++; return await run(); }
    catch { closed = true; throw refusal(); }
    finally { running = false; }
  };
  let provisioned: Awaited<ReturnType<typeof provisionAppKey>> | undefined;
  requireEvidence(/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName));
  const request: typeof fetch = async (url, init) => {
    try {
      requireEvidence(!closed);
      const step = expected[ticket++];
      const value = new URL(String(url));
      const secret = `/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${workerName}/secrets`;
      requireEvidence(init?.redirect === "error" && !value.search && !value.hash && !value.username && !value.password &&
        ((String(url) === "https://api.github.com/app" && (init.method ?? "GET") === "GET") ||
          (value.origin === "https://api.cloudflare.com" && [secret, `${secret}/GITHUB_WEBHOOK_PREVIOUS_SECRET`].includes(value.pathname) &&
            ["PUT", "DELETE"].includes(init.method ?? ""))));
      requireEvidence(step && (init?.method ?? "GET") === step[0] && String(url) === (step[1] === "https://api.github.com/app" ? step[1] : `https://api.cloudflare.com${secret}${step[1]}`) &&
        (step[2] === undefined ? init?.body === undefined : typeof init?.body === "string" && isDeepStrictEqual(JSON.parse(init.body), step[2])));
      await check(); requireEvidence(!closed);
      // Authenticate the public App response against reviewed custody metadata
      // before the key helper can reach its subsequent secret PUT.
      dispatch();
      const response = await transport(url, init);
      requireEvidence(!response.redirected && (!response.url || response.url === String(url)));
      // The old helper intentionally accepts 404 for previous-secret removal.
      if (response.status === 404 && init.method === "DELETE") return new Response(null, { status: 404 });
      const bytes = await boundedBody(response, 64 * 1024);
      if (String(url) === "https://api.github.com/app") {
        const app = JSON.parse(Buffer.from(bytes).toString()) as { id?: number; client_id?: string; slug?: string };
        requireEvidence(String(app.id) === env.GITHUB_APP_ID && app.client_id === env.GITHUB_APP_CLIENT_ID && app.slug === protectedAppSlugs[targetStage]);
      }
      requireEvidence(response.ok);
      return new Response(bytes, { headers: { "content-type": "application/json" } });
    } catch { closed = true; throw refusal(); }
  };
  return {
    discord: alerts.binding,
    provisionDiscord: (worker) => guard(2, async () => { requireEvidence(worker === workerName); await alerts.run(); }),
    provisionKey: (stage, worker) => guard(0, async () => { requireEvidence(stage === targetStage && worker === workerName); provisioned = await provisionAppKey(stage, worker, env, request); return provisioned; }),
    provisionWebhook: (worker, appId) => guard(1, async () => { requireEvidence(worker === workerName && provisioned && appId === provisioned.appId); return provisionWebhookSecrets(worker, appId, env, request); }),
    check: (metadata, worker) => guard(3, async () => {
      requireEvidence(worker === workerName && provisioned &&
        metadata.clientId === provisioned.clientId && metadata.slug === provisioned.slug && metadata.fingerprint === provisioned.fingerprint &&
        "appId" in metadata && metadata.appId === provisioned.appId && metadata.stage === targetStage && metadata.slug === protectedAppSlugs[targetStage]);
      await check();
      const scratch = mkdtempSync(join(tmpdir(), "gq-trusted-rpc-"));
      try {
        const entry = fileURLToPath(new URL("./trusted-app-rpc.ts", import.meta.url));
        const loader = fileURLToPath(new URL("./planning-loader.mjs", import.meta.url));
        // getPlatformProxy has no explicit credential parameter in Wrangler
        // 4.133.0. Confine its ambient auth to this dedicated trusted process.
        // It receives only the deployment token, never the App key/webhook or
        // state bearer. Its temporary preview session invokes one fixed RPC.
        const input = JSON.stringify({ metadata, worker, stage: targetStage });
        requireEvidence(Buffer.byteLength(input) <= 1024 && process.platform === "linux");
        const bytes = await new Promise<Buffer>((resolve, reject) => {
          dispatch();
          const child = spawn(process.execPath, ["--import", loader, entry], {
            cwd: scratch, env: { HOME: scratch, PATH: "/usr/bin:/bin", CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
              CLOUDFLARE_ACCOUNT_ID: SUPPORT_ACCOUNT_ID, WRANGLER_SEND_METRICS: "false" },
            stdio: ["pipe", "ignore", "ignore", "pipe"], detached: true,
          });
          let bytes = Buffer.alloc(0), failed = false;
          const stopGroup = () => {
            if (!child.pid) return;
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failed = true; }
          };
          const fail = () => { failed = true; stopGroup(); };
          const timer = setTimeout(fail, 30_000);
          EventEmitter.prototype.on.call(child, "error", fail); child.stdin!.on("error", fail);
          const output = child.stdio[3]; requireEvidence(output && "on" in output);
          output.on("error", fail);
          output.on("data", (chunk: Buffer) => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 1024) fail(); });
          EventEmitter.prototype.on.call(child, "close", (code: number | null) => {
            clearTimeout(timer); stopGroup();
            if (failed || code !== 0) reject(refusal()); else resolve(bytes);
          });
          child.stdin!.end(input);
        });
        await check();
        const result = JSON.parse(String(bytes)) as { appId: number; checkedAt: string };
        requireEvidence(Object.keys(result).sort().join() === "appId,checkedAt" && result.appId === provisioned.appId && Number.isFinite(Date.parse(result.checkedAt)));
        return result;
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }),
  };
}
