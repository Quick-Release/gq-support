# Protected native planner implementation boundary

Implementation on top of PR111 (`079046d`), 2026-10-27. Related: #20 / #35
Test F. This is a **disabled integration**, not an enabled protected deployment
workflow. PR109's refusal, reviewer/provenance checks and guarded destroy policy
remain unchanged. No authenticated state read, credential access, live plan,
deployment, bootstrap, recovery, setting change or Test F was performed.

## Implemented locally

- `worker/support-stack.ts` is the shared declaration factory. Default
  `alchemy.run.ts` still supplies the original Cloudflare backend. The explicit
  planning factory injects the lazy immutable snapshot layer instead. The
  default declaration now refuses staging/prod before preflight, including
  normal local CLI invocations; personal-stage deployment keeps its prior path.
- `planning-state.ts` calls installed beta.83 `makeHttpStateStore` directly.
  Its transport allows GET only at one HTTPS origin, exact project/stage paths,
  `/version`, and this project's stage enumeration. It forbids query strings,
  redirects and all write methods; there is no general stack enumeration or
  cross-project read capability. Credentials are in closure memory only.
  Fetch timeout is ten seconds. Caller supplies a dedicated transport; passing a
  transport that ignores redirect policy is outside this trusted-code contract.
- Acquisition requires protocol **7**, a known nonempty stage, every listed
  resource/action row, outputs and an empty replacement-cleanup list. It rejects
  vanished, duplicate, malformed, unsettled and historical rows. Snapshot data
  is deeply copied/frozen; writes and cross-project reads fail. Unknown tagged
  values/references are refused, not silently dropped. This deliberately does
  **not** claim support for all beta.83 state values: Redacted/runtime classes,
  recursive replacement histories and reference-bearing snapshots remain
  blocked until a reviewed decoder/reference contract exists. No history is
  erased to make a plan pass.
- `native-plan-policy.ts` consumes actual `Plan.Plan`, not renderer rows or an
  invented wire plan. It checks resource and action deletion tables, retained
  orphans, selection/destroy, history and action execution. BOTH D1s must have
  distinct reviewed physical IDs/names, matching FQN/type/instance, settled live
  state, Tipme account, EU jurisdiction and retention. No create, adoption,
  replacement, rename, import/clone or mode change is accepted for either D1.
  Other resources can create/update/no-op, but deletion/history is refused.
- Pending flat-directory migrations must match content hashes and a deliberately
  narrow additive SQL subset (create table/index, add column). Committed hashes
  cannot change/disappear. Unknown SQL, DML, destructive/down changes, migration
  directory switches, conversions and non-string migration inputs are refused.
  This subset deliberately does not accept every existing repository migration
  as a new migration: quotation, data backfills and other forms require review.
- `retained-plan.ts` retains the native object and original session context in
  memory, checks a private structural fingerprint and revalidates policy before
  one-shot low-level `Apply.apply`. A trusted verifier must supply a writable
  State capability and identical source/lockfile/migration/target/state/window/
  candidate bindings only after fresh authenticated authorization checks.
  Failed/uncertain continuation cannot be retried. The callback is a dependency
  seam, **not an implemented authorization mechanism**. No production caller
  supplies it. A simulated local apply proves State replacement happens inside
  the original context; a separate `alchemy deploy` is never used for handoff.

## Exact remaining blockers

`productionEndpointContract` is absent and `protectedPlanningEntry` always dies
before reading a credential or opening a network connection. Environment values
cannot attest it. The local contract interface describes evidence to review;
constructing that interface does not verify a deployed endpoint. Before enabling:

1. Supply/review an immutable endpoint/script/code-digest/account/stack/stage
   contract and implement authenticated, bounded read-only identity checks
   against it, including protocol 7 and both live D1 identities. The generic
   protocol-5 constant is not evidence for the deployed Cloudflare store.
   No version mismatch may trigger an upgrade or fallback.
2. Complete a decoder/reference contract against actual authoritative state.
   The conservative settled/plain-data subset above cannot promise that the
   entire current Worker state graph is representable. Needed references must
   have explicit reviewed targets and their own exact read paths, not a broad
   additional-stack allowlist. Historical D1 cleanup is always a refusal.
