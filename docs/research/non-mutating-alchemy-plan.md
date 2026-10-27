# Non-mutating native planning: beta.83 feasibility and decision

Investigated 2026-10-27, on top of PR109 commit
`6c94d362bbc8a82036c4465c2de2c8e3614091e9`. Installed with the unchanged
frozen lockfile: `alchemy@2.0.0-beta.83`, `effect@4.0.5`.

**Result:** there is a supported State-service injection seam that can bypass
Cloudflare bootstrap/recovery. There is no complete, authoritative offline
snapshot protocol or read-scoped credential supplied by this stack. A working
release adapter therefore needs an explicit state-custody and consistency
choice first. This investigation supplies executable protocol evidence and a
bounded implementation proposal, not an adapter, native-plan approval or Test F.
PR109's unconditional apply refusal stays. No remote plan, profile/credential
read, state-store request, deployment or settings change was performed.

## What the installed implementation actually supports

Paths below are relative to `worker/node_modules/alchemy/src/`. These are the
installed package sources and corresponding public exports/types, not a proposed
JSON plan format. The matching installed `lib/State/{State,Export,HttpStateStore}.d.ts` and
`lib/Alchemist/routes/stack.d.ts` were checked too. Current official docs are
supporting context; beta.83 wins where they disagree.

| Question | Installed source and result |
| --- | --- |
| Inject existing credentials without automatic recovery? | `State/HttpStateStore.ts`: exported `makeHttpStateStore({url, authToken, id, transformClient?})` builds a `StateService`. It has no call to Cloudflare bootstrap, profiles or edge-preview recovery. Read methods use native `StateApi`; transient failures retry the same request. It also exposes write methods, so it must be wrapped, not handed unrestricted to planning code. |
| Inject a read-only service? | `State/State.ts`: `State` holds `Effect<StateService>`. `Stack.ts` accepts a State layer; `Layer.effect(State, Effect.cached(...))` is the supported lazy construction. A dedicated planning stack factory can use a read-only service with the same declarations/providers. Merely providing an outer layer does not replace the explicit `Cloudflare.state()` inside the existing stack. |
| Does resolving the current backend stay read-only? | `Cloudflare/StateStore/State.ts`: `hasLocalStack` precedes cached-credential checks and can resume `deployWithLocalState`. `ensureLatest` can deploy/upgrade; `ensureAccess` refreshes an unauthorized bearer through `loginWithCloudflare`. A warm credential cache, `CI=true`, or omitting `--yes` is insufficient. |
| Can a CLI state export avoid initialization? | `Alchemist/routes/state.ts`: configured and Cloudflare backends resolve that same state layer. `--backend local` avoids it but reads local state only; absence does not prove undeployed resources. `Cli/commands/state.ts` prints state contents, unsuitable for CI logs. There is no installed CLI import/export snapshot command. |
| Is there a native export shape? | `State/Export.ts`: **yes**, `StateExport = {resources: ExportedResource[]}`, each entry `{stack, stage, fqn, state}`. `exportState` drops listed rows whose subsequent get returns undefined; it omits stack outputs. `State/Tree.ts` skips existence enumeration for an explicitly supplied stack/stage. This API is neither a completeness certificate nor an atomic snapshot. Output omission can be supplemented with `getOutput` and does not by itself prevent this project's D1 diff. |
| Can a native read certify state validity? | `State/HttpStateApi.ts`: resource payloads use `Schema.Any`. `HttpStateStore.ts` revives and casts them to state types. HTTP success is not runtime validation of `ResourceState`. `State/ResourceState.ts` supplies a TypeScript union, not a strict wire decoder. |
| Does sync provide a safe import? | `State/Sync.ts`: `syncState` writes destination rows and deletes destination records/stacks not in the source. It is not a read-only adapter; do not use it on the live backend. |
| Are read handlers themselves writing records? | `State/HttpStateApi.ts` declares GET routes; `Cloudflare/StateStore/Api.ts` routes them to `Store.ts` list/get/decrypt operations. These read handlers do not call storage put/delete. Write routes register stacks and put/delete records. This is source evidence, not a guarantee about implicit platform object activation/allocation or deployed code identity. No live server was examined. |
| Is the bearer scoped to one stage/read access? | `Cloudflare/StateStore/Api.ts`: `BearerTokenValidator` checks the same secret for the whole authenticated state group, including PUT/DELETE. There is no stage/account/read scope in this authorization contract. `CredentialsFile.ts` has `{url, authToken, accountId?}`; accountId is optional and missing/wrong account is considered stale by `isStateStoreCredentialsStale`. The HTTP API itself does not attest account ownership. |
| Which version must be pinned? | `Cloudflare/StateStore/Api.ts` uses version **7**, whereas generic `State/HttpStateApi.ts` uses **5**. Do not confuse these constants or automatically upgrade on mismatch. Current docs also describe credential paths/options different from beta.83. `Auth/Credentials.ts` plus `CredentialsFile.ts` identify the installed credential store; this investigation did not read it. |
| How is a native plan retained for apply? | `Alchemist/routes/stack.ts`: `PlanSnapshot` contains `.native`, `.session`, target, summary and renderer rows. `apply(snapshot)` consumes that native object in its session. `Plan.ts` contains resources, deletions, actions and actionDeletions; deletion nodes can be `orphaned` under retain. Renderer rows alone are insufficient. The engine calls provider read/diff hooks while planning; arbitrary declaration/provider code still needs a no-mutation audit. |

