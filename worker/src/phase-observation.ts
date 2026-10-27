import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Invocation-local finite signal. Existing HTTP/background callers keep their
 * contracts; only the scheduled phase installs an observer. No causes or data. */
export const PhaseFailure = Context.Reference<() => void>("Support/PhaseFailure", { defaultValue: () => () => {} });
export const notePhaseFailure = Effect.flatMap(PhaseFailure, (note) => Effect.sync(note));
