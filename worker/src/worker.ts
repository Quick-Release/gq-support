import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createGitHubWebhookReceiver, type GitHubWebhookReceiver } from "./github-webhooks.ts";
import { handleWorkerRequest } from "./worker-http.ts";
import { repositoryMappings } from "./repository-mappings.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SupportDB } from "./support-db.ts";
import { sweepDelivery } from "./delivery.ts";
import { GitHubGateway, GitHubReader } from "./github-gateway.ts";
import { scheduledTick } from "./scheduled.ts";
import { refreshStatus, type RefreshConfig } from "./status-refresh.ts";
import type { SweepConfig } from "./status-sweep.ts";
import { WorkerExecutionContext, WorkerEnvironment } from "alchemy/Cloudflare/Workers/WorkerRuntime";
import { checkBoundGitHubAppKey } from "./github-app-key-check.ts";
import { digestKey } from "./cleanup.ts";

let webhookReceiver: GitHubWebhookReceiver | undefined;
// Per isolate: derived once from the App key, which never enters D1 (src/cleanup.ts).
let titleDigestKey: Promise<CryptoKey | null> | undefined;

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.url,
    compatibility: { date: "2026-10-17" },
    observability: { enabled: true, traces: { enabled: true } },
  },
  Effect.gen(function* () {
    // Binds SupportDB. Routes reach Slot-owned records only through
    // createStorageFor (src/storage.ts), with the binding's `raw` database as `shared`.
    const database = yield* Cloudflare.D1.QueryDatabase(yield* SupportDB);
    const clientId = yield* Config.String("GITHUB_APP_CLIENT_ID").pipe(Config.withDefault(""));
    const slug = yield* Config.String("GITHUB_APP_SLUG").pipe(Config.withDefault(""));
    const appId = yield* Config.String("GITHUB_APP_ID").pipe(Config.withDefault(""));
    const webhookDiagnostics = yield* Config.Boolean("GITHUB_WEBHOOK_DIAGNOSTICS").pipe(Config.withDefault(false));
    // Status sweep cadence and bounds. Each unset or out-of-range value keeps its SWEEP_DEFAULTS entry.
    const setting = (name: string, minimum: number) => Config.Int(name).pipe(Config.option,
      Config.map(Option.filter((value) => value >= minimum)));
    const sweep = Object.fromEntries(Object.entries(yield* Config.all({
      intervalMs: setting("STATUS_SWEEP_INTERVAL_MS", 60_000),
      skewMs: setting("STATUS_SWEEP_SKEW_MS", 0),
      pagesPerTick: setting("STATUS_SWEEP_PAGES_PER_TICK", 1),
      pagesPerRepository: setting("STATUS_SWEEP_PAGES_PER_REPOSITORY", 1),
    })).flatMap(([key, value]) => Option.isSome(value) ? [[key, value.value]] : [])) as Partial<SweepConfig>;
    const refresh = Object.fromEntries(Object.entries(yield* Config.all({
      dailyIntervalMs: setting("STATUS_REFRESH_DAILY_INTERVAL_MS", 60_000),
      dailyBatchSize: setting("STATUS_REFRESH_DAILY_BATCH_SIZE", 1),
      readsPerTick: setting("STATUS_REFRESH_READS_PER_TICK", 1),
    })).flatMap(([key, value]) => Option.isSome(value) ? [[key, value.value]] : [])) as Partial<RefreshConfig>;
    const deliver = Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      if (!clientId || !slug || typeof env.GITHUB_APP_PRIVATE_KEY !== "string") return;
      const db = yield* database.raw;
      yield* sweepDelivery({ db, mappings: repositoryMappings, botLogin: `${slug}[bot]` }).pipe(
        Effect.provide(GitHubGateway.live({ clientId, slug, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY })),
      );
    }).pipe(Effect.timeoutOption(25_000), Effect.catchCause(() => Effect.logError("Support delivery sweep failed")));
    // Delivery and reconciliation first, then the status sweep (src/scheduled.ts).
    const tick = Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      if (!clientId || !slug || typeof env.GITHUB_APP_PRIVATE_KEY !== "string") return;
      const db = yield* database.raw;
      const config = { clientId, slug, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY };
      const key = yield* Effect.promise(() => titleDigestKey ??= digestKey(env.GITHUB_APP_PRIVATE_KEY as string));
      yield* scheduledTick({ db, mappings: repositoryMappings, botLogin: `${slug}[bot]`, sweep, refresh, digestKey: key }).pipe(
        Effect.provide(Layer.mergeAll(GitHubGateway.live(config), GitHubReader.live(config))),
      );
    }).pipe(Effect.catchCause(() => Effect.logError("Support scheduled tick failed")));
    yield* Cloudflare.Workers.cron("* * * * *", () => tick.pipe(Effect.asVoid));

    return {
      checkGitHubAppKey: Effect.fn(function* (clientId: string, slug: string) {
        const env = yield* WorkerEnvironment;
        return yield* Effect.promise(() => checkBoundGitHubAppKey(env.GITHUB_APP_PRIVATE_KEY, { clientId, slug }));
      }),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const env = yield* WorkerEnvironment;
        const context = yield* WorkerExecutionContext;
        webhookReceiver ??= createGitHubWebhookReceiver({ appId,
          diagnostics: webhookDiagnostics && slug === "getquick-support-staging",
          secret: typeof env.GITHUB_WEBHOOK_SECRET === "string" ? env.GITHUB_WEBHOOK_SECRET : undefined,
          previousSecret: typeof env.GITHUB_WEBHOOK_PREVIOUS_SECRET === "string" ? env.GITHUB_WEBHOOK_PREVIOUS_SECRET : undefined,
        });
        const services = yield* Effect.context<RuntimeContext>();
        const key = yield* Effect.promise(() => titleDigestKey ??= typeof env.GITHUB_APP_PRIVATE_KEY === "string"
          ? digestKey(env.GITHUB_APP_PRIVATE_KEY) : Promise.resolve(null));
        const response = yield* handleWorkerRequest(request, database.raw, repositoryMappings, webhookReceiver,
          (task) => context.raw.waitUntil(task), {
            mappings: repositoryMappings, botLogin: `${slug}[bot]`,
            database: () => Effect.runPromiseWith(services)(database.raw),
            refresh: (db) => Effect.runPromise(Effect.gen(function* () {
              if (!clientId || !slug || typeof env.GITHUB_APP_PRIVATE_KEY !== "string") return;
              yield* refreshStatus({ db, config: refresh }).pipe(Effect.provide(GitHubReader.live({
                clientId, slug, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
              })));
            }).pipe(Effect.timeoutOption(12_000), Effect.asVoid,
              Effect.catchCause(() => Effect.logError("Support webhook status refresh failed")))),
          }, { digestKey: key });
        if (request.method === "POST" && new URL(request.url, "https://support.invalid").pathname === "/v1/requests" && response.status === 202) {
          yield* context.waitUntil(deliver);
        }
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive), Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
);
