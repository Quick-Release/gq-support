// Staging only. CI supplies the App key; raw deliveries and signatures never
// leave process memory. Only the allowlisted evidence object is printed.
import { createHmac, sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import { appConfig, verifyApp } from "../deploy/github-app.ts";

export const STAGING_WEBHOOK = "https://gqsupportworker-worker-staging-fzos3ewkrboeduj2.tipme.workers.dev/v1/github/webhooks";
const APP_ID = "5355960";
const INSTALLATION_ID = 172696674;
const PROBE_BODY = '{"gq_support_staging_probe":"café 🐙","action":"unsupported"}\r\n';

export const runWebhookSpike = async (operation: string, env = process.env, request = fetch): Promise<unknown> => {
  const config = appConfig("staging", env);
  const pem = env.GITHUB_APP_PRIVATE_KEY ?? "";
  const app = await verifyApp(config, pem, request);
  if (String(app.appId) !== APP_ID || env.GITHUB_APP_ID !== APP_ID || !env.GITHUB_WEBHOOK_SECRET) throw new Error("configuration");
  const api = async (path: string, method = "GET", body?: unknown) => {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: config.clientId })}`;
    const jwt = `${input}.${Buffer.from(sign("RSA-SHA256", Buffer.from(input), pem)).toString("base64url")}`;
    const response = await request(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json",
        "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gq-support-webhook-spike" },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`github_api_${response.status}`);
    return response;
  };

  const probe = async (secret: string, target = APP_ID) => {
    const response = await request(STAGING_WEBHOOK, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "ping", "X-GitHub-Delivery": crypto.randomUUID(),
        "X-GitHub-Hook-Installation-Target-Type": "integration", "X-GitHub-Hook-Installation-Target-ID": target,
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(PROBE_BODY).digest("hex")}` }, body: PROBE_BODY });
    return { status: response.status, bytes: Number(response.headers.get("x-gq-webhook-bytes")),
      key: response.headers.get("x-gq-webhook-key"), empty: (await response.text()) === "" };
  };
  if (operation === "configure") {
    await api("/app/hook/config", "PATCH", { url: STAGING_WEBHOOK, content_type: "json", insecure_ssl: "0", secret: env.GITHUB_WEBHOOK_SECRET });
    return { configured: true, url: STAGING_WEBHOOK, appId: APP_ID };
  }
  if (operation === "probe" || operation === "retired-probe") {
    if (operation === "retired-probe" && !env.GITHUB_WEBHOOK_PREVIOUS_SECRET) throw new Error("configuration");
    const current = await probe(env.GITHUB_WEBHOOK_SECRET);
    const wrongStage = await probe(env.GITHUB_WEBHOOK_SECRET, "5355963");
    const previous = env.GITHUB_WEBHOOK_PREVIOUS_SECRET ? await probe(env.GITHUB_WEBHOOK_PREVIOUS_SECRET) : undefined;
    if (current.status !== 204 || !current.empty || wrongStage.status !== 401 || !wrongStage.empty ||
        (previous && previous.status !== (operation === "retired-probe" ? 401 : 204))) throw new Error("probe_assertion");
    return { current, previous, wrongStage };
  }
  if (operation === "installation") {
    const installation = await (await api(`/app/installations/${INSTALLATION_ID}`)).json() as {
      account: { login: string }; repository_selection: string; app_id: number;
    };
    if (installation.account.login !== "Quick-Release" || installation.repository_selection !== "selected" || installation.app_id !== Number(APP_ID)) {
      throw new Error("installation_identity");
    }
    try {
      await api(`/app/installations/${INSTALLATION_ID}/suspended`, "PUT");
    } finally {
      // Always restore the sandbox installation, including a failed suspend response.
      await api(`/app/installations/${INSTALLATION_ID}/suspended`, "DELETE");
    }
    return { installationId: INSTALLATION_ID, suspendedAndRestored: true };
  }
  if (operation === "redeliver") {
    if (!/^[1-9][0-9]*$/.test(env.SPIKE_DELIVERY_ID ?? "")) throw new Error("delivery_id");
    await api(`/app/hook/deliveries/${env.SPIKE_DELIVERY_ID}/attempts`, "POST");
    return { redeliveryRequested: env.SPIKE_DELIVERY_ID };
  }
  if (operation === "collect") {
    // GitHub's live delivery IDs exceed Number.MAX_SAFE_INTEGER. Preserve the
    // decimal token before JSON.parse can round it and turn a detail GET into 404.
    const list = await (await api("/app/hook/deliveries?per_page=100")).text();
    const deliveries = JSON.parse(list.replace(/("id"\s*:\s*)([0-9]+)/g, '$1"$2"')) as Array<{
      id: string; guid: string; delivered_at: string; redelivery: boolean; event: string; action: string | null; status_code: number;
    }>;
    const rows = [];
    for (const delivery of deliveries) {
      if (env.SPIKE_SINCE && delivery.delivered_at < env.SPIKE_SINCE) continue;
      const detail = await (await api(`/app/hook/deliveries/${delivery.id}`)).json() as {
        url: string; request: { headers: Record<string, string> } | null; response: { headers: Record<string, string> } | null;
      };
      if (detail.url !== STAGING_WEBHOOK) continue;
      const sent = new Headers(detail.request?.headers ?? {});
      const received = new Headers(detail.response?.headers ?? {});
      const type = sent.get("x-github-hook-installation-target-type");
      const id = sent.get("x-github-hook-installation-target-id");
      const key = received.get("x-gq-webhook-key");
      const bytes = received.get("x-gq-webhook-bytes");
      // An explicit allowlist prevents arbitrary provider fields becoming logs.
      rows.push({ id: delivery.id, guid: /^[0-9a-f-]{36}$/.test(delivery.guid ?? "") ? delivery.guid : null, at: delivery.delivered_at, redelivery: delivery.redelivery,
        event: ["ping", "issues", "installation", "installation_repositories"].includes(delivery.event) ? delivery.event : "other",
        action: ["opened", "closed", "reopened", "created", "suspend", "unsuspend", "added", "removed"].includes(delivery.action ?? "") ? delivery.action : "other",
        status: delivery.status_code, targetType: type === "integration" ? type : "unexpected",
        targetId: id === APP_ID ? id : "unexpected", bytes: bytes && /^[0-9]+$/.test(bytes) ? Number(bytes) : null,
        key: key === "current" || key === "previous" ? key : null });
    }
    return { capturedAt: new Date().toISOString(), deliveries: rows };
  }
  throw new Error("operation");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(`GQ_WEBHOOK_EVIDENCE=${JSON.stringify(await runWebhookSpike(process.argv[2]))}`); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason = /^(github_api_[0-9]{3}|configuration|probe_assertion|installation_identity|delivery_id|operation)$/.test(message)
      ? message : error instanceof TypeError ? "type_error" : "unexpected";
    console.error(`Staging webhook spike failed (${reason}); credentials, signatures and payloads suppressed`);
    process.exitCode = 1;
  }
}
