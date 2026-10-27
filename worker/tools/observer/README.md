# Observer protocol and fixed HTTPS library

Library only; no monitor entry point, ambient network dispatch, scheduler, persistence or send.
Based on the [observer design](../../../docs/research/external-incident-observer.md).

`decodeBatch(reviewedContext, trustedReads)` checks proposed normalized JSON and
returns bounded evidence; `evaluate(context, batch, priorState?)` returns private
in-memory carry plus a separate public eight-class verdict. Only `public` is
publishable. `State` contains private candidate/workflow identities and must never
be serialized as public output. Carry is trusted output from this module within
a process, not a durable journal or an untrusted persistence format.

The private context pins Tipme, stage, reviewed SHA, activation, maintenance
generation/exclusions and at most 20 run expectations. `Read` provenance comes
from a future trusted adapter: transport result, observation identity, UTC times,
coverage and page count cannot come from a response's health/authentication
assertions. HTTP bodies are empty normalized objects; availability is the trusted
transport's `vantage` classification. The fixed HTTPS library below supplies this
provenance from injected fetch; the decoder itself only caps already received bytes.
No live TLS, DNS or account ownership has been verified.
There are no example live identities, secrets or full fabricated provider replies.

The original normalized snapshot fixture contract remains **proposed**. The actual
version-1 producer wire is now separately adapted, with unknown activation/coverage
and a specialized 240-cell bound as described below. The normalized fixture includes
exact finite phases (delivery, cleanup, refresh, sweep, notification drain),
terminal time only with phase results, storage result and coverage. Maximum ring
span is 60 minutes, four attempts per minute, 100 rows/normalized fixture response. Failed phases,
three-minute incomplete starts, missing starts and explicit maintenance exclusions
remain different evidence. Configured Cron is not input execution proof.

Workflow JSON is a proposed projection, **not** a GitHub API response. The adapter
must join a private expectation on repository/workflow/event/run/attempt/head/
stage/candidate, retain direct lookups beyond 24-hour discovery and propagate
queue/cancel/skip/missing/partial as unknown. No GitHub, schedules or deployments
wire adapter is provided. A successful workflow is only workflow evidence.
Deployment JSON is likewise a proposed candidate projection, not the Cloudflare
deployments envelope; live deployment/version matching is still adapter work.

`analytics-wire.ts` projects only the selected documented GraphQL query envelope
already cited in the design. It strips all fields except bucket time and numeric
counts, checks the expected script name, and never establishes account/stage,
entitlement, sampling or lag. GraphQL errors preserve valid positive error rows
with partial coverage; absent errors still leave unknown sampling/lag. Zero/empty
analytics can never clear an error incident. Error incidents therefore remain
latched until a separately reviewed affirmative recovery contract exists.

Bounds are 64 KiB/body, 1 MiB/batch, 32 reads, 100 rows/query, at most 20 workflow
lookups and three discovery pages per batch (a conservative cap across workflows).
Outstanding expectations are private input, never discovered/evicted here. State
holds eight saturating counters, at most 32 HTTP observations, 100 unresolved Cron
attempts and 20 unresolved workflow identities. Overflow latches and cannot recover
through dropped ownership. Counts measure distinct advancing failure watermarks,
not requests, invocation totals or duplicate observations.

Unknown/partial/stale input cannot clear an incident. Recovery needs fresh
source evidence newer than the failure observation, same candidate/generation
and sufficient coverage. Cron recovery additionally needs a later successful
attempt for each retained failed slot, or a late terminal after the incomplete-start
observation for that same attempt; old successes cannot replace failures.
A ring still containing an explicit failed attempt conservatively remains an
incident even alongside a retry. Missing old slots or changing maintenance/
candidate generation cannot reset retained incidents. Workflow retry recovery
requires the exact same expectation identity except a higher attempt; an unrelated
successful run cannot recover it. HTTP uses the latest two distinct trusted
observations within a proposed 15-minute window, with a fresh current observation.
This is availability at one vantage, not platform root cause or delivery health.

`receiptView` is only a negative-vector model. Dispatch/uncertain state cannot be
reconciled by this evaluator, even by a later confirmation. External durable
journal ownership and authenticated human reconciliation are absent. Discord
transport confirmation always leaves human acknowledgment unknown. Config has no
policy-approval field. No verdict claims whole-MVP readiness.

Run from the repository root with Node 26.12.1:

