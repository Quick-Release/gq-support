import { ReviewedRelease } from "./release-identity.ts";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { emptyPhases, progressIdentity, progressIO, startProgress, writeProgress } from "./cron-progress.ts";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createGitHubWebhookReceiver, type GitHubWebhookReceiver } from "./github-webhooks.ts";
import { handleWorkerRequest } from "./worker-http.ts";
import { mappingsForSlug } from "./repository-mappings.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SupportDB, SupportLedger } from "./support-db.ts";
import { sweepDelivery } from "./delivery.ts";
import { GitHubGateway, GitHubReader } from "./github-gateway.ts";
import { scheduledTick } from "./scheduled.ts";
import { refreshStatus, type RefreshConfig } from "./status-refresh.ts";
import type { SweepConfig } from "./status-sweep.ts";
import { WorkerExecutionContext, WorkerEnvironment } from "alchemy/Cloudflare/Workers/WorkerRuntime";
import { checkBoundGitHubAppKey } from "./github-app-key-check.ts";
import { digestKey } from "./cleanup.ts";
import { alertConfig, drainAlerts, recordAlerts } from "./discord-alerts.ts";
import { boundedWork, observeRuntime } from "./runtime-alerts.ts";
import { contained } from "./maintenance.ts";

let webhookReceiver: GitHubWebhookReceiver | undefined;
// Per isolate: derived once from the App key, which never enters D1 (src/cleanup.ts).
let titleDigestKey: Promise<CryptoKey | null> | undefined;

