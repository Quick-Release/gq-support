import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { isDurableStage, supportDatabaseProps, supportLedgerProps } from "./support-db-config.ts";

/**
 * On prod and staging a plan that would replace or delete the database fails
 * (`protect`, the inner and winning policy) before anything is applied; with
 * protection lifted, removal still keeps the database (`retain`). Other
 * stages destroy it with the stack.
 */
export const durable = (stage: string) => <A, R>(database: Effect.Effect<A, never, R>): Effect.Effect<A, never, R> =>
  database.pipe(Alchemy.RemovalPolicy.protect(isDurableStage(stage)), Alchemy.RemovalPolicy.retain(isDurableStage(stage)));

/** The stage's shared D1 database (ADR 0013). */
export const SupportDB = Effect.gen(function* () {
  const stack = yield* Alchemy.Stack;
  return yield* Cloudflare.D1.Database(
    "SupportDB",
    supportDatabaseProps satisfies Cloudflare.D1.DatabaseProps,
  ).pipe(durable(stack.stage));
});

/** The stage's suppression ledger (ADR 0016), a separate database a restore of SupportDB never rewinds. */
export const SupportLedger = Effect.gen(function* () {
  const stack = yield* Alchemy.Stack;
  return yield* Cloudflare.D1.Database(
    "SupportLedger",
    supportLedgerProps satisfies Cloudflare.D1.DatabaseProps,
  ).pipe(durable(stack.stage));
});