```sh
pnpm --filter gq-support-worker exec vitest run --config tools/observer/vitest.config.ts
node worker/tools/observer/negative-controls.mjs
pnpm exec eslint worker/tools/observer --max-warnings=0
pnpm --filter gq-support-worker exec tsc -b
```

The isolated Vitest config uses one worker and no D1/global Worker setup.

Review corrections require strictly advancing HTTP timestamps and scope retained
HTTP samples to the current candidate and maintenance generation. A newly
observed unresolved Cron attempt retains its incident even when its slot is
older than a recovered coverage watermark; the watermark never moves backward.
Four new regression cases failed before correction and pass afterward. Privacy
fixtures now use runtime-generated scanner-compatible canaries.

The producer now implements the fixed readiness and authenticated aggregate wire
GETs. The earlier proposed normalized snapshot remains a fixture contract;
`protocol.ts` also adapts the actual version-1 DTO in
`src/observer-snapshot.ts`. Only that heartbeat decoder accepts 240 compact rows;
other queries keep 100. The producer supplies activation=null, coverage=unknown
and sticky partial. It therefore supports positive finite failure evidence but
cannot prove missing starts or recover an incident. No phase is remapped to ok.
The adapter has real endpoint-byte fixtures, including a full 240-cell D1 ring.
The fixed transport below is implemented; scheduler, journal and sender remain absent. See the latest
section of the observer design for exact schema, byte budget and custody order.

## Bounded private activation review (this slice)

`validateSnapshotReview(bytes, custody, now)` accepts at most 8 KiB of exact-schema
JSON. `custody` must come from a future **private authenticated review loader**,
not HTTP, manifest self-assertions, a caller boolean or Alchemy State. Its SHA-256
binds the exact bytes; its account/stage/candidate/deployment/version/generation
and vvaz-or-gmarques restricted-record digest must match. Digest integrity is
not authentication. No real attestation or loader exists in this slice. A loader must refuse
reissue/replay across processes; there is no durable replay journal here.

Pass the resulting process-local, single-use capability as the third argument to
`decodeBatch`. The actual v1 adapter attaches private `claims` to its snapshot
payload. Reusing a capability, serialized/copied capability, changed observation/time/
body digest, expired/stale evidence and mismatched pins cannot grant claims.
Only `Evaluation.public` is publishable; neither Batch nor State nor review inputs
are public. The manifest is private operational evidence, never a source fixture,
Worker prop/State, offline public candidate, or runtime endpoint update.

The accepted claim is `coherent_ring_read` over explicit whole-minute `[from,to)`
bounds (at most 60 minutes), intersecting review validity, requested read interval,
retention lower bound and completed minutes at generated time. `missing` means
records absent **at that read**, not proof Cron never executed or that writes
succeeded throughout the interval. A delayed heartbeat write can subsequently
appear. Sticky partial/overflow/lost unresolved evidence denies record coverage.
No watermark or latest tick is copied into a continuity proof.

`continuity` stays `unknown`, actual-wire activation stays null and evaluator
coverage stays unknown. Even an accepted private activation input cannot grant
missing-start incidents, healthy Cron, affirmative recovery, or notification
permission. `reviewed_disabled` means only reviewed candidate-bound disabled
notification expectation corroborated by wire route=disabled; drain=not_run and
contained are never mapped to ok. The proposed normalized fixtures retain their
separate historical recovery rules.

