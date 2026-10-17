import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Result from "effect/Result";
import { handleRequest } from "./installation-api.ts";
import { repositoryMappings } from "./repository-mappings.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SupportDB } from "./support-db.ts";
import { sweepDelivery } from "./delivery.ts";
import { GitHubGateway } from "./github-gateway.ts";
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
    const deliver = Effect.gen(function* () {
      const env = yield* WorkerEnvironment;
      if (!clientId || !slug || typeof env.GITHUB_APP_PRIVATE_KEY !== "string") return;
      const db = yield* database.raw;
      yield* sweepDelivery({ db, mappings: repositoryMappings, botLogin: `${slug}[bot]` }).pipe(
        Effect.provide(GitHubGateway.live({ clientId, slug, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY })),
      );
    }).pipe(Effect.timeoutOption(25_000), Effect.catchCause(() => Effect.logError("Support delivery sweep failed")));
    yield* Cloudflare.Workers.cron("* * * * *", () => deliver.pipe(Effect.asVoid));

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