3. Finish full declaration/provider network confinement. D1 diff fixture tests
   run the installed live provider with no API capability; this is not a full
   Worker/GitHub provider audit. The shared declaration's `verifyApp` uses its
   direct-fetch preflight and Worker planning/build hooks can invoke additional
   code. An injected Effect HttpClient alone cannot confine these paths. The
   explicit planning entry therefore never invokes the full graph. Do not
   hand the shared factory a broad bearer and assume GET acquisition confines
   subsequent provider execution.
4. Implement the authenticated approval/window verifier and workflow continuation.
   Existing environment approval occurs before a job runs; a second environment
   job cannot receive the original native object/context through an artifact.
   There is no implemented candidate-approval channel back into a retained
   process. No approval environment variable, serialized native object, renderer
   artifact or fresh CLI plan is an acceptable substitute. Keep the current
   main-only workflow refusal until this continuation is implemented and tested.
5. Establish the owner-controlled exclusive window for **all** state writers
   from acquisition through apply, including other workflows, local operators
   and background tooling. The continuation's window binding does not create
   that window. GitHub concurrency only serializes participating runs. Check
   exclusion and freshness again before handoff; owner uncertainty blocks it.
   Repeated hashes detect some drift but cannot prove ABA safety or atomicity;
   beta.83 has no atomic revision/CAS contract.
6. Configure and verify the required environment reviewers (vvaz/gmarques),
   separately authorize a specific candidate, and separately authorize live
   authenticated Test F for both D1s. No local fixture establishes those facts.

These blockers are narrower than credential custody: that approach is approved.
They are not a request to reconsider it. The disabled integration is reviewable
without requesting or extracting any credential. It is not release-ready.

## Private credential delivery contract

Reserved secret names only (no values): `ALCHEMY_STATE_BEARER_FILE` and
`CLOUDFLARE_PLANNING_READ_TOKEN_FILE`. The parent may privately request the existing
state credential after reviewing this code. Deliver only the existing bearer in
an owner-readable ephemeral file (0400, protected runner tmpfs/directory, never a
profile), with its path supplied to the eventual trusted launcher. The current
blocked entry does not read that path. Endpoint/identity manifests are reviewed
metadata, not secret values or environment attestation. A separately authorized
read-only Cloudflare token is needed only if the final identity-check contract
requires it; no token is minted or extracted by this change.

Do not pass either value on argv, print it, attach raw state/plan to artifacts,
commit it or put it into renderer/progress output. Limit custody to the protected
main-only process; remove files on exit, bound lifetime and record owner-controlled
rotation/revocation. The broad state bearer still grants cross-stack writes at
the service: local confinement does not change that credential's authority.
No real apply capability is delivered until candidate approval and exclusion
are independently verified. Existing deploy credentials stay separate.

## Local evidence

`worker/test/protected-native-planner.test.ts` generates actual native engine
plans with installed `Cloudflare.D1.ProviderLive` diffs. It covers no-op and real
replication/additive-directory updates, each D1's name/jurisdiction/location and
account replacement, retained orphan/deletion, missing-state ownership-probe
refusal, recursive cleanup and checksum removal. The HTTP tests cover synthetic
success/errors/redirects/malformed data with exact GET confinement and canaries.
The retained continuation uses a simulated provider only for apply; planning
still uses installed D1 diffs. Source/lockfile/migration/target/state/window/
candidate mismatch and unavailable authorization fail before simulated apply.
The original 11 protocol characterization tests remain separate evidence.

An early local native-fixture run failed because the test did not provide the
provider environment; the corrected fixture supplies a synthetic Tipme provider
environment. Missing-state fixtures also exposed the actual provider's ownership
read: they now assert that no HTTP capability is available, rather than inventing
an engine create result. These are harness corrections, not a claimed product
red/green bug fix. No live Test F or broad provider-confinement proof is claimed.


Final validation: 134 affected Worker tests (including 66 new planner tests and
11 original protocol tests), Worker typecheck and lint, all 113 CI-script tests,
workflow policy, runtime matrix policy, affected-code secret scans and
`git diff --check` pass. The deliberate negative control temporarily bypassed
`validateNativePlan`: 15 native unsafe-plan rejection tests failed (exit 1).
Restoring the validator returned the affected suite to green. This is mutation
sensitivity evidence, not a claim that a prior production bug was repaired.