export default Effect.gen(function* () {
  // Stable IDs may resolve before migrations finish. Depend on whole D1
  // results so application updates cannot race schema additions.
  const databasesReady = Output.all(Output.of(yield* SupportDB), Output.of(yield* SupportLedger));
  const releaseIdentity = yield* ReviewedRelease;
  return yield* Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.url,
    env: { SUPPORT_RELEASE_CANDIDATE: releaseIdentity?.candidate ?? "unknown", SUPPORT_RELEASE_STAGE: releaseIdentity?.stage ?? "unknown" },
    workersDev: Output.map(databasesReady, () => ({ enabled: true, previewsEnabled: false })),
    compatibility: { date: "2026-10-17" },
    // Upload with traces off so an old credential cannot leak during a transition.
    // The apply-only custody provider restores traces when Discord is disabled,
    // after verifying credential removal. Logs remain enabled in both modes.
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: false } },
  },
  Effect.gen(function* () {
    // Binds SupportDB. Routes reach Slot-owned records only through
    // createStorageFor (src/storage.ts), with the binding's `raw` database as `shared`.
    const database = yield* Cloudflare.D1.QueryDatabase(yield* SupportDB);
    const ledgerDatabase = yield* Cloudflare.D1.QueryDatabase(yield* SupportLedger);
    const clientId = yield* Config.String("GITHUB_APP_CLIENT_ID").pipe(Config.withDefault(""));
    const slug = yield* Config.String("GITHUB_APP_SLUG").pipe(Config.withDefault(""));
    const appId = yield* Config.String("GITHUB_APP_ID").pipe(Config.withDefault(""));
    // Only this stage's reviewed mappings: the slug is pinned per stage at deployment.
    const repositoryMappings = mappingsForSlug(slug);
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
      const ledger = yield* ledgerDatabase.raw;
      if (!db || !ledger) return yield* Effect.logError("Support delivery sweep failed");
      yield* observeRuntime(boundedWork(Effect.suspend(() => contained(db, ledger, sweepDelivery({ db, ledger, mappings: repositoryMappings, botLogin: `${slug}[bot]` }).pipe(
        Effect.provide(GitHubGateway.live({ clientId, slug, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY, ledger })),
      ), undefined)), 25_000, "Support delivery sweep failed"), db, ledger, alertConfig(env, slug), "Support delivery sweep failed").pipe(Effect.catchCause(() => Effect.void));
    }).pipe(Effect.catchCause(() => Effect.logError("Support delivery sweep failed")));
    // Delivery and reconciliation first, then the status sweep (src/scheduled.ts).
    const tick = (scheduledTime: number) => Effect.suspend(() => {
      const started = Date.now();
      const phases = emptyPhases();
      return Effect.gen(function* () {
        const env = yield* WorkerEnvironment;
        const ledger = yield* ledgerDatabase.raw;
        const identity = progressIdentity(env.SUPPORT_RELEASE_STAGE, env.SUPPORT_RELEASE_CANDIDATE);
        const owner = ledger && identity
          ? yield* progressIO(() => startProgress(ledger, identity, scheduledTime, started))
          : yield* Effect.logError("Support Cron progress unavailable").pipe(Effect.as(null));
        const observe = (phase: keyof typeof phases, outcome: typeof phases.delivery) => Effect.gen(function* () {
          phases[phase] = outcome;
          if (ledger && owner) yield* progressIO(() => writeProgress(ledger, owner, { ...phases }));
        });
        const work = Effect.gen(function* () {
          if (!clientId || !slug || typeof env.GITHUB_APP_PRIVATE_KEY !== "string") return yield* Effect.die("Support scheduled configuration unavailable");
          const db = yield* database.raw;
          if (!db || !ledger) return yield* Effect.die("Support scheduled bindings unavailable");
          const completed = yield* observeRuntime(Effect.gen(function* () {
            const config = { clientId, slug, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY as string, ledger };
            const key = yield* Effect.promise(() => titleDigestKey ??= digestKey(env.GITHUB_APP_PRIVATE_KEY as string));
            yield* scheduledTick({ db, ledger, mappings: repositoryMappings, botLogin: `${slug}[bot]`, sweep, refresh, digestKey: key,
              observePhase: observe }).pipe(
              Effect.provide(Layer.mergeAll(GitHubGateway.live(config), GitHubReader.live(config))),
            );
            return true;
          }), db, ledger, alertConfig(env, slug), "Support scheduled tick failed");
          if (completed) {
            // drainAlerts owns an independently running Promise/Effect. If this
            // fiber is cancelled, await its local settlement in the finalizer;
            // do not claim terminal while its cleanup is still running.
            const draining = drainAlerts(db, ledger, alertConfig(env, slug));
            const outcome = yield* Effect.promise(() => draining).pipe(
              Effect.onExit((exit) => Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause) ? Effect.promise(() => draining.catch(() => "failed" as const)).pipe(
                Effect.flatMap((result) => observe("drain", result))) : Effect.void),
              Effect.catchCause(() => Effect.logError("Support alert drain unavailable").pipe(Effect.as("failed" as const))));
            yield* observe("drain", outcome);
          }
        });
        // onExit runs after all nested work/finalizers settle. Interruption is
        // explicit; a terminal record says local work settled, not remote writes.
        yield* work.pipe(Effect.onExit((exit) => ledger && owner ? progressIO(() => writeProgress(ledger, owner, { ...phases }, Date.now(),
          Exit.isSuccess(exit) ? "settled" : Cause.hasInterrupts(exit.cause) ? "interrupted" : "failed")).pipe(Effect.asVoid) : Effect.void));
      });
    }).pipe(Effect.catchCause(() => Effect.logError("Support scheduled tick failed")));
    yield* Cloudflare.Workers.cron("* * * * *", (controller) => tick(controller.scheduledTime).pipe(Effect.asVoid));

    return {
      checkGitHubAppKey: Effect.fn(function* (clientId: string, slug: string) {
        const env = yield* WorkerEnvironment;
        return yield* Effect.promise(() => checkBoundGitHubAppKey(env.GITHUB_APP_PRIVATE_KEY, { clientId, slug }));
      }),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const env = yield* WorkerEnvironment;
        const context = yield* WorkerExecutionContext;
        const { ledger, db } = yield* Effect.gen(function* () {
          return { ledger: yield* ledgerDatabase.raw, db: yield* database.raw };
        }).pipe(Effect.tapCause(() => Effect.logError("Support request invocation failed")));
        if (!db || !ledger) {
          yield* Effect.logError("Support request invocation failed");
          return HttpServerResponse.fromWeb(Response.json({ code: "service_unavailable" },
            { status: 503, headers: { "Retry-After": "60" } }));
        }
        return yield* observeRuntime(Effect.gen(function* () {
          webhookReceiver ??= createGitHubWebhookReceiver({ appId,
            diagnostics: webhookDiagnostics && slug === "getquick-support-staging",
            secret: typeof env.GITHUB_WEBHOOK_SECRET === "string" ? env.GITHUB_WEBHOOK_SECRET : undefined,
            previousSecret: typeof env.GITHUB_WEBHOOK_PREVIOUS_SECRET === "string" ? env.GITHUB_WEBHOOK_PREVIOUS_SECRET : undefined,
          });
          const services = yield* Effect.context<RuntimeContext>();
          const key = yield* Effect.promise(() => titleDigestKey ??= typeof env.GITHUB_APP_PRIVATE_KEY === "string"
            ? digestKey(env.GITHUB_APP_PRIVATE_KEY) : Promise.resolve(null));

          const unavailable = Response.json({ code: "service_unavailable" }, { status: 503, headers: { "Retry-After": "60" } });
          const response = yield* contained(db, ledger, handleWorkerRequest(request, database.raw, repositoryMappings, webhookReceiver,
            (task) => context.raw.waitUntil(task), {
              mappings: repositoryMappings, botLogin: `${slug}[bot]`,
              database: () => Effect.runPromiseWith(services)(database.raw),
              refresh: (db) => Effect.runPromise(recordAlerts(contained(db, ledger, Effect.gen(function* () {
                if (!clientId || !slug || typeof env.GITHUB_APP_PRIVATE_KEY !== "string") return;
                yield* refreshStatus({ db, config: refresh }).pipe(Effect.provide(GitHubReader.live({
                  clientId, slug, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
                })));
              }), undefined).pipe((work) => boundedWork(work, 12_000, "Support webhook status refresh failed"),
                Effect.catchCause(() => Effect.logError("Support webhook status refresh failed"))), db, ledger, alertConfig(env, slug))),
            }, { digestKey: key, ledger }), unavailable);
          // A new create or status change wakes delivery at once; the minute sweep recovers a lost wake-up.
          if (request.method === "POST" && /^\/v1\/requests(?:\/[^/]+\/status)?$/.test(new URL(request.url, "https://support.invalid").pathname) &&
            response.status === 202) {
            yield* context.waitUntil(deliver).pipe(Effect.catchCause(() => Effect.logError("Support delivery sweep failed")));
          }
          return HttpServerResponse.fromWeb(response);
        }), db, ledger, alertConfig(env, slug), "Support request handler failed", (persistence) => context.waitUntil(persistence));
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.CronEventSourceLive), Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
);
});
