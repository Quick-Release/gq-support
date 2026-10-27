// Process-local continuation primitive. There is deliberately no workflow/CLI
// authorization adapter yet. A callback supplied by untrusted input is NOT an
// authorization verifier and must never be wired to this module.
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { apply } from "alchemy/Apply";
import type { PlanSnapshot } from "alchemy/Alchemist/routes/stack";
import type { Stack } from "alchemy/Stack";
import type { Stage } from "alchemy/Stage";
import { State, type StateService } from "alchemy/State/State";
import { validateNativePlan, type PlanEvidence } from "./native-plan-policy.ts";
import { refusal, requireEvidence } from "./planning-state.ts";


// Integrity check only, never a backend revision/CAS or ABA proof. Hashes and
// bytes stay private. Include provider/function identity without invoking them.
function planFingerprint() {
  const identities = new WeakMap<object, number>();
  let next = 0;
  return (value: unknown) => {
    const hash = createHash("sha256");
    const seen = new WeakSet<object>();
    let count = 0;
    const visit = (entry: unknown, depth = 0): void => {
      requireEvidence(++count < 100_000 && depth < 128);
      hash.update(typeof entry + ":");
      if ((typeof entry !== "object" && typeof entry !== "function") || entry === null) {
        hash.update(JSON.stringify(String(entry))); return;
      }
      if (!identities.has(entry)) identities.set(entry, ++next);
      hash.update(String(identities.get(entry)) + ":");
      if (seen.has(entry)) return;
      seen.add(entry);
      if (entry instanceof Map) for (const [key, item] of entry) { visit(key, depth + 1); visit(item, depth + 1); }
      if (entry instanceof Set) for (const item of entry) visit(item, depth + 1);
      if (entry instanceof Date) hash.update(String(entry.getTime()));
      for (const key of Reflect.ownKeys(entry)) {
        hash.update(JSON.stringify(String(key)));
        const descriptor = Object.getOwnPropertyDescriptor(entry, key);
        requireEvidence(descriptor);
        if ("value" in descriptor) visit(descriptor.value, depth + 1);
        else { visit(descriptor.get, depth + 1); visit(descriptor.set, depth + 1); }
      }
    };
    visit(value);
    return hash.digest("hex");
  };
}

export interface CandidateBinding {
  readonly source: string;
  readonly lockfiles: string;
  readonly migrations: string;
  readonly target: string;
  readonly state: string;
  readonly window: string;
  readonly candidate: string;
}
export interface HandoffVerifier {
  // Must check authenticated candidate-specific human approval, owner-controlled
  // writer exclusion still in force, fresh read-only state and local digests.
  // It returns the writer capability only AFTER all those checks succeed.
  // No environment boolean or user-provided verifier is a valid implementation.
  revalidate(binding: Readonly<CandidateBinding>): Effect.Effect<{
    readonly binding: CandidateBinding;
    readonly writer: StateService;
  }>;
}

type RetainedSnapshot = Pick<PlanSnapshot, "native" | "stack"> & {
  readonly session: { readonly context: Context.Context<State | Stack | Stage> };
};

export function retainCandidate(snapshot: RetainedSnapshot, evidence: PlanEvidence, binding: CandidateBinding) {
  requireEvidence(snapshot.stack.name === evidence.target.stack && snapshot.stack.stage === evidence.target.stage);
  const policy = structuredClone(evidence);
  validateNativePlan(snapshot.native, policy);
  const sealed = Object.freeze({ ...binding });
  requireEvidence(Object.values(sealed).every((value) => typeof value === "string" && value.length > 0));
  // Retain object identity and session context; never serialize native plans.
  const native = snapshot.native;
  const context = snapshot.session.context;
  const fingerprint = planFingerprint();
  const integrity = fingerprint(native);
  let consumed = false;
  return {
    apply: (verifier: HandoffVerifier) => Effect.gen(function* () {
      requireEvidence(!consumed);
      consumed = true; // uncertainty/failure invalidates the continuation too
      const handoff = yield* verifier.revalidate(sealed);
      for (const key of Object.keys(sealed) as (keyof CandidateBinding)[]) {
        requireEvidence(handoff.binding[key] === sealed[key]);
      }
      requireEvidence(snapshot.native === native && snapshot.session.context === context);
      requireEvidence(fingerprint(native) === integrity);
      validateNativePlan(native, policy);
      // Inner context replacement is essential: Stacks.apply would supply the
      // original read-only State from snapshot.session.context over an outer one.
      return yield* apply(native).pipe(Effect.provide(
        Context.add(context, State, Effect.succeed(handoff.writer)),
      ));
    }).pipe(Effect.catchCause(() => Effect.die(refusal()))),
  };
}