The official [custom store guide](https://alchemy.run/state-store/custom-state-store/)
documents the lazy State layer. The [state guide](https://alchemy.run/state-store/)
describes shared Cloudflare state and edge-preview credential recovery. Neither
promises a scoped read-only credential or atomic export. The
[plan reference](https://alchemy.run/cli/plan/) describes a non-applying preview,
not a machine-readable saved-plan protocol. The
[state CLI reference](https://alchemy.run/cli/state/) warns that encoded state
contains unwrapped secret values. Do not copy its current options or paths over
the installed beta.83 contract without checking source.

## Executable local proof

`worker/test/native-state-planning.test.ts` imports the installed native HTTP
client, export implementation, wire schema and in-memory store. It does not
import the application stack or supply any private key or real credential.
The synthetic bearer is a public placeholder on `state.invalid`.

- **Red disproof:** expecting one exported row after a list/get disappearance
  failed: `expected [] to have a length of 1`. This disproves the naive snapshot
  premise; it is not a bug we fixed in the dependency.
- **Green characterization:** tests assert that omission, omitted outputs,
  acceptance of an unknown empty stage, and acceptance of structurally invalid
  state by the native wire schema. These deliberately preserve evidence of the
  limitations rather than claiming to close them.
- Injected HTTP tests cover success, 401, 403, exhausted 404/429/500 retries and
  malformed JSON. Every request must remain a GET to the exact synthetic state
  path. A global fetch spy rejects network bypass; console spies assert no
  output. No credential recovery, bootstrap or temporary Worker API request is
  permitted through this seam. This proves the **client read seam only**, not
  the existing Cloudflare state initializer, provider graph or live server.

There are no authoritative previous-state/native plan fixtures in this change.
No replacement/deletion/additive gate acceptance or authenticated Test F is
claimed. Tests about the HTTP seam cannot stand in for those missing tests.

## Bounded choices requiring an explicit decision

**Recommended: direct existing backend, with a process-local snapshot.** Approve
use of the existing state-store bearer and verified endpoint for only
`GQSupportWorker/{staging,prod}` reads in a dedicated planning process. This is a
credential-custody decision: the bearer itself can read/write other stacks even
if our wrapper cannot. Existing Cloudflare deploy-token authorization does not
automatically authorize extracting or distributing this bearer. Prerequisites:

1. An owner supplies the existing bearer through a narrowly delivered secret
   file/descriptor after separately approving its custodian, CI environment,
   lifetime, rotation/revocation and permitted use. No profile scan, Secrets Store
   extraction, edge-preview recovery, new credential minting or copying the
   entire profile. Unknown/absent credentials fail with constant diagnostics.
2. Approve read access to the deployed state service and read-only account
   metadata needed to bind its exact endpoint/script to Tipme. Check deployed
   contract version and code identity before relying on the source audit.
   Stop on absent/old/different code; no bootstrap or repair. Whether the
   platform's implicit activation of an existing DO is acceptable must be
   explicit; GET alone cannot prove zero platform-side infrastructure effects.
3. Serialize **all** state writers during acquisition through authorization and
   apply (including local operators, not just this workflow's concurrency group).
   The existing API has no revision/CAS or atomic snapshot route. Repeating lists
   or hashes detects some races but cannot exclude ABA or certify consistency.
   If exclusive writer control cannot be enforced, this option is blocked.

**Offline alternative:** authorize a custodian to supply a confidential,
complete snapshot from the existing backend under the same writer exclusion,
including full resource/action rows, recursive old chains, outputs and all
cross-stack references. Bind its origin, account, stack/stage, version,
completeness, capture time and revision/freshness evidence separately. Keep bytes
in ephemeral protected storage or memory; no logs/artifacts/git. Existing
`StateExport` alone does not satisfy this. There is no approved snapshot or
attestation protocol today. This alternative changes the trust/custody boundary
and still needs a procedure that invalidates stale plans before apply.

If neither custody option is acceptable, request upstream scoped read access
and a consistent snapshot/revision contract, then separately review the upgrade.
No dependency upgrade, new backend/provider or state migration is proposed here.

## Implementation after that decision (not authorized by this document)

1. Factor the current stack declaration into a factory accepting a State layer.
   Keep the default deployment entry using the current backend. Planning uses
   explicit `makeHttpStateStore` behind a fixed-origin, redirect-rejecting,
   exact-path/method allowlist with no refresh fallback, then an immutable
   process-local StateService. All write methods die; missing listed rows,
   malformed values, unknown status/history and unresolved references fail.
   Audit preflight/provider hooks and confine all network paths, including SDK
   HTTP clients and direct fetch, rather than trusting the word "plan".
2. Validate target against both the verified backend origin and resolved provider
   environment, not environment variables alone. Require authoritative rows for
   **SupportDB AND independent SupportLedger**: settled status, live mode,
   matching FQN/type/instance, distinct nonempty physical IDs, stable names,
   Tipme account and EU jurisdiction. Never infer prior identity from config or
   auto-adopt missing state. Handle nested history and every listed record;
   missing records never become creates by default.
3. Invoke native `Stacks.plan` through the planning entry, validate `.native`
   including resource deletions/orphans, action deletions and historical cleanup.
   Reject either database's create/adopt/replace/delete/orphan/rename, mode
   switch, missing identity, unexpected type, unknown action or malformed plan.
   Allow reviewed additive changes and forward-only migration updates only
   when both identities remain intact. No down-migration or joint ledger restore.
4. In the authorized apply process retain the exact native plan and provider
   session; validate source/migration digests, writer exclusion and fresh
   candidate-specific human authorization before apply. A read-only State service
   cannot persist an apply: the explicit capability handoff must be separately
   tested. `Apply.ts` exports `apply(plan)`, which resolves State from context;
   use that native object with the original session context, replacing only State
   with a writable service for the same previously verified endpoint **after**
   authorization. Do not enable writes in the acquisition process. The high-level
   `Stacks.apply(snapshot)` supplies `snapshot.session.context` internally, so an
   outer State override does not accomplish that handoff. A separate
   `alchemy deploy` recomputes a different plan; replacing PR109's early CLI gate
   alone is insufficient. Do not serialize native objects as invented JSON or
   publish renderer rows. Preserve all provenance, reviewer, retain and
   guarded-destroy checks.
5. Before enabling, add engine-generated native fixtures with installed live D1
   provider diffs for additive acceptance; each database's name/jurisdiction/
   account replacement, deletion/retained orphan, missing/renamed/corrupt prior
   row, old cleanup, wrong target and unknown plan rejection. Assert zero writes,
   bootstrap, temporary Workers and mutation APIs across success, missing/stale
   credentials, wrong versions, transient failures and recovery paths. Sanitize
   errors/telemetry/progress; discard confidential state after the process.

Only after those local proofs and separate authorization may authenticated
**Test F for both databases** be attempted. It remains live evidence, not a
fixture flag. Required environment reviewers, candidate-specific approval and
other #20/#29 readiness evidence remain outstanding; PR108/PR110 are untouched.

Local validation: 11 protocol/limitation tests and all 113 CI-script tests pass;
Worker typecheck and lint, affected-file ESLint, workflow policy, runtime matrix
policy and `git diff --check` pass. These results validate this investigation's
scope only. They neither complete the proposed adapter nor establish readiness.
