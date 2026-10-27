import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { collectAlerts, persistCollected, type AlertConfig } from "./discord-alerts.ts";
import type { QueryDatabase } from "./storage.ts";

type Failure = "Support delivery sweep failed" | "Support scheduled tick failed" | "Support request handler failed" |
  "Support cleanup sweep failed" | "Support status refresh failed" | "Support status sweep failed" | "Support webhook status refresh failed";

/** Observe the existing deadline after interruption has settled; never restart work. */
export const boundedWork = <A, E, R>(work: Effect.Effect<A, E, R>, milliseconds: number, failure: Failure) =>
  work.pipe(Effect.timeoutOption(milliseconds), Effect.flatMap((result) => Option.isNone(result)
    ? Effect.logError(failure).pipe(Effect.annotateLogs({ timeout: true })) : Effect.void));

/** Keep the failure log and finalization within one collector. Request finalization
 * registers background I/O, including on failure/interruption; it never awaits it. */
export const observeRuntime = <A, E, R, R2 = never>(work: Effect.Effect<A, E, R>,
  main: QueryDatabase, ledger: QueryDatabase, config: AlertConfig, failure: Failure,
  background?: (persistence: Effect.Effect<void>) => Effect.Effect<void, never, R2>) => Effect.suspend(() => {
  const collector = collectAlerts();
  const persist = persistCollected(collector, main, ledger, config);
  return work.pipe(
    Effect.onExit((exit) => Effect.gen(function* () {
      if (Exit.isFailure(exit)) yield* Effect.logError(failure);
      yield* background ? background(persist).pipe(
        Effect.catchCause(() => Effect.logError("Support alert state unavailable"))) : persist;
    })),
    Effect.provide(collector.layer),
  );
});
