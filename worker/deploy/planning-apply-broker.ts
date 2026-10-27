import { validateObserverBinding, type ObserverCustodyBinding } from "./observer-read-secret.ts";
// Trusted, per-session first-party broker. No generic URL forwarding, state
// bearer, response headers, error bodies or credential enters the graph.
import { checkedObservability, validateDiscordBinding, type DiscordCustodyBinding } from "./discord-alert-secret.ts";
import { isDeepStrictEqual } from "node:util";
import { d1MigrationSession, type D1MigrationGrant } from "./d1-migration-profile.ts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import type { DatabaseIdentity } from "./native-plan-policy.ts";
import type { PersistedState } from "alchemy/State/State";
import { planningBundleDigest } from "./planning-bundle.ts";
import { requireEvidence, refusal, ACCOUNT, STACK, checkStage, protectedAppSlugs, type ProtectedStage } from "./planning-state.ts";
import { boundedBody, checkWire } from "./planning-read.ts";
import { checkChannelFrame, type BrokerOperation } from "./retained-child-channel.ts";
import type { AppSecretCustody } from "./github-app-secret.ts";

export interface ApplyBrokerConfig {
  readonly observer: ObserverCustodyBinding;
  readonly discord: DiscordCustodyBinding;
  readonly migrations?: readonly D1MigrationGrant[];
  readonly stage: ProtectedStage;
  readonly instances: Readonly<Record<"Worker" | "GitHubAppSecret", string>>;
  readonly bundle: string;
  readonly worker: string;
  readonly stateOrigin: string;
  readonly app: Awaited<ReturnType<AppSecretCustody["provisionKey"]>>;
  readonly databases: readonly DatabaseIdentity[];
}
export interface ApplyBrokerCustody {
  readonly cloudflareToken: string;
  readonly stateBearer: string;
  readonly cloudflare: typeof fetch;
  readonly state: typeof fetch;
  readonly app: AppSecretCustody;
}
export function planningApplyBroker(config: ApplyBrokerConfig, custody: ApplyBrokerCustody, check: () => Promise<void>, dispatch: () => void) {
  config = structuredClone(config);
  checkStage(config.stage);
  validateDiscordBinding(config.discord);
  validateObserverBinding(config.observer);
  requireEvidence(config.observer.stage === config.stage && config.observer.release === config.discord.release && isDeepStrictEqual(config.observer, custody.app.observer));
  requireEvidence(isDeepStrictEqual(config.discord, custody.app.discord));
  requireEvidence(config.app.stage === config.stage && config.app.slug === protectedAppSlugs[config.stage]);
  requireEvidence(/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.worker) && new URL(config.stateOrigin).origin === config.stateOrigin &&
    new URL(config.stateOrigin).protocol === "https:" && custody.cloudflareToken.length > 0 && custody.stateBearer.length > 0 &&
    !/\s/.test(custody.cloudflareToken + custody.stateBearer));
  const sameApp = (value: unknown) => {
    requireEvidence(value && typeof value === "object" && Object.keys(value).sort().join() === "appId,clientId,fingerprint,slug,stage");
    return (Object.keys(config.app) as (keyof typeof config.app)[]).every((key) => value[key as keyof typeof value] === config.app[key]);
  };
  const migrations = (config.migrations ?? []).map((grant) => {
    requireEvidence(config.databases.some((db) => JSON.stringify(db) === JSON.stringify(grant.identity)));
    return { grant, session: d1MigrationSession(grant) };
  });
  requireEvidence(new Set(migrations.map(({ grant }) => grant.identity.fqn)).size === migrations.length);
  const script = `/client/v4/accounts/${ACCOUNT}/workers/scripts/${config.worker}`;
  let busy = false;
  let closed = false, mutations = 0, requests = 0, completed = false;
  let key: Awaited<ReturnType<AppSecretCustody["provisionKey"]>> | undefined;
  let webhook = false, discord = false, checked = false, uploaded = false;
  const once = new Set<string>();
  async function request(url: string, method: string, body: BodyInit | undefined, contentType: string, state = false, d1 = false) {
    requireEvidence(!closed && ++requests <= 64);
    // Immediately before EVERY operation, including every State write. State
    // drift checks belong at initial handoff; own writes then change that state.
    if (method !== "GET") {
      const name = `${method}:${url}`;
      // State rows have updating + updated commits. D1 has a separate consumed
      // exact-query sequence; other writes get one ticket per method/URL.
      if (!state && !d1) { requireEvidence(!once.has(name)); once.add(name); }
    }
    await check(); requireEvidence(!closed); dispatch();
    if (method !== "GET") mutations++;
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
    const stage = `/state/stacks/${STACK}/stages/${config.stage}`;
    requireEvidence(url.origin === config.stateOrigin && !url.search && !url.hash && !url.username && !url.password && req.method === "PUT" &&
      [stage + "/output", stage + "/resources/Worker", stage + "/resources/GitHubAppSecret", ...migrations.map(({ grant }) => stage + "/resources/" + grant.identity.fqn)].includes(url.pathname) && req.body._tag === "Uint8Array" && req.body.body.byteLength <= 8 * 1024 * 1024);
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
        requireEvidence(!closed && !busy); busy = true; checkChannelFrame(operation);
        if (operation.op === "cloudflare") {
          requireEvidence(Object.keys(operation).sort().join() === "body,contentType,method,op,url");
          const url = new URL(operation.url);
          requireEvidence(url.origin === "https://api.cloudflare.com" && !url.search && !url.hash && !url.username && !url.password &&
            typeof operation.body === "string" && operation.body.length <= 44 * 1024 * 1024);
          const body = Buffer.from(operation.body, "base64");
          requireEvidence(body.length <= 32 * 1024 * 1024 && body.toString("base64") === operation.body);
          const d1 = migrations.find(({ session }) => url.pathname === session.base || url.pathname === session.base + "/query");
          if (d1) {
            const validate = d1.session.request(url.pathname, operation.method, body, operation.contentType);
            const bytes = await request(String(url), operation.method, operation.method === "GET" ? undefined : body, operation.contentType, false, true);
            const safe = validate(JSON.parse(Buffer.from(bytes).toString()));
            return { status: 200, body: Buffer.from(JSON.stringify(safe)).toString("base64") };
          }
          if (operation.method !== "GET") requireEvidence(migrations.every(({ session }) => session.settled()));
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
            requireEvidence(checkedObservability(metadata.observability).traces.enabled === false);
            requireEvidence(metadata.bindings.every((binding: { name?: string }) => ![
              "DISCORD_ALERTS_ENABLED", "DISCORD_ALERT_WEBHOOK_URL", "DISCORD_ALERT_RELEASE",
              "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_WEBHOOK_PREVIOUS_SECRET",
            ].includes(binding.name ?? "")));
            const bindings = metadata.bindings.filter((binding: { type: string }) => binding.type === "d1");
            requireEvidence(bindings.length === 2 && new Set(bindings.map((binding: { id?: string; database_id?: string }) => binding.database_id ?? binding.id)).size === 2 &&
              bindings.every((binding: { id?: string; database_id?: string }) => config.databases.map((db) => db.databaseId).includes(binding.database_id ?? binding.id ?? "")));
            // Public immutable release identity is part of this exact retained
            // native upload in both Discord modes, never a custody secret or a
            // mutable runtime environment assertion.
            for (const [name, text] of Object.entries({ SUPPORT_RELEASE_CANDIDATE: config.discord.release, SUPPORT_RELEASE_STAGE: config.stage })) {
              const matches = metadata.bindings.filter((binding: { name: string }) => binding.name === name);
              requireEvidence(matches.length === 1 && matches[0].type === "plain_text" && matches[0].text === text);
            }
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
          const result = JSON.parse(Buffer.from(bytes).toString()).result;
          let safe: unknown;
          if (url.pathname.endsWith("/settings")) {
            // Installed reconcile only needs Issues state here; no binding values or response text.
            requireEvidence(result?.observability?.issues?.enabled === false);
            safe = { bindings: [], observability: { issues: { enabled: false } } };
          } else if (url.pathname.endsWith("/subdomain")) {
            if (url.pathname.includes("/scripts/")) {
              requireEvidence(typeof result?.enabled === "boolean" && typeof result.previews_enabled === "boolean");
              safe = { enabled: result.enabled, previews_enabled: result.previews_enabled };
            } else {
              requireEvidence(typeof result?.subdomain === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(result.subdomain));
              safe = { subdomain: result.subdomain };
            }
          } else if (url.pathname.endsWith("/schedules")) {
            requireEvidence(Array.isArray(result?.schedules) && result.schedules.length === 1 && result.schedules[0].cron === "* * * * *");
            safe = { schedules: [{ cron: "* * * * *" }] };
          } else { requireEvidence(result?.id === config.worker && /^[a-f0-9]{32}$/.test(result.tag)); safe = { id: config.worker, tag: result.tag }; }
          return { status: 200, body: Buffer.from(JSON.stringify({ success: true, result: safe })).toString("base64") };
        }
        if (operation.op === "state-set" || operation.op === "state-output") {
          requireEvidence(Object.keys(operation).sort().join() === (operation.op === "state-set" ? "fqn,op,value" : "op,value"));
          const fqn = operation.op === "state-set" ? operation.fqn : undefined;
          const d1 = migrations.find(({ grant }) => grant.identity.fqn === fqn);
          requireEvidence(fqn === undefined || ["Worker", "GitHubAppSecret"].includes(fqn) || d1);
          if (d1) d1.session.state(operation.value);
          else if (fqn) {
            requireEvidence(migrations.every(({ session }) => session.settled()));
            const row = operation.value as { fqn: string; instanceId: string; status: string; old?: { fqn: string; instanceId: string; status: string; old?: unknown }; resourceType: string; attr?: { databaseId?: string } };
            requireEvidence(row?.fqn === fqn && row.instanceId === config.instances[fqn as "Worker" | "GitHubAppSecret"] && ["updating", "updated", "created"].includes(row.status));
            // beta.83 writes an updating checkpoint containing the previous
            // settled row. This is not replacement cleanup; preserve it on
            // partial failure rather than erasing native recovery evidence.
            if (row.old) requireEvidence(row.status === "updating" && row.old.fqn === fqn && row.old.instanceId === row.instanceId &&
              ["created", "updated"].includes(row.old.status) && !row.old.old);
            if (fqn === "GitHubAppSecret" && row.status !== "updating") requireEvidence(checked && discord);
            for (const value of [operation.value, row.old].filter(Boolean)) {
              const saved = value as { props?: { stage?: string; workerName?: string }; attr?: { workerName?: string; accountId?: string; stage?: string; slug?: string } };
              if (fqn === "GitHubAppSecret") {
                requireEvidence(saved.props?.stage === config.stage && saved.props.workerName === config.worker);
                if (saved.attr?.stage !== undefined) requireEvidence(saved.attr.stage === config.stage && saved.attr.slug === config.app.slug);
              } else if (saved.attr?.workerName !== undefined) requireEvidence(saved.attr.workerName === config.worker && saved.attr.accountId === ACCOUNT);
            }
          } else {
            requireEvidence(checked && discord && migrations.every(({ session }) => session.settled())); // output is a commit only after custody verification
            const output = operation.value as Record<string, unknown>;
            const db = config.databases.find((db) => db.fqn === "SupportDB");
            const ledger = config.databases.find((db) => db.fqn === "SupportLedger");
            requireEvidence(output && Object.keys(output).sort().join() === "databaseId,databaseName,ledgerDatabaseId,ledgerDatabaseName,url,workerName" &&
              output.workerName === config.worker && typeof output.url === "string" &&
              new RegExp(`^https://${config.worker}\\.[a-z0-9][a-z0-9-]{0,62}\\.workers\\.dev$`).test(output.url) &&
              output.databaseId === db?.databaseId && output.databaseName === db?.databaseName &&
              output.ledgerDatabaseId === ledger?.databaseId && output.ledgerDatabaseName === ledger?.databaseName);
          }
          requireEvidence(!statePermit); statePermit = true;
          const writer = await stateWriter();
          if (fqn) await Effect.runPromise(writer.set({ stack: STACK, stage: config.stage, fqn, value: operation.value as PersistedState }).pipe(Effect.provideService(HttpClient.HttpClient, stateClient)));
          else await Effect.runPromise(writer.setOutput({ stack: STACK, stage: config.stage, value: operation.value }).pipe(Effect.provideService(HttpClient.HttpClient, stateClient)));
          if (!fqn) completed = true;
          return null;
        }
        requireEvidence(operation.worker === config.worker && uploaded);
        const authorize = async () => { await check(); requireEvidence(!closed); dispatch(); };
        if (operation.op === "app-key") {
          requireEvidence(Object.keys(operation).sort().join() === "op,worker" && !key);
          // Reserve before awaiting: an uncertain upload cannot replay.
          requireEvidence(!once.has("app-key")); once.add("app-key"); mutations++;
          await authorize();
          key = await custody.app.provisionKey(config.stage, config.worker);
          requireEvidence(sameApp(key));
          return key;
        }
        if (operation.op === "app-webhook") {
          requireEvidence(Object.keys(operation).sort().join() === "appId,op,worker" && key && operation.appId === key.appId && !webhook);
          webhook = true; mutations++;
          await authorize();
          await custody.app.provisionWebhook(config.worker, key.appId); return null;
        }
        if (operation.op === "app-discord") {
          requireEvidence(Object.keys(operation).sort().join() === "op,worker" && key && webhook && !once.has("app-discord"));
          once.add("app-discord"); mutations++;
          await authorize();
          await custody.app.provisionDiscord(config.worker);
          await check(); requireEvidence(!closed); dispatch();
          discord = true; return null;
        }
        requireEvidence(operation.op === "app-check" && Object.keys(operation).sort().join() === "metadata,op,worker" && key && webhook && discord && !checked && sameApp(operation.metadata));
        requireEvidence(!once.has("app-check")); once.add("app-check");
        await authorize();
        const result = await custody.app.check(key, config.worker);
        requireEvidence(result.appId === key.appId && Number.isFinite(Date.parse(result.checkedAt)));
        await check(); requireEvidence(!closed); dispatch();
        checked = true; return { appId: result.appId, checkedAt: result.checkedAt };
      } catch { closed = true; throw refusal(); }
      finally { busy = false; }
    },
    outcome: () => Object.freeze({ closed, mutations, completed }),
  });
}
