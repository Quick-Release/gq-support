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
  is deeply copied/frozen; writes and cross-project reads fail. The sequential
  follow-up adds native marker decoding and bounded same-stage references as
  detailed below. Unknown runtime classes, callbacks and history remain
  refusals. No history is erased to make a plan pass.
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

1. Supply/review the immutable `ReviewedEndpoint` manifest. The sequential
   endpoint/decoder follow-up implements authenticated bounded read-only checks
   in `endpoint-attestation.ts`, but no live manifest or credentials have been
   supplied. See the exact trust anchor and supported route below. Construction
   of an interface or an environment value never verifies the endpoint.
2. Confirm the authoritative live graph fits the implemented native decoder.
   Native engine-generated fixtures establish representability of the resolved
   representative Worker/D1/GitHubAppSecret/action graph, not the live graph.
   Cross-project/stage references, callback-bearing expressions, unknown tags
   and replacement history remain refusals. There is no `StateSerialization`
   module in installed beta.83; unresolved native Output proxies are functions
   that `StateEncoding` leaves untouched and JSON omits. Recovering missing
   behavior from persisted expression-shaped JSON would require a separately
   reviewed serialization format with source provenance; this code never
   invents that behavior. No history is erased to obtain acceptance.
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


## Sequential endpoint/decoder slice (2026-10-27)

This follow-up is code-only and remains a disabled integration. The production
entry still dies before any credential-file read, network access or declaration
execution. It does not implement provider network confinement, candidate
approval continuation, apply integration, writer exclusion or live Test F.
PR109's workflow refusal and PR112's native D1 policy are preserved.

### Reviewed endpoint trust anchor and completed interface

`acquireAttestedSnapshot(manifest, stateBearer, readToken, transports)` always
executes `attestEndpoint` before the confined native HTTP state acquisition.
Credentials and transports are separate; the state bearer never goes to the
Cloudflare API, and the read token never goes to the state origin. There is no
profile/cache lookup, file read, bootstrap, upgrade, recovery or ambient fetch.
The low-level `acquireHttpSnapshot` remains a decoder/transport primitive and is
not endpoint attestation or authorization. No production caller wires either
primitive to the stack.

The immutable manifest must be reviewed source metadata, not environment-driven
self-attestation. Its exact missing values are:

- Tipme account `8f38791a8c37b182239af2a385ab3c31`, `GQSupportWorker`, exact
  protected stage, protocol **7**, state path `/state`, exact script name and
  canonical HTTPS `workers.dev` origin. No live name/origin is invented here.
- Exact active deployment UUID, version UUID, strong script ETag, entrypoint module name, and bundle
  digest. The digest is SHA256 of JSON of sorted module rows
  `[part-name, filename, MIME-type, SHA256(module-bytes)]`, independent of the
  multipart boundary. `cf-entrypoint` must exactly match; absence never triggers
  Wrangler's fallback. Version `resources.script.etag` and the content response's
  strong ETag must match the reviewed value (HTTP quotes accepted; weak ETags
  refuse). Missing ETag blocks verification: the script-wide content API is not
  assumed to return the active version. The reviewer must establish that this code implements
  protocol 7 and the intended state semantics; `/version` alone cannot do that.
- Exact version binding set, including Durable Object namespace/class identity
  and Secrets Store store IDs/secret names for authentication and encryption.
  No secret values belong in this manifest. Unsupported binding types refuse.
- Every expected resource/action FQN, type/kind, resource instance ID and provider
  version, plus explicit required decoded row paths and stack-output paths.
  `Worker`, `GitHubAppSecret`, `SupportDB`, `SupportLedger` are required at their
  existing FQNs/types; an extra or vanished row refuses. Required paths may not
  traverse prototypes. Any actual additional action must be listed and settled;
  PR112's plan policy still refuses application actions.
- Both D1 physical UUIDs, names and state instance IDs. They must be distinct,
  retained and EU, match state, and match authenticated D1 metadata in Tipme.

Only canonical `workers.dev` routing is supported. Authenticated account
subdomain + script subdomain metadata must reconstruct the exact origin, with
script routing enabled and previews disabled. Custom domains, aliases, preview
URLs, missing metadata and redirects refuse; no hostname assertion substitutes
for this check. The active deployment must contain exactly the reviewed version
at 100%, checked before and after reading version/bundle metadata. Version binding
metadata must exactly match the reviewed set. These observations do not establish
CAS, ABA safety, writer exclusion or the identity of any future deployment.

The first-party GETs are exactly account Workers subdomain, script subdomain,
script deployments (twice), the one reviewed version, script `content/v2`, and
both reviewed D1 database metadata paths. State acquisition separately verifies
protocol 7, stage existence, every listed row, empty replacement cleanup and
stack outputs. No POST/PUT/PATCH/DELETE request is available in these interfaces.
All responses are streamed with an 8 MiB body bound and ten-second fetch signal;
state acquisition also caps 300 requests, 32 MiB aggregate response bytes and
256 listed rows. Graph traversal caps 100,000 nodes, 8 MiB strings/keys per
operation and depth below 64. Namespace depth is below 32. The injected dedicated
transports must honor TLS, redirect rejection and abort signals; these are trusted
transport dependencies, not an arbitrary remote adapter.

The [Cloudflare script API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/)
provides the content, version and deployment endpoints. The
[script subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/)
provides the routing flag; the account subdomain API supplies the account hostname.
Implementation also checks the installed `@distilled.cloud/cloudflare`
1.0.0-rc.15 Workers/D1 schemas used by Alchemy. Its content response schema is
empty, so code reads and bounds the multipart response itself. Pinned Wrangler
4.133.0's `fetchWorkerDefinitionFromDash` supplies independent installed evidence
for multipart decoding and the `cf-entrypoint` header; this slice never invokes
Wrangler or its authentication/bootstrap paths.

### Native decoder and fixture evidence

Fixtures run installed `Plan.make`, then installed `Apply.apply` with inert local
providers into installed `InMemoryService`, then installed `encodeState` and JSON,
then the confined native `makeHttpStateStore`. This is simulated local fixture
creation, not provider execution against Cloudflare/GitHub or an authorized apply.
The representative graph has both D1s, Worker, GitHubAppSecret and a fixture-only
settled action; native-generated instance IDs, downstream edges, input hash and
outputs are validated. The native planner consumes the decoded graph with inert
providers and read-only State and produces resource/action no-ops. Existing
PR112 tests independently retain the actual live D1 provider's local diff proof.
Neither harness invokes the full shared declaration or grants its providers
network capability.

Native Redacted/Duration/Date marker forms roundtrip without arbitrary prototype
hydration. Wire keys, shape, size and duration payloads are checked before the
native recursive reviver, including before BigInt conversion. Secret payloads
stay in process memory; ordinary Redacted inspection/JSON stays redacted. Reads
return new defensive copies: freezing a Date does not freeze its internal slot,
and wiping one returned Redacted wrapper cannot mutate the private snapshot.
Native Resource flattening is preserved as data (`id`, `type`, `props`, optional
`attr`), with exact project graph identity validation, without creating a Resource
prototype. Native encoding of a declared resource omits its unresolved attributes;
tests assert that behavior instead of inventing an attribute snapshot.

Safe actual in-memory native Literal/Prop/All/Named/Resource/Ref/StackRef
expressions can resolve only from this exact listed graph/output. Cross-stack,
cross-stage, missing/mistyped sources, dangerous paths and reference cycles
refuse. Apply/Effect/FlatMap callbacks cannot execute in this decoder. Native
Output proxies are not a supported persistent wire format: tests assert the
encoder returns functions and JSON omits them; persisted `kind: RefExpr` claims
refuse. The persisted resolved graph roundtrip and in-memory reference proof are
separate evidence. Unsupported persisted references require authoritative
format/source evidence and a reviewed decoder; historical cleanup needs a separate
history policy, and historical D1 replacement cleanup always refuses.

Reserved private delivery remains `ALCHEMY_STATE_BEARER_FILE` and
`CLOUDFLARE_PLANNING_READ_TOKEN_FILE`; no file is read by this change. Later owner
authorization must provide the existing state bearer and a separately scoped
Cloudflare read token able to read Workers content/metadata and the two D1s.
This change neither inspects current token permissions nor mints a token. The
approved broad-bearer custody decision is unchanged. Live endpoint inspection,
authoritative graph inspection and a candidate-specific live plan remain
separately unauthorized here; the parent can request private delivery only after
reviewable code and the other gates are complete.

