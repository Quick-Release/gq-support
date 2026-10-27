import * as Context from "effect/Context";
import type { ProgressIdentity } from "./cron-progress.ts";

/** Declaration-only public identity, supplied by the retained reviewed planner.
 * No process environment/config lookup can grant a release identity. Runtime
 * uses the exact public bindings validated in the native upload. */
export const ReviewedRelease = Context.Reference<ProgressIdentity | null>("Support/ReviewedRelease", { defaultValue: () => null });
