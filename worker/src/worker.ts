import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { handleRequest } from "./installation-api.ts";
import { repositoryMappings } from "./repository-mappings.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SupportDB } from "./support-db.ts";
import { sweepDelivery } from "./delivery.ts";
import { GitHubGateway, GitHubReader } from "./github-gateway.ts";
import { scheduledTick } from "./scheduled.ts";
import type { RefreshConfig } from "./status-refresh.ts";
import type { SweepConfig } from "./status-sweep.ts";
import { WorkerExecutionContext, WorkerEnvironment } from "alchemy/Cloudflare/Workers/WorkerRuntime";
import { checkBoundGitHubAppKey } from "./github-app-key-check.ts";

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
      yield* scheduledTick({ db, mappings: repositoryMappings, botLogin: `${slug}[bot]`, sweep, refresh }).pipe(
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
        const web = HttpServerRequest.toWebResult(request);
        if (Result.isFailure(web)) return HttpServerResponse.empty({ status: 400 });
        const db = yield* database.raw;
        const response = yield* Effect.promise(() => handleRequest(web.success, db, repositoryMappings));
        if (web.success.method === "POST" && new URL(web.success.url).pathname === "/v1/requests" && response.status === 202) {
          const context = yield* WorkerExecutionContext;
          yield* context.waitUntil(deliver);
        }
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive), Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
);