The version API schema documents `resources.script.etag` as hashed script content.
The content API returns an untyped response; its header availability is not
promised by that schema. This verifier requires a matching strong content ETag
and fails closed if it is absent. Later authorized read-only inspection must
establish that this supported linkage exists. The reviewed tuple of version ID,
ETag, module digest and protocol semantics remains the minimal external trust
anchor; this code does not manufacture independent source provenance or infer
that tuple from the hostname. If the deployed API cannot supply the linkage,
this supported verifier cannot attest it; a separately reviewed immutable
version-content provenance mechanism would be needed, not a boolean override.

Slice validation: 206 affected Worker tests across ten files pass, including 72
new endpoint/decoder tests and all 134 prior affected tests. Worker typecheck and
lint, all 113 CI-script tests, workflow policy, runtime-matrix policy, affected
code/document secret scans and `git diff --check` pass. New negative fixtures
cover wrong/missing metadata, active-version/content ETag divergence, weak ETags,
route/bundle/protocol/account/binding/physical DB mismatch, graph identity and
required-path gaps, malformed wire before native revival, vanished rows,
unsettled state, missing action hash, history, reference scope/cycles and callback
refusal. No native policy bypass was introduced; PR112's D1 rejection tests pass.
No live endpoint, authoritative state, provider confinement, human approval,
exclusive writer window, Test F, release or deployment is established here.

## Sequential offline declaration/provider slice (2026-10-27)

This supersedes blocker 3 above **for this pinned, trusted, existing four-resource
prod graph**. It adds an executable Linux offline boundary and a real native
local plan; it does not enable the production entry, acquire live state, or
implement approval/continuation/apply. The previously exported in-process
`planningStackFromSnapshot` factory is removed: importing the blocked entry no
longer imports the application's declaration graph. Ordinary durable-stage
CLI/workflow refusal remains unchanged.

### Execution and credential boundary

`runConfinedPlan` accepts only synthetic/already-acquired state, independently
supplied reviewed database identities, and a trusted preflight adapter. It never
accepts or reads a state bearer, metadata token, credential file, profile or
approval flag. `planningPreflight` invokes the existing `verifyApp` with a
separate injected transport restricted to `GET https://api.github.com/app`:
JWT header only, no body, redirects refused, 64 KiB response bound, exact App
identity/owner/permissions/events, webhook configuration validation, no retries.
The JWT is derived locally as before; no installation token, exchange or token
minting API is invoked. Only public verified App metadata leaves that adapter.
The caller/adapter and first-party transport are trusted code, not an interface
that grants a user the ability to assert preflight success. Wiring to live
credential delivery is still absent.

State bearer acquisition and read-only Cloudflare endpoint attestation retain
PR113's separate exact-route transports. Neither transport/capability enters the
application process. No Cloudflare provider read is needed for the supported
complete existing-state path, so **no provider network operation is allowed**,
including POST query APIs. Cloudflare's [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
can execute SQL; this implementation grants it no permission, including for a
request claiming to be read-only. Missing state never causes bootstrap,
repair, recovery, adoption, edge-preview provisioning or metadata fabrication.

The launcher copies tracked Worker source plus root package/workspace/lock files
to a private temporary directory. It refuses symlinks and credential-file names;
there is no checkout, `.git`, dotenv, home/profile, credential-file or host socket
mount. Source copying uses `git ls-files` with empty credential-bearing environment,
system/global config disabled and fsmonitor disabled. The installed dependency
trees and Node executable directory are mounted read-only. No install or upgrade
happens inside the planner. The temporary source directory contains **no input
state or credentials** and is removed on success/error. Raw snapshot data enters
only via an anonymous stdin pipe.

`/usr/bin/bwrap --unshare-all --cap-drop ALL --new-session --clearenv` creates new
network, PID, user, IPC and mount namespaces before importing any declaration.
The only host mounts are read-only source/dependencies/runtime and `/usr`, `/lib`,
`/lib64`. The child gets private `/tmp`, `/proc` and `/dev`, no inherited proxy,
Node options, tracing/exporter or credential environment, and no host socket.
Network isolation also covers the native Rolldown binding, alternate SDKs,
TCP/TLS/UDP/DNS, direct global fetch and **all descendant subprocesses**. Local
scratch/build writes are allowed only in the private runtime filesystem; the
source/dependency mounts cannot change. There is no monkeypatch-based security
claim. Missing bubblewrap, denied namespaces, unsupported platform/runtime/import,
build errors, missing state and unknown reads are executable constant refusals;
there is no unconfined fallback. A synchronous runtime guard runs before the
application imports: it checks the actual read-only source/dependency mounts,
network interfaces, hidden host directories, executable/cwd and cleared
environment. Accidental direct invocation refuses before loading declarations.
These checks supplement the trusted launcher, not an environment attestation or
an authentication mechanism for malicious runtimes.