See the [design contract](../../../docs/research/external-incident-observer.md#bounded-activation-and-record-evidence-contract)
for schema, authority, exclusions, prerequisites and validation limits.


## Fixed HTTPS transport (this slice)

`observeHTTPS(privateInput, io)` connects the actual endpoint wire to the strict
snapshot decoder and evaluator. It requires an explicit trusted `ReviewedTarget`,
reviewed `Context`, independent observation integer, injected standard fetch and
UTC clock. There is no default fetch, env/profile lookup, enabled entry point,
CLI, workflow or scheduler. Omitting the dedicated stage-read token performs
readiness only. The token must be 64 lowercase hex characters, copied before any
await and sent only as snapshot Authorization. No other credential is accepted.
Only `result.public` is publishable (fixed finite enums and eight-class verdict,
≤2 KiB). `result.state` is private bounded in-process carry, never a public
artifact or RPC payload. Raw response/error/header/URL/token/review IDs are absent.

Exactly two sequential GET routes are possible: `/internal/observer/v1/readiness`
and `/internal/observer/v1/snapshot`, on the **same explicit reviewed origin**.
Target origin must be canonical `https://<exact-worker>.<subdomain>.workers.dev`,
with canonical DNS labels and no trailing slash, port (even 443), query, fragment,
userinfo, escapes, localhost/IP/private literal or custom domain. Target account,
stage, candidate and generation must agree with context before dispatch;
deployment/version must be exact UUID pins supplied independently. A host name
cannot establish stage from its spelling: authenticated stage-to-origin/Worker
binding, DNS resolution safety, Cloudflare account ownership and current single
version/deployment/candidate identity remain **independent target-attestation and
loader requirements**. A syntactically valid target or manifest/digest does not
authenticate those assertions. No loader, live attestation or approval boolean is
implemented. Caller-created test pins are synthetic, not live identity evidence.

Fetch uses GET, Accept JSON, Accept-Encoding:identity, redirect:error, credentials:omit, cache:no-store and
a per-run AbortSignal. No proxy/auth wrapper, cookies, query options, custom
paths/headers, provider calls, CRUD or mutations are supported. The trusted fetch
must honor these semantics and have no ambient auth/proxy/debug tracing. Only absent/identity Content-Encoding is accepted, so Content-Length describes
the bounded stream rather than compressed wire bytes. Final
Response.url must equal the exact requested URL, redirected/opaque redirects are
refused, and 200 needs JSON content type with no Set-Cookie. Non-200 bodies are
discarded/cancelled; 401/403 snapshot is denied, 4xx/5xx unavailable. Readiness
requires exactly `{version:1,check:"route_runtime",result:"available"}`. A bare
200, malformed body or redirected response is unknown, never route recovery.
DNS/TLS/HTTP/timeouts establish only observed unavailability at this vantage;
no platform cause, business delivery, App, Cron or Discord health is inferred.

A cooperative **10-second total two-read budget**, ≤64 KiB/read, ≤1024 stream
chunks/read (including empty chunks), ≤128 KiB total and two responses bound each
invocation. Content-Length is validated when present; streaming caps also apply
without it. Snapshot rows retain the real decoder's 240-cell cap. No retry occurs.
Failed/uncertain readiness ends dispatch; cancellation/deadline invalidates every
remaining request. Streams are cancelled on refusal; late responses are disposed.
Noncooperative fake I/O cannot be remotely cancelled by this library: it returns
bounded unavailable, requests cancellation and never dispatches again. The budget
is cooperative, not a preemption or remote-termination guarantee. Clock regressions
are refused. All mutable target/context/carry/private inputs are copied before awaits.

Snapshot acceptance means a complete authenticated-route response with valid actual
v1 schema, current stage/candidate/generation and generated time within the existing
proposed two-minute freshness window. It does **not** prove current deployment or
version from JSON, nor independently prove the caller's token custody/scope. `partial`
can be accepted as partial evidence while health/recovery stays unknown. Explicit
valid failed rows are preserved and prior incidents stay latched. Observation IDs
and completion times are recorded consistently; equal-time or cross-revision HTTP
pairs cannot manufacture confirmation. No complete Cron coverage is synthesized.

The optional #125 capability remains useful only with genuine independently supplied
private authenticated review custody. It is consumed **before any run validation**
when a snapshot is requested, including invalid target/token, failed readiness,
denial, timeout or malformed snapshot. Only accepted exact-byte/observation/time
bindings can produce `reviewed_external_input`; continuity stays unknown. This
library implements neither private credential delivery nor the authenticated review
loader. Reissuing manifest capabilities across processes still requires that loader
and a durable replay journal. A digest or caller boolean never replaces them.

Validation adds `node worker/tools/observer/transport-negative-controls.mjs` to the
commands above. Three broken copies (relaxed body cap, redirect following, token on
readiness) must fail actual assertions; the five existing controls remain required.
Local tests cover actual producer → injected HTTP → wire decoder → evaluator for
both stages and the full 240-cell D1 ring. They perform no TLS/live ownership test.

Remaining CODE: GitHub/Cloudflare wire adapters; authenticated target/review loader
and private delivery after an actual restricted record/authentication contract is
chosen; continuous storage witness and late-I/O fencing; scheduler; durable unresolved
journal and sender. Remaining LIVE: real manifests and independent identity/scope,
permissions, runner/storage/exclusions, credentials, approvals, Test F/drills and
receipt/human acknowledgment. Parent fallback policy remains pending. #20/#29 stay
open; no production enablement. Configured runtime 2026-10-17 remains unproven under
installed workerd tested at 2026-09-16; production compatibility was not lowered.
