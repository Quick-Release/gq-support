// Trusted, per-session first-party broker. No generic URL forwarding, state
// bearer, response headers, error bodies or credential enters the graph.
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import type { PersistedState } from "alchemy/State/State";
import { planningBundleDigest } from "./planning-bundle.ts";
import { requireEvidence, refusal, ACCOUNT, STACK } from "./planning-state.ts";
import { boundedBody, checkWire } from "./planning-read.ts";
import { checkChannelFrame, type BrokerOperation } from "./retained-child-channel.ts";
import type { AppSecretCustody } from "./github-app-secret.ts";

export interface ApplyBrokerConfig {
  readonly instances: Readonly<Record<"Worker" | "GitHubAppSecret", string>>;
  readonly bundle: string;
  readonly worker: string;
  readonly stateOrigin: string;
  readonly app: Awaited<ReturnType<AppSecretCustody["provisionKey"]>>;
  readonly databaseIds: readonly string[];
}
export interface ApplyBrokerCustody {
  readonly cloudflareToken: string;
  readonly stateBearer: string;
  readonly cloudflare: typeof fetch;
  readonly state: typeof fetch;
  readonly app: AppSecretCustody;
}
export function planningApplyBroker(config: ApplyBrokerConfig, custody: ApplyBrokerCustody, check: () => Promise<void>) {
  config = structuredClone(config);
  requireEvidence(/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.worker) && new URL(config.stateOrigin).origin === config.stateOrigin &&
    new URL(config.stateOrigin).protocol === "https:" && custody.cloudflareToken.length > 0 && custody.stateBearer.length > 0 &&
    !/\s/.test(custody.cloudflareToken + custody.stateBearer));
  const sameApp = (value: unknown) => {
    requireEvidence(value && typeof value === "object" && Object.keys(value).sort().join() === "appId,clientId,fingerprint,slug,stage");
    return (Object.keys(config.app) as (keyof typeof config.app)[]).every((key) => value[key as keyof typeof value] === config.app[key]);
  };
  const script = `/client/v4/accounts/${ACCOUNT}/workers/scripts/${config.worker}`;
  let closed = false, mutations = 0, requests = 0, completed = false;
  let key: Awaited<ReturnType<AppSecretCustody["provisionKey"]>> | undefined;
  let webhook = false, checked = false, uploaded = false;
  const once = new Set<string>();
  async function request(url: string, method: string, body: BodyInit | undefined, contentType: string, state = false) {
    requireEvidence(!closed && ++requests <= 64);
    // Immediately before EVERY operation, including every State write. State
    // drift checks belong at initial handoff; own writes then change that state.
    await check(); requireEvidence(!closed);
    if (method !== "GET") {
      const name = `${method}:${url}`;
      // State rows legitimately have updating + updated commits; other writes
      // never retry, even if a transport failed with an unknown outcome.
      if (!state) { requireEvidence(!once.has(name)); once.add(name); }
      mutations++;
    }
    const response = await (state ? custody.state : custody.cloudflare)(url, {
      method, body, redirect: "error", signal: AbortSignal.timeout(10_000), headers: {
        Authorization: `Bearer ${state ? custody.stateBearer : custody.cloudflareToken}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
    });
    requireEvidence(response.status === 200 && !response.redirected && (!response.url || response.url === url) &&
      response.headers.get("content-type")?.startsWith("application/json"));
    const bytes = await boundedBody(response);
    const result = JSON.parse(Buffer.from(bytes).toString()); checkWire(result);
    if (!state) requireEvidence(result.success === true);
    return bytes;
  }
  // Installed beta.83 HTTP State writer, with only exact project PUTs in
  // scope. No read/discovery/bootstrap/delete method gets a transport grant.
  let statePermit = false;
  const stateClient = HttpClient.make((req, url) => Effect.promise(async () => {
    requireEvidence(statePermit); statePermit = false; // native retry cannot resend an uncertain commit
    const stage = `/state/stacks/${STACK}/stages/prod`;
    requireEvidence(url.origin === config.stateOrigin && !url.search && !url.hash && !url.username && !url.password && req.method === "PUT" &&
      [stage + "/output", stage + "/resources/Worker", stage + "/resources/GitHubAppSecret"].includes(url.pathname) && req.body._tag === "Uint8Array" && req.body.body.byteLength <= 8 * 1024 * 1024);
    const bytes = await request(String(url), "PUT", Buffer.from(req.body.body), "application/json", true);
    return HttpClientResponse.fromWeb(req, new Response(bytes, { headers: { "content-type": "application/json" } }));
  }));
  const stateWriter = () => Effect.runPromise(makeHttpStateStore({ url: config.stateOrigin, authToken: custody.stateBearer, id: "protected-apply-http" }).pipe(Effect.provideService(HttpClient.HttpClient, stateClient)));
  return Object.freeze({
    close: () => { closed = true; },
    // Partial mutation counts stay private; a failed run must be incident
    // reconciled from authoritative state, never retried with this candidate.
    handle: async (operation: Exclude<BrokerOperation, { op: "authorize" }>): Promise<unknown> => {
      try {
        requireEvidence(!closed); checkChannelFrame(operation);
        if (operation.op === "cloudflare") {
          requireEvidence(Object.keys(operation).sort().join() === "body,contentType,method,op,url");
          const url = new URL(operation.url);
          requireEvidence(url.origin === "https://api.cloudflare.com" && !url.search && !url.hash && !url.username && !url.password &&
            typeof operation.body === "string" && operation.body.length <= 44 * 1024 * 1024);
          const body = Buffer.from(operation.body, "base64");
          requireEvidence(body.length <= 32 * 1024 * 1024 && body.toString("base64") === operation.body);
          const allowedGet = [`${script}/settings`, `${script}/subdomain`, `${script}/schedules`, `/client/v4/accounts/${ACCOUNT}/workers/subdomain`];
          if (operation.method === "GET") requireEvidence(allowedGet.includes(url.pathname) && body.length === 0);
          else if (operation.method === "PUT" && url.pathname === script) {
            requireEvidence(!uploaded && /^multipart\/form-data; boundary=/.test(operation.contentType));
            const form = await new Response(body, { headers: { "content-type": operation.contentType } }).formData();
            const raw = form.get("metadata"); requireEvidence(typeof raw === "string" || raw instanceof Blob);
            const metadata = JSON.parse(typeof raw === "string" ? raw : await raw.text());
            // This adapter supports the current D1-backed Worker only. It
            // grants no destructive DO lifecycle, assets, routes, or previews.
            requireEvidence(!metadata.migrations && !metadata.assets && !metadata.containers && !metadata.exports &&
              !metadata.tail_consumers && !metadata.streaming_tail_consumers && Array.isArray(metadata.bindings));
            const bindings = metadata.bindings.filter((binding: { type: string }) => binding.type === "d1");
            requireEvidence(bindings.length === 2 && new Set(bindings.map((binding: { id?: string; database_id?: string }) => binding.database_id ?? binding.id)).size === 2 &&
              bindings.every((binding: { id?: string; database_id?: string }) => config.databaseIds.includes(binding.database_id ?? binding.id ?? "")));
            const publicConfig: Record<string, string> = { GITHUB_APP_CLIENT_ID: config.app.clientId, GITHUB_APP_SLUG: config.app.slug, GITHUB_APP_ID: String(config.app.appId) };
            requireEvidence(metadata.bindings.every((binding: { type: string; name: string; text?: string }) =>
              ["d1", "plain_text"].includes(binding.type) || (binding.type === "secret_text" && Object.hasOwn(publicConfig, binding.name) && (binding.text === publicConfig[binding.name] || binding.text === JSON.stringify({ _tag: "Redacted", value: publicConfig[binding.name] })))));
            const modules: [string, Uint8Array][] = [];
            for (const [name, part] of form.entries()) {
              if (name === "metadata") continue;
              requireEvidence(part instanceof File && part.name === name);
              modules.push([name, new Uint8Array(await part.arrayBuffer())]);
            }
            requireEvidence(planningBundleDigest(metadata.main_module, modules) === config.bundle);
            uploaded = true;
          } else if (operation.method === "POST" && url.pathname === `${script}/subdomain`) {
            const settings = JSON.parse(body.toString());
            requireEvidence(Object.keys(settings).sort().join() === "enabled,previews_enabled" && settings.enabled === true && settings.previews_enabled === false);
          } else if (operation.method === "PUT" && url.pathname === `${script}/schedules`) {
            const schedules = JSON.parse(body.toString());
            requireEvidence(Array.isArray(schedules) && schedules.length === 1 && Object.keys(schedules[0]).join() === "cron" && schedules[0].cron === "* * * * *");
          } else throw refusal();
          const bytes = await request(String(url), operation.method, operation.method === "GET" ? undefined : body, operation.contentType);
          return { status: 200, body: Buffer.from(bytes).toString("base64") };
        }
        if (operation.op === "state-set" || operation.op === "state-output") {
          requireEvidence(Object.keys(operation).sort().join() === (operation.op === "state-set" ? "fqn,op,value" : "op,value"));
          const fqn = operation.op === "state-set" ? operation.fqn : undefined;
          requireEvidence(fqn === undefined || ["Worker", "GitHubAppSecret"].includes(fqn));
          if (fqn) {
            const row = operation.value as { fqn: string; instanceId: string; status: string; old?: { fqn: string; instanceId: string; status: string; old?: unknown }; resourceType: string; attr?: { databaseId?: string } };
            requireEvidence(row?.fqn === fqn && row.instanceId === config.instances[fqn as "Worker" | "GitHubAppSecret"] && ["updating", "updated", "created"].includes(row.status));
            // beta.83 writes an updating checkpoint containing the previous
            // settled row. This is not replacement cleanup; preserve it on
            // partial failure rather than erasing native recovery evidence.
            if (row.old) requireEvidence(row.status === "updating" && row.old.fqn === fqn && row.old.instanceId === row.instanceId &&
              ["created", "updated"].includes(row.old.status) && !row.old.old);
            if (fqn === "SupportDB" || fqn === "SupportLedger") requireEvidence(row.resourceType === "Cloudflare.D1Database" && config.databaseIds.includes(row.attr?.databaseId ?? ""));
          } else requireEvidence(checked); // output is a commit only after custody verification
          requireEvidence(!statePermit); statePermit = true;
          const writer = await stateWriter();
          if (fqn) await Effect.runPromise(writer.set({ stack: STACK, stage: "prod", fqn, value: operation.value as PersistedState }).pipe(Effect.provideService(HttpClient.HttpClient, stateClient)));
          else await Effect.runPromise(writer.setOutput({ stack: STACK, stage: "prod", value: operation.value }).pipe(Effect.provideService(HttpClient.HttpClient, stateClient)));
          if (!fqn) completed = true;
          return null;
        }
        requireEvidence(operation.worker === config.worker && uploaded);
        await check(); requireEvidence(!closed);
        if (operation.op === "app-key") {
          requireEvidence(Object.keys(operation).sort().join() === "op,worker" && !key);
          // Reserve before awaiting: an uncertain upload cannot replay.
          requireEvidence(!once.has("app-key")); once.add("app-key"); mutations++;
          key = await custody.app.provisionKey("prod", config.worker);
          requireEvidence(sameApp(key));
          return key;
        }
        if (operation.op === "app-webhook") {
          requireEvidence(Object.keys(operation).sort().join() === "appId,op,worker" && key && operation.appId === key.appId && !webhook);
          webhook = true; mutations++;
          await custody.app.provisionWebhook(config.worker, key.appId); return null;
        }
        requireEvidence(operation.op === "app-check" && Object.keys(operation).sort().join() === "metadata,op,worker" && key && webhook && !checked && sameApp(operation.metadata));
        checked = true;
        const result = await custody.app.check(key, config.worker);
        requireEvidence(result.appId === key.appId && Number.isFinite(Date.parse(result.checkedAt)));
        return result;
      } catch { closed = true; throw refusal(); }
    },
    outcome: () => Object.freeze({ closed, mutations, completed }),
  });
}
