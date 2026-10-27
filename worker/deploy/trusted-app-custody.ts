// Apply-only trusted broker operation. No graph/plan is imported in the RPC
// checker, and no state bearer is inherited by Wrangler or its subprocesses.
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { provisionAppKey, SUPPORT_ACCOUNT_ID } from "./github-app.ts";
import { provisionWebhookSecrets } from "./github-webhook-secrets.ts";
import type { AppSecretCustody } from "./github-app-secret.ts";
import { requireEvidence, refusal } from "./planning-state.ts";
import { boundedBody } from "./planning-read.ts";

export function trustedAppCustody(env: NodeJS.ProcessEnv, workerName: string, transport: typeof fetch, check: () => Promise<void>): AppSecretCustody {
  env = { ...env };
  requireEvidence(/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName));
  const request: typeof fetch = async (url, init) => {
    await check();
    const value = new URL(String(url));
    const secret = `/client/v4/accounts/${SUPPORT_ACCOUNT_ID}/workers/scripts/${workerName}/secrets`;
    requireEvidence(init?.redirect === "error" && !value.search && !value.hash && !value.username && !value.password &&
      ((String(url) === "https://api.github.com/app" && (init.method ?? "GET") === "GET") ||
        (value.origin === "https://api.cloudflare.com" && [secret, `${secret}/GITHUB_WEBHOOK_PREVIOUS_SECRET`].includes(value.pathname) &&
          ["PUT", "DELETE"].includes(init.method ?? ""))));
    const response = await transport(url, init);
    requireEvidence(!response.redirected && (!response.url || response.url === String(url)));
    // The old helper intentionally accepts 404 for previous-secret removal.
    if (response.status === 404 && init.method === "DELETE") return new Response(null, { status: 404 });
    const bytes = await boundedBody(response, 64 * 1024);
    return new Response(bytes, { headers: { "content-type": "application/json" } });
  };
  return {
    provisionKey: async (stage, worker) => { requireEvidence(stage === "prod" && worker === workerName); return provisionAppKey(stage, worker, env, request); },
    provisionWebhook: async (worker, appId) => { requireEvidence(worker === workerName); return provisionWebhookSecrets(worker, appId, env, request); },
    check: async (metadata, worker) => {
      requireEvidence(worker === workerName);
      await check();
      const scratch = mkdtempSync(join(tmpdir(), "gq-trusted-rpc-"));
      try {
        const entry = fileURLToPath(new URL("./trusted-app-rpc.ts", import.meta.url));
        const loader = fileURLToPath(new URL("./planning-loader.mjs", import.meta.url));
        // getPlatformProxy has no explicit credential parameter in Wrangler
        // 4.133.0. Confine its ambient auth to this dedicated trusted process.
        // It receives only the deployment token, never the App key/webhook or
        // state bearer. Its temporary preview session invokes one fixed RPC.
        const input = JSON.stringify({ metadata, worker });
        requireEvidence(Buffer.byteLength(input) <= 1024 && process.platform === "linux");
        const bytes = await new Promise<Buffer>((resolve, reject) => {
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
        requireEvidence(Object.keys(result).sort().join() === "appId,checkedAt" && Number.isSafeInteger(result.appId) && Number.isFinite(Date.parse(result.checkedAt)));
        return result;
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    },
  };
}
