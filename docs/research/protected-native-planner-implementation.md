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