Trust is explicitly placed in the Linux kernel, bubblewrap binary/options,
Node/system libraries/toolchain, trusted checkout, reviewed lockfile/dependencies,
launcher and preflight/acquisition adapters. This is not a generic malicious-code
sandbox, kernel-exploit defense, or denial-of-service boundary. `/usr` and the
runtime/dependency mounts must contain only trusted toolchain files, not
credentials or host service sockets. Availability of this runtime has been
proved on this workstation (Node 24.21.0, bubblewrap 0.11.1), **not on a protected
runner**. The runner must establish the same assumptions and run the canaries;
the tests deliberately do not silently skip missing isolation. Neither network
namespaces nor a lockfile attest that the code or a deployed endpoint is benign.
The [bubblewrap documentation](https://github.com/containers/bubblewrap/blob/main/README.md)
states that protection depends on the supplied mounts/options and describes its
network namespace and socket limitations. The [Node Permission Model](https://nodejs.org/api/permissions.html)
is not used as a substitute for this OS boundary.

### Audited beta.83 graph paths

- `supportStack` uses the same D1 + Worker + GitHubAppSecret declarations in both
  modes. Planning requires an explicit preflight/provider dependency; absence
  refuses. Default deployment still uses its existing preflight/providers and
  durable-stage guard. The isolated process supplies only verified public App
  config and the immutable snapshot, with no ambient profile/config loader.
- `Cloudflare/D1/Database.ts` `ProviderLive.diff` checks account/name/jurisdiction,
  replication and `SQL/Migrations/Registry.ts` local migration/import hashing.
  With both settled rows retained, these paths need filesystem/metadata only.
  No migrations or provider reconcile run. Both independently supplied physical
  IDs/names and native instance IDs must pass the existing native policy.
- `Cloudflare/Workers/WorkerProvider.ts` `LiveWorkerProvider.diff` compares
  account/namespace/name, domain/routes/crons, metadata and source hashes.
  Current source has no custom domain/routes/source adapter/Vite/preview/version
  or custom build hooks. `Sources/Rolldown.ts` and `Bundle/Bundle.ts` build the
  actual shared `src/worker.ts` entry and its declared exports. An explicit
  installed build is required even if diff short-circuits on metadata. The
  native planner then uses the installed Worker diff, not a handwritten plan.
  Unsupported source/build/preview/version inputs refuse. Future code changes
  remain offline and require review; a new required API read is a refusal,
  not a reason to broaden GET/POST permissions.
- `GitHubAppSecretProvider.diff` deliberately returns update. Its key/webhook
  provisioning and deployed-key check are apply-only and cannot run here.
- `planningProviders` uses only installed live D1 and Worker providers plus the
  application secret provider. A supported `Provider.effect` wrapper preserves
  their actual diff/stables/version and replaces **read/list/precreate/reconcile/
  delete** with immediate defects; tail/logs/local-mode capabilities are absent.
  It does not construct `Cloudflare.providers()`, `CloudflareApiLive`, any auth,
  credential/profile store, Docker/local-runtime or `Cloudflare.state()` layer.
  Cloudflare account metadata is explicit and SDK credential resolution dies.
  A deny-all Effect HttpClient is additional defense; it is not the OS boundary.
  Alchemy's [state-store documentation](https://alchemy.run/state-store/) describes
  bootstrap and CI edge-preview credential resolution, reinforcing the decision
  to omit that backend entirely. Installed beta.83 source/types, rather than
  rolling documentation examples, determine the exact API used here.
- Before declaration, immutable acquisition requires exactly the four settled
  resources/types. Missing resources refuse before ownership probes. Unknown
  actions/resources, history, deletions/orphans, wrong identity and checksum/SQL
  violations still fail the existing policy without discarding evidence.

Node's [synchronous module hooks](https://nodejs.org/api/module.html#moduleregisterhookshooks)
load the checkout's TypeScript through its already installed compiler, because
native strip-only mode cannot handle its parameter properties. The existing
revocation JSON import now has the standard JSON import attribute so it can be
loaded by Node. No dependency or compatibility-date change was made.

### Local native evidence and output contract

`confined-planning.test.ts` executes the shared application with installed native
`Plan.make`, installed D1/Worker/GitHubAppSecret diffs, and the installed Worker
build inside the offline runtime. The representative existing-state plan is
`SupportDB=noop`, `SupportLedger=noop`, `Worker=update`,
`GitHubAppSecret=update`; neither DB changes physical identity. The application
secret provider intentionally updates on every deployment. No apply is invoked
by the planning entry.

A separate fixture runs native Plan + **simulated local** Apply against inert
providers for the same shared declaration, producing native instances, props,
bindings, downstream edges and outputs. Installed StateEncoding, synthetic HTTP
and installed `makeHttpStateStore` then acquire that graph through nine confined
GETs. Installed provider planning/build consumes the acquired graph. This
fixture-only simulated apply neither calls live provider reconcile nor applies
SQL. It is separate from the real provider diffs used for the resulting plan.
There is no claim that the synthetic Worker hash matches deployed source.

Canaries cover direct global fetch, HTTP(S), HTTP/2, TCP/TLS, UDP, DNS, host Unix
sockets, descendant Node fetch, host-file reads, read-only source writes, proxy
and environment inheritance. Provider lifecycle probes verify immediate refusal
of every read/list/precreate/reconcile/delete for all three providers, absence of
log/tail/local-mode capabilities, direct POST query refusal and actual installed
SDK `queryDatabase` refusal. Missing each resource, mismatched independently
supplied DB identity, and preflight 401/403/404/429/500/redirect/malformed/oversize/
transport errors refuse. Preflight errors make exactly one request. Existing
HTTP acquisition/attestation error/retry tests still cover exact GET-only state
and metadata access without recovery or writes.

Native loggers are empty and progress defaults to no-op. The launcher discards
child stdout/stderr without retaining or replaying errors. Only a 1 KiB-bounded
fd-3 response with exactly four resource names and action enums passes the parent
schema. Raw state, Redacted canaries, JWT/header/key/webhook material, plan props,
source/bundle text and native errors never reach that summary. Canary tests put
sensitive synthetic state into the snapshot and print simulated sensitive
progress/errors in the child; parent output remains clean. The native plan and
its service context are never serialized or exported.

### Remaining code and live gates

The offline worker intentionally exits after its local summary. That summary is
**not** an approvable/applicable candidate or a retained continuation. A later
slice must keep the exact native object/context alive inside the protected
process, implement fresh authenticated candidate-specific approval and writer-
window verification, and provide a separately reviewed narrow apply/writer
capability only after those checks. Reconstructing a plan from this summary or
relaxing the offline boundary is not an implemented continuation. No real apply
adapter exists here; production remains blocked.

Live prerequisites remain the reviewed endpoint/version/bundle manifest and
physical DB identities, authorized credential delivery via separate transports,
confirmation that the authoritative native graph/outputs fit the supported
format, protected-runner isolation proof, owner-controlled exclusion of **all**
state writers from acquisition through apply, required vvaz/gmarques reviewers,
a candidate-specific production approval, and separately authorized live Test F.
The already approved direct existing backend bearer custody decision is unchanged.
No credential was requested/read/extracted/minted; no service, environment,
setting, production state, release or deployment was touched. #20/#29 remain open.

Slice validation: 218 planner/guard/custody tests across ten files (21 new
confinement tests), plus 169 affected application/webhook tests across eight
files; Worker typecheck/lint; all 113 CI-script tests; workflow/runtime policies;
affected deploy/test/research secret scans and diff checks pass. A local negative
control temporarily allowed provider reads: the lifecycle canary failed with an
assertion (exit 1). Restoring the wrapper returned it to green. Transport probes
require actual kernel error codes (including ENETUNREACH and EROFS); a timeout is
not accepted as proof of denial. This is local fixture/runtime evidence, not a
live Test F or protected-runner result.

## Authenticated retained-process continuation (follow-up to PR114)

This section supersedes the earlier missing-continuation/always-die descriptions.
The production entry is now executable when **reviewed source configuration** and
all independent prerequisites exist. `reviewedPlannerConfig` is deliberately
absent. No live credential, endpoint, approval, setting, workflow dispatch,
deployment, migration, provisioning or Test F was used during implementation.
Names vvaz/gmarques are authority policy, never release approval.

### Implemented protocol and authority

The trusted launcher takes the local exclusive lease **before acquisition**,
checks the committed clean source and protected workflow, authenticates the exact
GitHub repository/run/attempt/main/head and environment policy, acquires the
attested endpoint snapshot, and runs the existing exact `/app` preflight. It
copies and hashes the tracked source/lockfiles/SQL. The namespace child independently
hashes that copied source and checks its exact file inventory before declarations. Neither an environment flag nor a
caller-constructed verifier supplies human authorization.

The child executes installed beta.83 `Plan.make` once. It holds the actual native
object, provider functions, Effect scope/services, read-only snapshot and
resource-scoped ArtifactStore while awaiting approval. The explicit installed
build uses the native `Artifacts.cached("build")` bag, also used by installed
Worker diff/reconcile. Approved module names, entrypoint and byte hashes are bound
into the candidate identity; the broker independently hashes the multipart upload
and refuses differing bytes before sending it. Before the phase gate or first
State checkpoint, the child also checks the retained build object in the original
native artifact bag and rehashes its bytes. Native object/provider/function
integrity is checked by `retainCandidate` immediately before the one-shot Apply.
No native plan is encoded, written, restored, reconstructed or replanned.

Public output is at most 2 KiB: exact four-resource actions, source/lockfile/SQL/
target/state/window digests, bundle digest, random candidate/nonce, trusted
plan-ready/expiry times, and the approval command. Private state, outputs, source,
module contents, App fingerprint, native errors and progress stay off logs and
artifacts. Only private anonymous pipes carry snapshot data, bounded SDK request
bytes, State commits and public custody results. The FD protocol has sequential
IDs checked **before dispatch**, fixed operation names and exact message shapes;
there is no CLI, arbitrary method, callback or remotely supplied entrypoint.

The owner manually creates one exact command on issue #20 **after** plan-ready:

```text
approve-plan Quick-Release/gq-support RUN/ATTEMPT HEAD CANDIDATE NONCE
```

The candidate digest binds the reviewed exclusive-window duty as well as source,
state and target. Approval means the approver has reviewed that evidence and
confirms the owner-controlled exclusion is still true. The launcher performs no
comment, review, deployment or dispatch writes. Approval is transported through
[GitHub's documented issue-comment GETs](https://docs.github.com/en/rest/issues/comments):
list the issue's comments since plan-ready (one bounded page; pagination or 100
rows refuses), then re-read the exact comment. The supported numeric vvaz/gmarques
IDs must be supplied in reviewed metadata. They are independently checked against
current `/users/{login}` and repository permission GETs; current write/maintain/
admin access is required for both. Username assertions, `author_association`,
self-reported times and fake verifier objects confer no authority.

[Workflow-run metadata and environment approval history](https://docs.github.com/en/rest/actions/workflow-runs)
bind the exact numeric repository, run ID, attempt, workflow path, dispatch event,
main head and `in_progress`/null conclusion. Main must still point at that head,
be protected with reviews/admin enforcement and disallow force push/deletion.
The [environment GET](https://docs.github.com/en/rest/deployments/environments)
must show prod, protected-branch deployment policy and exactly the two reviewed
numeric User reviewers with prevent-self-review. An actual approved environment
review by an authorized numeric identity must exist for this run; ambiguous
history refuses. That earlier review **does not** approve the later candidate.
The documented environment response has no `can_admins_bypass` property: this
implementation does not invent one. Missing policy/API permissions refuse.

The post-plan comment must have an authenticated GitHub creation time strictly
after ready, before expiry, at most five minutes old, no edits, and exactly the
bound command. There is one accepted comment ID. Editing/deleting it revokes the
candidate; editing it back still changes its update timestamp. An observed exact
`revoke-plan` command from an authorized identity also invalidates it. Use
**edit/delete of the original approval** as the durable revocation procedure;
a transient separate comment that is deleted before observation is not an
observable revocation history. Duplicate/conflicting approvals, wrong identity,
replaced candidate/nonce, cancellation, changed main/permissions/environment,
transport uncertainty, deleted approval or timeout close the continuation.
Approval polls every five seconds for at most ten minutes; the retained process
has a fifteen-minute bound, and each GitHub GET has a ten-second abort bound.
Approval is rechecked before every broker operation. There is no instantaneous or
atomic revocation guarantee between a successful check and a request already sent.

Immediately before initial capability handoff the trusted launcher rechecks
GitHub, independently reacquires endpoint/version/bundle/bindings/DB metadata and
all state, rehashes clean source/lockfiles/SQL, and checks the same exclusive lease
and window. Any divergence invalidates the candidate. The final native integrity/
policy check and protected phase gate run inside the original child context.
There is no replacement of frozen-plan provider functions: the wrappers' original
reconcile closures consult a private one-shot capability that was closed throughout
planning. Failure/uncertainty closes it permanently. All read/list/precreate/
delete/local-mode/telemetry capabilities remain denied, including during apply.

### Real-provider apply profile and credential custody

The first supported narrow profile is **both D1s noop**, existing Worker update,
existing GitHubAppSecret update, prod only. Both physical DB IDs, names and native
instances remain checked against independent reviewed identity evidence. The
broker has no D1 query/create/delete/patch route, and no D1 State-write permission.
It deliberately refuses pending D1 updates even when the native additive policy
would allow their plan. This is a remaining **CODE scope restriction**, not a live
credential prerequisite or a claim of technical impossibility in beta.83.
Staging, Worker create/noop, new resource types, assets, managed domains/routes,
DO lifecycle/exports, version deployments, preview sessions from the graph and
other SDK surfaces also refuse. Broadening this reviewed profile needs code and
corresponding native/API tests, never a runtime bypass flag.

The installed Worker provider's actual reconcile/build runs **inside the same
network namespace**. SDK credentials resolve only to an unusable placeholder;
Effect HttpClient routes its bytes through the private broker. The broker ignores
child headers, supplies the actual deployment token in its own closure, and
allows only this Tipme Worker's settings/subdomain/schedule reads, exact multipart
script PUT, enabled/non-preview subdomain POST and the one scheduled cron PUT.
It accepts native Config's Redacted wire representation only for the three
verified **public** App ID/client-ID/slug values. It grants no App private key,
webhook secret, state bearer or arbitrary secret binding in the graph/upload.
The shared declaration explicitly disables application preview URLs because
beta.83 otherwise enables them by default. Logs/traces settings are unchanged;
Discord delivery remains absent and gated separately.

State commits use installed beta.83 `makeHttpStateStore` behind an exact prod
project/Worker/AppSecret PUT-only HttpClient, using the existing approved bearer
in the trusted broker. Each installed writer operation receives one transport
ticket consumed before sending: its native retry helper cannot resend an
uncertain commit. Native `updating` checkpoints contain the
previous settled row in `old`; those checkpoints are preserved on failure.
Replacement history/deletion remains forbidden. The broker verifies the original
native instance IDs, denies State deletes and cross-stack paths, and commits the
stack output only after all custody checks succeed. The broad bearer's service-side
cross-stack authority remains disclosed and unchanged; its value never enters
the graph or child credential environment. Each request has a ten-second bound,
fixed count/size limits, no redirect and no broker retry. An uncertain write
poisons the session. Installed provider retries cannot replay a refused/uncertain
mutation through this broker.

`GitHubAppSecretProvider` keeps its installed application reconcile identity and
runs existing App-key/webhook provisioning through trusted custody dependencies.
The trusted process alone holds the key and webhook; its direct fetches are
restricted to GitHub `/app` and Cloudflare secret operations for the already-bound
Worker. Before every direct call it repeats authenticated approval/window checks.
It uploads the key/current webhook and updates/removes the previous webhook as
before. No key, webhook URL/value or state bearer is persisted in plan props.

The final deployed-key check still uses existing `checkDeployedGitHubApp` and
Wrangler 4.133.0 `getPlatformProxy`, with one fixed remote service binding and one
`checkGitHubAppKey(clientId, slug)` RPC. Installed `GetPlatformProxyOptions` offers
no explicit credential argument. Therefore that **trusted apply-only custody
operation** runs in a dedicated 30-second process with an empty temporary HOME,
explicit deployment token/account, metrics off, no env files/profile/state store,
and discarded stdout/stderr. The dedicated process group is killed on timeout
and cleaned up after exit, including inherited custody subprocesses. Only public check evidence returns on fd 3.
Wrangler's temporary remote-binding preview session/network and subprocesses are
an explicit privileged part of that operation, consistent with
[Cloudflare's supported remote service bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/).
They never run in planning or receive the broad state bearer/App key/webhook.
This is not a claim that the graph can open preview sessions or arbitrary sockets.
The final check is authorized as a bounded custody operation, with checks before
and after; it cannot offer per-packet revocation inside Wrangler.

The kernel/runtime/read-only dependencies/source remain the explicit trusted
boundary. Native code and descendant graph subprocesses remain offline, including
after approval; only brokered operations gain privileges. State/metadata bodies
retain the 8 MiB bound. The installed unminified multipart Worker needs a separate
32 MiB binary/48 MiB protocol-frame limit; only that upload can exceed the ordinary
state limit. Broker messages/requests are bounded in number. Socket/credential/
source-write canaries remain part of validation. No raw child diagnostics are
retained or replayed.

### Exclusion, partial failure and remaining prerequisites

`exclusiveLocalWindow` uses an exclusive owner-only lock with inode/device/mode
and deadline checks at every boundary. A replaced/missing/expired/stale lock
refuses; it is never stolen or automatically repaired. Protected workflow policy
requires the main-only environment-bound dispatch job and non-cancelling
`deploy-worker-${stage}` concurrency, and forbids CLI replanning/artifact handoff.
The ordinary CLI and destroy durable-stage guards remain in force. These checks
exclude participating local/protected entries. **They cannot exclude an external
credential holder or nonparticipating state writer.**

The owner must stop/exclude **every** other state writer and state-endpoint
acquisition/deployment path, including local operators, other workflows/repositories,
background jobs and credential holders, before acquisition through the last
confirmed apply operation. Approval expressly confirms that continuing duty.
On an uncertain request/partial failure, keep exclusion until incident review
establishes all in-flight operations have settled; a local process exit is not
proof of remote cancellation. Repeated hashes observe drift but do not prevent
ABA, establish an atomic backend revision, or invent CAS in beta.83.

A script upload, secret change or checkpoint may already have succeeded when a
later check fails or approval is revoked. No rollback is promised. Failed
continuations cannot be replayed; authoritative incident reconciliation is needed
before a new separately approved candidate. The updating row/history is retained,
not normalized into a fake successful state. Broker completion requires the
final State output commit, not merely a child `applied` message.

Remaining **CODE restrictions** are the explicitly narrow apply profile above;
there is no claim that unimplemented D1-update/migration, other graph or staging
paths are enabled. Remote custody's real remote-binding service interaction is
not exercised by synthetic HTTP tests; it remains required live validation, not
proof that an unsupported beta.83 adapter is impossible.

Expected **LIVE prerequisites** remain reviewed endpoint/version/ETag/bundle/
binding/physical-DB metadata and supported authoritative native state; reviewed
numeric repository and vvaz/gmarques IDs and App/Worker metadata; protected main/
environment/read-token permissions; protected-runner namespace/toolchain proof
and disabled core dumps; the external all-writer exclusion window; private
existing credentials; fresh candidate-specific production approval; and separately
authorized live Test F for both DBs. Synthetic permission/approval fixtures confer
none of these. #20/#29 remain open; no release/merge/deployment is approved here.

Private delivery contract names only: `ALCHEMY_STATE_BEARER_FILE`,
`CLOUDFLARE_PLANNING_READ_TOKEN_FILE`, `GITHUB_APPROVAL_READ_TOKEN_FILE`,
`CLOUDFLARE_APPLY_TOKEN_FILE`, `GITHUB_APP_PRIVATE_KEY_FILE`,
`GITHUB_WEBHOOK_SECRET_FILE`, optional `GITHUB_WEBHOOK_PREVIOUS_SECRET_FILE`.
The entry requires owner-only 0400 single-link regular one-shot files under
`/dev/shm/gq-protected/` (an owner-only 0700 real directory), basename-only
paths, no symlink final component, bounded sizes; consumed files
are unlinked immediately. The owner supplies/removes any unconsumed delivery
files on failed prerequisite checks and owns rotation/revocation. No value is
accepted on argv or discovered from a profile. Run/head environment fields are
locators cross-checked against authenticated GitHub responses, not approval.


Continuation validation (local synthetic fixtures only):

- Broader affected run: **368 tests / 19 files** passed (178.59 seconds), covering
  native/state/endpoint/isolation and App/webhook/application regressions.
- Final changed-boundary run after installed State writer, exact copied-file
  inventory and original-context capture: **113 tests / 5 files** passed
  (155.74 seconds). It includes same-native real Worker reconcile, installed
  State writes, independently changed source/locks/SQL/target/state/window,
  cancellation, uncertain upload, post-upload revocation, and partial secret
  failure without final output or custody replay.
- Subsequent cached-build identity/byte pre-handoff check: **25 targeted tests /
  3 files passed**, 19 unrelated tests filtered out (48.08 seconds); real
  namespace canaries, the complete retained happy path, and DB-prop/checksum
  guards are included. Trusted direct-fetch custody has **3 further tests**
  using ephemeral generated keys and fake first-party HTTP; no remote RPC
  session is created by tests.
- Worker typecheck/lint, **114 CI-script tests**, workflow policy, runtime matrix
  policy, affected deployment/test/research/workflow/CI secret scans and diff
  whitespace checks passed. A mistaken local runtime-policy filename was
  corrected to `node scripts/ci/runtime-matrix.mjs policy`, which passes.

Fixture development exposed the native updating `old` checkpoint, unminified
multipart size, Config's Redacted representation and beta.83 preview defaults;
these are handled explicitly rather than suppressed. API metadata comparisons
use exact public fields instead of depending on JSON property order. The initial
synchronous pipe reader was replaced with Node's poll-aware stdin/socket streams
so waiting for post-plan approval does not treat nonblocking EAGAIN as EOF. All
child stdout/stderr remain discarded in the final implementation; temporary
static-label debugging was removed. No real-provider network mutation, live
approval, private credential read or Test F is claimed by these results.

## Combined-review corrections

The independent Standards/Spec review identified cancellation during awaited
authentication, approval expiry during the final comment read, and missing
desired D1 retention validation. These were reproduced with deterministic
fake-HTTP/native-plan tests. The old verifier accepted expiry and closure during
its final read; the old native policy accepted a no-op that removed retention.

Cancellation now synchronously closes the broker and approval capability for
both the owner and child lifetime signals. Authentication rechecks cancellation,
candidate expiry and the writer window afterward; the broker and trusted custody
also invoke a synchronous local guard immediately before privileged dispatch.
Normal child completion revokes dispatch too, while a confirmed final output
commit and verified child result still establish successful completion. Remote
operations already dispatched cannot be cancelled or described as rolled back.

The GitHub verifier checks candidate freshness after awaited requests, rejects
closure during verification and rechecks the approval comment's age after its
exact reread. Native policy requires desired RemovalPolicy retain for BOTH D1
resources, including a native no-op, as well as persisted retention.

Staging and D1 update/migration profiles remain unimplemented in this revision.
These corrections do not enable them or establish any live readiness evidence.

## Bounded staging target slice (2026-10-27, stacked on PR115/f587ff5)

This section supersedes the historical **prod-only CODE restriction** above.
Staging and prod now support the same narrow native apply profile: BOTH D1s must
be native **noop**, with independently reviewed physical identities, persisted
retention and desired `RemovalPolicy.retain`; Worker and GitHubAppSecret must
both update. D1 updates/migrations, bootstrap, replacement, deletion, adoption,
new resources and all other previously refused surfaces remain **CODE gates**.
No staging drill, live plan/apply or readiness claim is enabled by this slice.

The reviewed endpoint target selects the closed `prod | staging` union. The
entry cross-checks the environment locator, approval policy, owner-window target
and pinned App slug before private delivery. It binds the full reviewed endpoint
(script/origin/protocol/version/ETag/bundle/bindings/graph/physical D1 identities),
Worker and public App/approval metadata into the target digest. Stage-specific
local lock paths and window digests retain exclusion from acquisition through
apply. Endpoint attestation and protocol-7 acquisition still execute independently;
metadata is never inferred from desired configuration. Both live manifests and
the reviewed launcher configuration remain **unset**.

Only one exact stack/stage may enter the native State input/outputs. The trusted
launcher cross-checks that target against verified App metadata, approval policy,
reviewed broker Worker and both independent D1 identities before starting the
child. The child supplies this same stage to Alchemy's Stage service, snapshot,
plan evidence, retained native object/context and scoped State writer. Cross-stage
native references refuse. Candidate identity additionally includes stage, public
App, broker and approval policy metadata; source/lockfile/SQL/state/window and
cached native bundle integrity remain bound without serializing/replanning.

`ApprovalPolicy.stage` is mandatory. The existing reviewed workflow run-name
binds dispatch stage through authenticated `display_title`, checked with the
exact run/attempt/head/main/provenance policy. The exact Environment and approved
run-environment history must match that stage. Only initial run attempt 1 is
supported: the documented history response has no attempt identity or review
timestamp, so a rerun could otherwise reuse its earlier Environment review.
Reruns fail closed; a new dispatch and fresh gate/candidate approval are required.
This is an explicit remaining CODE restriction for both stages. Both profiles require current
numeric vvaz/gmarques identities, permissions and required reviewers with
prevent-self-review. The post-plan command is now:

```text
approve-plan Quick-Release/gq-support STAGE RUN/ATTEMPT HEAD CANDIDATE NONCE
```

An old command, other-stage command/environment review, edited/stale approval,
missing reviewer metadata, cancellation or changed exclusion cannot authorize
this candidate. Explicit fresh production approval remains mandatory. No comment,
workflow dispatch, environment setting or approval was created by this work.
The implementation uses the documented [workflow-run metadata and approval
history](https://docs.github.com/en/rest/actions/workflow-runs) and [environment
policy](https://docs.github.com/en/rest/deployments/environments), with the reviewed
workflow source as the run-title trust anchor; run titles alone grant no authority.

The broker derives native HTTP State paths from its trusted stage, accepts only
Worker/AppSecret rows with their original instances, checks row App stage/Worker
identity and validates the six shared stack outputs against the reviewed Worker
and D1 identities. It grants no D1 State write or D1 API mutation. The existing
exact [Worker module upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
route remains fixed to the reviewed Worker and cached bundle bytes. Key custody
pins `getquick-support-staging` or `getquick-support`, verified App ID/client ID,
organization, permissions/events and current key fingerprint before secret
writes. Webhook and final remote RPC use that same Worker/App. Fake remote-binding
tests validate only the local boundary; they create no Wrangler remote session.
No installation-token API or new installation authority is introduced.

The parent cancellation/expiry/window dispatch guards, synchronous revocation on
child/owner lifetime end, post-request GitHub freshness checks, native desired
D1 retention check, Linux offline/read-only graph, unusable child SDK credentials,
private RPC framing/drain and completed-output requirements remain in force.

Local validation uses separate synthetic staging/prod Worker names, D1 IDs/names/
instances, App IDs/client IDs/slugs and generated ephemeral keys. Both profiles
exercise the actual shared declaration, native retained Plan/Apply/session,
fake authenticated GitHub approval, installed Worker reconcile and native HTTP
State commits. Native D1 update refusals, source/target/state/window changes,
cancellation during authentication, uncertain upload, post-upload revocation and
partial secret reconciliation are exercised for both profiles. Additional tests
cover stage interchange, endpoint acquisition, scoped output/resource references,
missing metadata, fake remote RPC and existing namespace/secret canaries.

Remaining **LIVE gates** are unchanged: reviewed real endpoint/graph/physical DB
and App/Worker identities; authoritative state representability; current numeric
reviewers/protected GitHub policy and permissions; protected-runner toolchain/
namespace proof; exclusion of every external state writer/endpoint deployer;
private credentials; fresh candidate-specific approval; and a separately authorized
staging drill/Test F for both D1s. The approved existing broad backend bearer
custody and disclosed cross-stack scope remain unchanged. No live prerequisite
has been established; #20/#29 remain open. D1 migration support is a subsequent
implementation task.

Final fixed-source validation: **376 tests / 15 files passed** on Node 26.12.1,
`--maxWorkers=1` (343.74 seconds). This includes **32 retained-continuation cases
(16 per stage)**, with two actual installed-Worker/native-State happy paths,
and **106 approval/broker/custody/RPC/target boundary tests** across five files.
The latter also passed separately after final changes, as did both native happy
paths (2 passed, 30 unrelated cases filtered out). The existing real namespace,
provider/SDK denial, state/endpoint/decoder, native retention and secret canaries
are included. Worker typecheck/lint, 22 affected workflow/release-policy tests,
workflow/runtime policies, affected deploy/test/research/workflow secret scans and
`git diff --check` pass.

An earlier run was started before the final attempt guard and picked up its two
new tests with the older cached verifier; those two failed. The fresh focused
run and final fixed-source 376-test run both pass. A new in-memory snapshot test
also initially used installed protocol 5; it now uses the same explicit synthetic
protocol-7 adapter as the established confined fixtures. The production protocol
check was preserved. None of these fixtures establishes live protocol/identity,
reviewer policy, a remote RPC session or staging readiness.

## Bounded additive D1 profile (2026-10-27, stacked on PR116/86aa8e6)

This section supersedes the historical D1-noop-only CODE restriction. Both
`prod` and `staging` admit an independently attested existing SupportDB and/or
SupportLedger **update only for pending additive migration files**. The other D1
may remain noop. The original instances, physical IDs, account, names, EU
jurisdiction, migration directory/table and retain policies cannot change.
Worker and GitHubAppSecret still require their existing bounded update profile.
PR115/f587ff5's cancellation, synchronous dispatch guards, post-authentication
freshness, desired/persisted retention and completion rules remain in force.
No live manifest or credential/window has been established.

### Installed provider audit and admitted requests

The installed Alchemy **2.0.0-beta.83** sources audited for this profile are
`src/Cloudflare/D1/Database.ts`, `ApplyMigrations.ts`,
`src/SQL/{SqlFile.ts,Migrations/{Registry,Records,Detect,AlchemyFormat,Introspect,Utils}.ts}`,
and `src/Apply.ts` plus native StateEncoding/HTTP State. The installed provider:

1. Commits an updating checkpoint with the exact previous settled row in `old`.
2. GETs the cached D1 UUID. Its missing-resource fallback lists/adopts/creates,
   and its replication drift path PATCHes; **none receive a broker grant**.
3. Uses `PRAGMA table_info("__alchemy_migrations");` and
   `SELECT name, hash FROM "__alchemy_migrations";` for existing native history.
4. Sends each pending flat file, followed by its exact native bookkeeping
   INSERT, as one semicolon-separated SQL query. Four-digit filenames yield
   native `created_at = NULL`; bookkeeping uses `datetime('now')`.
5. Commits the settled row with the full expected checksum map.

Cloudflare documents the required [SQLite/PRAGMA inspection surface](https://developers.cloudflare.com/d1/sql-api/sql-statements/).
The current official [metadata API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/)
and [query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
document the account/UUID paths and query result envelope. The query API accepts
SQL, optional parameters and a batch form; this broker admits **only the installed
single `sql` body**, with exact canonical JSON bytes and no params/batch extras.
The documented multi-statement query surface supplies no cancellation/rollback
promise for a request already dispatched. The provider's comment likewise
explicitly treats D1 HTTP as nontransactional. This implementation does not infer
atomic rollback from a successful local SQLite test. Cloudflare's
[Wrangler migration documentation](https://developers.cloudflare.com/d1/reference/migrations/)
uses `d1_migrations` by default; this profile requires existing native
`__alchemy_migrations`, never assumes those histories are interchangeable.

A separate trusted grant is reconstructed for each pending D1 from its original
native row, independently reviewed identity and **tracked source manifest**.
The child cannot submit SQL for approval or choose another database. File bytes,
hashes, four-digit names, numeric order and the complete committed history must
agree with native plan evidence. Existing history must be an exact prefix;
changed/removed files, duplicate prefixes and out-of-order additions refuse.
At most four new files per D1, 32 statements/32 KiB per file, are supported.
Only the current flat directories and default-disabled replication representation
are supported. Imports/clones, explicit replication/location properties, other
property updates and unknown attribute shapes need a separate code review.

Each grant consumes a fixed sequence: checkpoint, exact metadata GET, exact
native column inspection, exact native history read, each exact pending batch,
then settled checkpoint. The metadata UUID/name must match the reviewed target;
replication drift refuses rather than PATCHing. The existing history table must
have the five native columns in order with supported types. Missing/legacy/
foreign history cannot trigger conversion or table creation. The returned
history must match **every** committed filename/hash exactly, without aliases,
missing hashes, duplicates or extra rows. Only checked migration column/history
fields cross into the child; query metadata and application data are discarded.
No arbitrary report-data read is granted. Planning remains fully offline/read-only
with all provider read/list/precreate/reconcile/delete paths closed until apply.

The broker grants only the selected D1's State path in the reviewed stack/stage.
A native updating row preserves its full original settled `old` value, props,
attrs, bindings and downstreams; it cannot replace an instance or change retain.
Recovery/adoption keys are rejected **before** JSON wire encoding could omit
undefined keys. The new native provider version is the installed provider's 0;
its default-live `providerMode` is legitimately omitted. Settled attrs must be
exactly the installed provider's expected identity and final checksum map.
No existing invalid checkpoint is normalized into a settled starting state.
State commits still use the installed HTTP State writer, one dispatch ticket
per write, without exposing its bearer to the child.

Native stable IDs alone do not wait for schema work: the actual native test
exposed Worker starting before D1 reconciliation completed. The shared Worker
declaration now projects its unchanged workers.dev settings from **whole results
of both D1s**, establishing native dependencies on their terminal reconciliation.
The broker independently refuses Worker mutation/output until pending D1 grants
settle. It does not queue a blocked Worker request in the private channel, which
would prevent the same channel from draining D1 requests. Native noops keep the
same dependency/output values and remain supported.

### Supported SQL and independent upstream fixtures

`additive-sql.ts` implements a bounded lexer and explicit grammar, not a general
SQL interpreter or text-substitution denylist. It recognizes whitespace, line/
block comments, unquoted identifiers, integer/string/NULL literals, punctuation,
CREATE TABLE with typed columns, PRIMARY KEY/NOT NULL/literal DEFAULT, and a
column-local CHECK using equality or IN of literals. One bounded VALUES seed
per table is allowed **only after that same file creates that table**. Quoted
identifiers, expressions/functions, references, triggers, extensions, PRAGMA,
ATTACH, CREATE-AS-SELECT, INSERT-SELECT, multiple-row seeds, conflict clauses,
DROP/RENAME/DELETE/UPDATE, ALTER/backfill and all unknown grammar refuse. SQLite
reserved table prefixes and native statement-breakpoint markers also refuse.
Comments cannot splice keywords; quotes remain literal data, including escaped
quotes, semicolons and comment-like characters. A quoted payload cannot escape
into another statement. Structural validation is performed independently of
source hashes; hashes alone are never a non-destructive proof.

Exact fixture bytes and provenance are under
`worker/test/fixtures/additive-d1/`, deliberately named `.sql.fixture` so neither
Alchemy nor application migration discovery owns/applies them:

- PR108 `0003_maintenance.sql`, source commit
  `e6bb85217c96827bb51ec1759d771730649152bf`, SHA-256
  `9f5536e0097e5f128a5d2167bed62dc95a7ec30f0c1e9f64688afe3fcd2f04ed`.
  Three new tables and the initial `maintenance_control` seed are accepted.
- PR110 `0004_discord_alerts.sql`, source commit
  `4f2f43505376664da86b97593f2f971be0dbe0b1`, SHA-256
  `c817bdef75c5efd7d34553f939de97248c3ac93b1b16da478dfdcdec06c34211`.
  Two new tables and the singleton `discord_alert_control` seed are accepted.

These branches remain independent/unmerged, and **neither fixture ran live**.
Tests use committed fixture bytes without another checkout or git-show at runtime.
If those application branches integrate later, their normal migration files
remain the only application migration owners.

Existing ledger `0002_revocations.sql` is intentionally **not** additive: its
INSERT-SELECT/DROP/RENAME rebuild refuses when pending. If authoritative state
and native D1 history already attest it applied, its exact original checksum
is preserved without rerunning/revalidating it as pending SQL. If either side
shows it pending or disagrees, this candidate cannot apply; a separate reviewed
migration/reconciliation is required. This slice never repairs that history,
restores the ledger or couples it to a SupportDB rollback. Worker rollback uses
an expanded schema; no down-migration is provided.

### Approval, revocation and honest uncertainty

The public ready summary contains only D1 FQN, pending count and a digest over
its reviewed identity, committed history and ordered pending names/checksums.
Both trusted launcher and retained native child independently reconstruct the
same summary. It is included with the cached bundle in the final candidate
digest, which also binds source/lockfile/migrations/target/state/window evidence,
stage, run/attempt and nonce. The existing exact `approve-plan` human command
therefore binds the pending DB targets, counts and bytes without exposing
schema/state/secrets or changing the command grammar. The exact native plan,
context and cached build stay alive; there is no serialized plan or replan.

Each metadata/query/State boundary repeats asynchronous authenticated approval
and the mandatory synchronous cancellation/expiry/window guard at dispatch.
Requests are serialized and consumed before awaiting transport. Unknown query,
body, parameter, extra statement, wrong DB/account/stage, changed history,
failed inner query result, retry or unexpected State progression poisons the
entire broker. Installed provider/State retry helpers cannot duplicate a query
or checkpoint. The one-shot retained candidate cannot run again on success or
failure. Final output additionally requires every pending D1 grant settled and
all existing App custody checks complete.

A successful SQL request can precede approval expiry, cancellation or a lost
response. It cannot be rolled back by closing the broker. Later SQL, checkpoints,
Worker mutations and custody calls stop; the original updating evidence remains.
A deliberately partial SQLite execution and a fully executed batch with a lost
response both leave an incomplete continuation with no final output and no
second SQL dispatch. Keep the owner exclusion window in force until incident
reconciliation establishes remote outcomes/in-flight completion. A new candidate
requires authoritative incident review, settled supported state and fresh
approval; this code supplies no blind retry/recovery normalization.

### Evidence and remaining gates

The new offline native fixtures build the actual shared graph and cached Worker,
retain the native Plan and full service context, replace State explicitly,
run actual installed D1 **and Worker** reconcile, and persist through native
StateEncoding and the installed HTTP State writer. Fake first-party HTTP is
backed by Node 26 SQLite (`node:sqlite`), a faithful runtime for this supported
SQLite grammar, inside the same Linux offline namespace. Both D1s have separate
SQLite databases and pre-existing canary rows. Tests verify each D1 alone and
both together, exact history/checksums including unchanged ledger 0002, unchanged
physical IDs, all fixture tables/defaults/seeds and existing rows, native
updating/settled checkpoints, and replay refusal. Fault cases cover partial and
unknown query outcomes and cancellation/expiry/window termination. These are
local synthetic proofs, not a live Cloudflare transaction or remote RPC claim.
The original authenticated retained continuation, role/reviewer, stage, custody,
state decoder, endpoint, sandbox, source and secret negative controls remain.

Remaining **CODE gates** include all SQL outside the stated grammar, initial/
foreign/legacy history conversion, pending non-additive migrations (including
ledger 0002), other D1 property changes, bootstrap/adopt/replace/delete/orphan/
rename, arbitrary raw SQL, imports/clones, replication changes and data rewrites.
Workflow reruns still refuse because review history does not attest an attempt.
Worker/App create/noop and other previously unsupported provider surfaces remain
out of scope. There is no always-deny replacement for the supported additive path.

Remaining **LIVE gates** are unchanged: reviewed real endpoint/graph/D1/App/
Worker identity manifests, authoritative representable state and native history,
current numeric vvaz/gmarques reviewers and protected GitHub policy, Linux runner
proof, exclusion of all other writers/acquisition/deployment paths, private
credential delivery, fresh candidate-specific approval and separately authorized
live staging/Test F validation for both D1s. No credentials were read/requested,
no profile inspected, no live plan/apply/drill/deploy or settings operation ran,
and #20/#29 remain open. The approved broad state-bearer custody stays confined
to this project's trusted broker; its disclosed service-side scope is unchanged.

Validation on Node **26.12.1**, `--maxWorkers=1`:

- Broad affected native/retained/approval/broker/custody/RPC/state/endpoint/
  evidence/target/sandbox/secret suite: **475 tests / 15 files passed**
  (420.83 seconds).
- After final canonical-body and settled-checkpoint hardening: **152 tests /
  3 files passed** (96.09 seconds): 108 additive-policy cases, 16 actual native
  D1/Worker apply cases, and 28 broker cases.
- After extending the pre-D1 Worker guard to all write routes: **4 selected
  tests / 2 files passed**, 122 unrelated cases filtered (12.51 seconds). Both
  stages rerun the native both-D1 happy path and independently refuse premature
  subdomain/schedule mutations. The policy file now contains 110 cases.
- App provisioning, deployed-key and webhook provisioning regressions:
  **28 tests / 3 files passed** (1.24 seconds).
- **114 CI-script tests passed**; workflow policy and runtime matrix policy
  passed. Final Worker typecheck/lint, deploy/source/test/research secret scans,
  and diff whitespace checks passed. No live credentials, remote RPC session,
  live SQL or deployment was used for these results.

The final focused command was:

```sh
pnpm --filter gq-support-worker exec vitest run \
  test/additive-d1-native.test.ts test/additive-d1-policy.test.ts \
  -t 'refuses Worker mutation|applies both' --maxWorkers=1
```

The full new native file runs without that filter to exercise all six happy
paths and ten fault paths. Original authenticated no-op continuation happy paths
also passed separately for both stages (2 passed, 30 unrelated cases filtered),
and the final broad run includes the full 36-case continuation file.
Initial fixture runs exposed the native checkpoint version/default-mode form,
terminal dependency ordering and the existing `checksums.txt` sidecars; the
corrected profile handles those explicitly. These failures were resolved before
the passing runs above; no guard was disabled or live prerequisite substituted.

### Review correction: retain unresolved writer ownership

The independent review found one P1: the entry's unconditional cleanup removed
its local lock after an accepted D1 request lost its response. A participating
local writer could then reacquire the still-valid window while remote work
remained unresolved. Standards review found no actionable violations.

The entry now runs the entire retained continuation inside the local window's
one-shot `runApply`. It marks ownership for retention before invoking any
continuation code and permits automatic removal only after the continuation
returns successfully and the window still passes its identity/time checks.
Any exception, cancellation, expired window, lost response or cleanup racing
an unfinished continuation preserves the marker while closing its descriptor.
A repeated close is harmless; another attempt is refused. Preflight failures
before entering the continuation may still release a valid lock normally.
This intentionally retains the lock even for a continuation failure before a
remote write: remote settlement is never inferred from a failed run.

Neither expiry nor a different window ID permits reacquisition over the marker.
There is no automated reconciliation, expiry removal or force-clear command.
vvaz or gmarques must keep every external writer excluded, establish actual
remote D1/State/Worker outcomes and completion of in-flight work, and approve a
separately reviewed incident recovery before removal/replacement of the marker
and a new candidate. A local tmpfs marker cannot survive runner destruction or
coordinate other runners: the external all-writer exclusion remains required
through incident reconciliation, including runner loss. Never use a new runner,
reboot or temporary-directory cleanup to bypass unresolved ownership.

Three focused regressions initially failed before this API existed. After the
fix, 144 evidence/broker/additive-policy tests passed, including lost-response
reacquisition, fresh-window refusal after expiry, cleanup during pending work,
successful release and one-shot behavior. Worker typecheck and affected ESLint
passed. These are local lock/transport proofs, not live settlement evidence.

### Bounded Discord custody on integration PR118

This follow-up is stacked on `a15e32c3e86752716bbaa656d21ec1b7b7263ddc`,
retains the four-resource graph and does not authorize live work. It supersedes
PR118's unconditional integrated-Discord CODE gate with actual checked custody.
The default reviewed endpoint/configuration manifests remain unset.

Interface choice: Discord belongs to GitHubAppSecret's existing apply custody.
The mandatory `provisionDiscord(worker)` operation follows webhook provisioning
and precedes deployed-App verification, final App State and output. The child
has a single `app-discord` operation with no privileged arguments. The broker
requires the exact retained Worker, completed migrations/upload/key/webhook and
one-shot operation order; direct PUT/DELETE/PATCH secret/settings requests from
the child remain denied. A protected custody implementation additionally exposes
its immutable public Discord binding for equality with the candidate's binding.
Ordinary custody need not expose a session binding but cannot omit the operation.

The launcher reads reviewed source mode, uses candidate head as release, and
creates a random opaque private-session commitment. Its frozen private URL
snapshot is tied to those values before publishing the candidate. No secret or
unsalted secret digest enters props, native State, offline input, candidate or
transport errors. Only a separately authorized parent delivery may provide
`DISCORD_ALERT_WEBHOOK_URL_FILE=/dev/shm/gq-protected/discord-alert-webhook-url`;
the existing owner/mode/link/tmpfs/one-shot checks apply. Disabled mode rejects
that file. Ambient mode/release/URL cannot override reviewed configuration.
The state bearer and URL remain in the trusted launcher; the RPC subprocess
inherits only the existing deployment token and fixed non-secret launch settings.

Uploads explicitly keep Logs enabled and traces disabled in both modes. Trusted
custody uses the real Discord helper through a fixed method/path/body sequence:
disable, inspect Logs/traces, install URL/release and enable-last, then readback;
or disable, inspect, remove URL/release, verify absence, restore traces while
preserving Logs/settings, then readback. Only the two Discord removal names and
the exact observed observability object with traces enabled are authorized.
Every request consumes its ticket before awaiting authentication and checks the
synchronous local dispatch guard afterwards. Any failed/uncertain HTTP/readback,
abort, expiry or window failure poisons the operation and continuation. There is
no retry, blind rollback or force-clear. The inherited whole-continuation
`window.runApply` retains ownership after any failed continuation, including
before dispatch; external exclusion still must survive runner loss and incident
reconciliation. The implementation does not establish that external fact.

API evidence retrieved 2026-10-27:

- [Worker script and version settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/)
  documents GET `/settings` including bindings and observability.
- [Patch script settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/)
  documents PATCH `/script-settings` with the observability object. Null trace
  propagation policy is normalized as absent, matching installed beta.83's
  null-to-undefined handling; authenticated/accept values are preserved.
- [Secret PUT](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/)
  and [secret DELETE](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/delete/)
  document the exact script secret routes. Secret values cannot be read back;
  verification combines exact acknowledged writes with names/types/settings.
- Installed Alchemy beta.83 WorkerProvider uploads observability in multipart
  metadata and preserves observed settings during its Issues patch. Its API
  input requires camelCase `invocationLogs`, serialized as `invocation_logs`.
  Installed Wrangler 4.133.0 `config-schema.json` confirms Logs/traces fields.
  The Worker runtime continues structured JSON logging. No Discord fetch is used
  for custody verification. Child HTTP replies discard secret binding values,
  error arrays, headers and unrelated response fields, retaining minimal evidence
  needed by installed reconcile. Custody settings responses never enter the child.

Remaining CODE limitations: exact existing four-resource, same-account/stage
update graph only; no bootstrap/adopt/replace/delete/orphan/rename, generic secret
proxy, arbitrary settings patch, SQL outside the reviewed additive profile,
foreign/legacy history conversion or pending destructive ledger 0002. Unknown
observability fields or destinations other than the supported Cloudflare
observability destination refuse rather than being reflected into a patch.
Binding presence/types are observable; secret values and actual Discord receipt
are not proved by settings reads. These are explicit limits, not permission to
skip custody or leave traces off when alerts are disabled.

LIVE remains blocked: real endpoint/Worker/App/native graph/D1/full history
manifests, permissions and numeric reviewers, protected runner proof, private
credentials, all-writer exclusion through reconciliation/runner loss, fresh
candidate approval, remote RPC/key/binding proof, Test F, restore/alert/privacy
readback drills and destination access/retention/receipt arrangements. #20 still
lacks external platform 5xx, missing Cron, deploy, outer tick/prompt wrapper and
failed-route observations. Managed Composer/tested ZIP, Discord webhook routing,
vvaz OR gmarques authority and the approved tracing policy remain settled user
policy; this code adds no new operational authority. #20/#29 are not MVP accepted.
No live state, credential/profile, remote RPC, settings, deployment, Discord
message, drill or merge was performed. Browser/PHP evidence is inherited from
source PRs and is not current integration evidence. See the publication-hook
incident below; DDEV was unintentionally touched by that hook.

Validation for this follow-up, Node **26.12.1**, every Worker/native run with
`--maxWorkers=1`:

- RED on pinned integration: the injected-provider regression failed because the
  Discord operation was absent (1 failed / 8 passed). No production guard was
  bypassed to obtain that result.
- Final full Worker run: **1,233 tests / 48 files passed**, 686.57 seconds. This
  includes all four retained native stage/mode happy paths using real shared
  graph/installed provider/trusted custody/broker/State output, private-environment
  mutation and offline-input/native-State/candidate leakage controls, fake RPC
  environment confinement, native lost-response retained-marker cases in both
  stages/modes, nested authentication abort/expiry/window controls, every custody
  HTTP failure/readback position, wrong method/name/type/value/body/order/stage/
  account/mode/revision and secret-presence/observability negative controls.
- Before that final run, the broad retained/helper/marker run exposed two stale
  test expectations that incorrectly required Discord after a failed webhook.
  They now require Discord not to run; the full final run passes both cases.
- Frozen pnpm install, Worker typecheck and lint, root/app JS lint and all three
  lint negative controls passed. **114 CI-script tests passed**; workflow policy
  and `runtime-matrix.mjs policy` passed.
- Worker/docs secret scans and whitespace checks passed. The candidate-reachable
  history scan passed (**200 commits**); unrelated local refs are not treated
  as candidate evidence. Hosted checks/reviews are uninspected;
  there was no CI polling or watch.

Only validation documentation is completed after the full Worker run. No extra
full Worker rerun is needed for those documentation-only result updates.


Publication-hook incident: the first branch push invoked the repository's
optional browser pre-push hook. Because this was a new branch, its affected-file
list included inherited integration changes and triggered the shared DDEV browser
site despite the task's no-DDEV constraint. The hook built app assets, copied the
plugin, changed the site's plugin symlink and reloaded PHP. Seven browser cases
passed before the eighth was interrupted with SIGINT; 112 did not run. This is
not a complete browser/runtime result and is not readiness evidence. The hook's
EXIT cleanup ran and removed its local test-site symlink after restoring the
shared plugin link/reloading PHP; browser fixture state may have changed. No
further DDEV or browser operation was run. The initial push failed on that
interruption. Publication uses the hook's documented
`GQ_SUPPORT_SKIP_PRE_PUSH=1` switch to honor the no-DDEV constraint. Required
Worker/CI/lint/security checks above remain valid; the optional browser hook is
explicitly interrupted, not passed.

### Discord review correction: propagation policy types

Independent Standards review found no actionable findings. Spec review found
one P2: string coercion accepted an array containing a supported propagation
policy and reflected that array into the privileged restoration PATCH.
Normalization now removes null and accepts only actual strings in the supported
`authenticated | accept` enum. Arrays, objects, booleans, numbers and unknown
strings refuse before PATCH and poison custody without replay.

Two array regressions resolved successfully before the fix when rejection was
required. Added coverage also preserves supported string and null normalization.
All 140 focused custody/helper/broker tests passed, alongside Worker typecheck,
affected lint, secret scan and whitespace checks. No live settings, credentials or DDEV operations were used.
