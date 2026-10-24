import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { isDurableStage, supportDatabaseProps, supportLedgerProps } from "./support-db-config.ts";

/** The stage's shared D1 database (ADR 0013). */
export const SupportDB = Effect.gen(function* () {
  const stack = yield* Alchemy.Stack;
  return yield* Cloudflare.D1.Database(
    "SupportDB",
    supportDatabaseProps satisfies Cloudflare.D1.DatabaseProps,
  ).pipe(Alchemy.RemovalPolicy.retain(isDurableStage(stack.stage)));
});

/** The stage's suppression ledger (ADR 0016), a separate database a restore of SupportDB never rewinds. */
export const SupportLedger = Effect.gen(function* () {
  const stack = yield* Alchemy.Stack;
  return yield* Cloudflare.D1.Database(
    "SupportLedger",
    supportLedgerProps satisfies Cloudflare.D1.DatabaseProps,
  ).pipe(Alchemy.RemovalPolicy.retain(isDurableStage(stack.stage)));
});
