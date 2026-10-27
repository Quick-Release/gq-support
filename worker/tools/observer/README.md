# Observer protocol, fixed HTTPS and authenticated review library

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
JSON. `custody` must come from a **private authenticated review loader**,
not HTTP, manifest self-assertions, a caller boolean or Alchemy State. Its SHA-256
binds the exact bytes; its account/stage/candidate/deployment/version/generation
and vvaz-or-gmarques restricted-record digest must match. Digest integrity is
not authentication. The authenticated read loader below verifies actor approval;
real target/activation attestation and durable reissue/replay refusal remain external.
There is no durable replay journal here.

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
authenticate those assertions. The loader below authenticates approval of private
bytes, without independently validating live attestation. Caller-created test pins
are synthetic, not live identity evidence.

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
library implements no private credential delivery. The authenticated handoff below
adds exact-record verification; reissuing capabilities across processes still needs
a durable replay journal. A digest or caller boolean never replaces them.

Validation adds `node worker/tools/observer/transport-negative-controls.mjs` to the
commands above. Three broken copies (relaxed body cap, redirect following, token on
readiness) must fail actual assertions; the five existing controls remain required.
Local tests cover actual producer → injected HTTP → wire decoder → evaluator for
both stages and the full 240-cell D1 ring. They perform no TLS/live ownership test.

Remaining CODE (updated by the loader section below): GitHub/Cloudflare telemetry
wire adapters; independently validated target attestation and private delivery;
continuous storage witness and late-I/O fencing; scheduler; durable unresolved
journal and sender. Remaining LIVE: real manifests and independent identity/scope,
permissions, runner/storage/exclusions, credentials, approvals, Test F/drills and
receipt/human acknowledgment. Parent fallback policy remains pending. #20/#29 stay
open; no production enablement. Configured runtime 2026-10-17 remains unproven under
installed workerd tested at 2026-09-16; production compatibility was not lowered.

## Authenticated digest-only review loader (this slice)

`createObserverReadSession(reviewedPolicy, privatePins, githubReadToken).observe(request, io)`
is a trusted-launcher library, with no enabled entry point. The existing
`observeHTTPS` trusted-input interface remains usable; a future approved flow must
use this authenticated handoff rather than treating its target argument as actor
proof. No real approval exists or is granted by this implementation.

This repository is **public**. The proposed exact #20 comment grammar is one ASCII
line, with no newline or other text: `approve-observer-read sha256:` followed by
exactly 64 lowercase hex characters. Only that digest may be published. No origin,
account/deployment/version/generation manifest, credential or private output belongs
in GitHub comments, PR summaries or artifacts. This is an implementation proposal
for review, not user approval, an SLO or a command for an agent to post.

The SHA-256 binds every byte of a privately delivered UTF-8 JSON manifest (≤32 KiB).
Its exact top-level keys are `schema` (1), `purpose` (`observer_reads`), `stage`,
`candidate` (exact 40-hex source head), `session`, `nonce` (independent fresh 64-hex
launcher identities), `readyAt`, `expiresAt` (UTC ms), `target`, `context`,
`observation` and `snapshotReview`. Target and context retain the #125/#126 exact
schemas and pins; `snapshotReview` is null or the exact private #125 JSON text.
The independently sealed launcher pins must match the bytes and digest. Proposed
session validity is at most five minutes; creation must be strictly after ready,
not future, and unedited. No public command needs the private pins.

The caller supplies one exact positive numeric comment ID, never a latest-comment
query. The loader reads only fixed HTTPS GitHub GET routes:

- `/repos/Quick-Release/gq-support/issues/comments/{id}` (twice per verification);
- `/users/{vvaz|gmarques}` for the authenticated comment author;
- `/repos/Quick-Release/gq-support/collaborators/{vvaz|gmarques}/permission`.

It requires the comment's exact `id`, `url`, `issue_url` (#20), `html_url`, raw
`body`, equal `created_at`/`updated_at` and author `user.id/login/type=User`.
Current user identity and current write/admin legacy permission must match the
same reviewed numeric identity (GitHub maps maintain to write). Author association,
manifest reviewer/digest/approved flags, local JSON and callbacks cannot authenticate
the actor. vvaz OR gmarques retain equal existing authority. As in the deployment
verifier, numeric IDs must be supplied in source-reviewed metadata. Live IDs are
unconfigured here; fixture IDs are explicitly synthetic and cannot be defaults.

The session consumes itself **before any** copy, parse, hash, mismatch, auth failure
or await. It copies all private bytes, pins, carry and I/O references before awaits.
An initial verification precedes review creation; the wrapped #126 fetch repeats
verification immediately before each Worker GET, with cancellation/window/clock
checks after all async verification and no await between the final check and
dispatch. A final verification withholds all result authority if the record is
revoked while Worker I/O is pending. Any verification failure is terminal even
when #126 catches a transport exception. No reusable boolean or fetch authority
escapes. Deletion, edit (including a revoke command), changed identity/permissions,
expiry, clock regression, malformed/unknown replies and cancellation fail closed.
An unrelated new comment cannot revoke this exact record: its author must edit or
delete the supplied record. There is no list, discovery, response-link fetch or
automatic replacement record.

Every GET refuses redirects, nonexact final URLs, cookies, pagination links,
compression and non-JSON/non-200 responses. Total cooperative budget is ten seconds
including verification and Worker reads, with ≤16 GitHub responses, ≤32 KiB/response,
≤1024 chunks/response and thus ≤512 KiB of GitHub bytes. No retries; refused and
late streams are cancelled. Injected standard fetch must honor these options and
have no ambient auth/proxy/tracing. Test fakes model HTTP only. Cancellation cannot
prove termination of noncooperative I/O. Revalidation is a fresh API observation,
not an atomic GitHub/Worker transaction; a change after the last observation cannot
be detected before it exists. Documented timestamps/current body do not prove hidden
edit history. No stale reusable grant is handed to #126.

GitHub Authorization is held only in this closure and reaches only those fixed
`api.github.com` routes; the separate snapshot token reaches only #126's snapshot
route, never GitHub or readiness. Identical declared tokens are refused. There is
no ambient gh/env/profile/token discovery, Worker prop, RPC, public error, log or
credential artifact. Only the existing bounded finite `result.public` is publishable;
`state`, manifest and review remain private in trusted launcher memory.

For optional #125 review, `reviewer` must equal the authenticated author and `record`
must be SHA-256 of the exact UTF-8 GitHub API comment URL. This binds the selected
record without publishing private data. Snapshot bytes/observation/time and all
candidate/generation/deployment/version pins still pass the original one-use checks.
The actor must independently retain and attest the target/activation evidence.
A digest-only author approval proves approval of private bytes, **not** Cloudflare
DNS/account/Worker/deployment ownership, actual activation or continuous storage.
No independently validated Cloudflare source is implemented. There is no blanket
manifest-authority=healthy rule, missing-record=nonexecution claim, private actual-wire
coverage, health, recovery, deployment, restore, broader credential grant or send
authority. Continuity and actual-wire coverage remain unknown; old failures stay pinned.

The one-shot is process-local and per session object, not durable replay protection.
Creating another session object or restarting cannot prove refusal; a durable
launcher-owned replay journal is prerequisite to an enabled workflow. No cache or
artifact persistence pretends to supply that proof. Real private delivery remains
parent-owned future work: an operator must retain the exact bytes and supporting
external attestation in an access-controlled private channel available only to the
trusted launcher and approving actor, independently supply reviewed numeric IDs and
fresh session pins, then explicitly identify the exact public digest record. No
private store, new service or expanded GitHub/Cloudflare grant is selected here.

API fields/permissions were checked against current official
[issue-comment documentation](https://docs.github.com/en/rest/issues/comments#get-an-issue-comment),
[user documentation](https://docs.github.com/en/rest/users/users#get-a-user) and
[repository permission documentation](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user).
The library retains the existing verifier's explicit 2022-11-28 API version.

Run the isolated suite and original eight negative controls above, plus
`node worker/tools/observer/review-negative-controls.mjs`. Two additional broken
copies must fail real assertions for missing verification and stale dispatch authority.
Remaining CODE after #127 alone: private delivery/replay custody (implemented by
the bounded wrapper below under explicit assumptions), independent target
attestation, notification uncertainty journal, continuous storage witness, other
provider adapters, scheduler and sender. Remaining LIVE: genuine records, identities, custody/permissions, runner
and external evidence, Test F/drills/receipt/human acknowledgment. Remaining POLICY:
parent fallback decision. #20/#29 remain open; nothing enables production. Configured
2026-10-17 runtime is still unproven under test date 2026-09-16.

### Bounded private launcher delivery and read replay custody (stacked on #127)

`private-launcher.ts` now composes `observePrivateFiles` → actual #127 authenticated
review loader → actual #126 transport. It is an importable trusted launcher library
only. No CLI, workflow, scheduler, notification, target discovery or source-store
integration is installed. The preceding statement that replay is process-local
continues to describe `createObserverReadSession` alone; this wrapper adds local
filesystem claims under the assumptions below. The supplied Standards0/Spec0 review
of #127 is context, not this change's independent review or LIVE evidence.

The parent supplies two absolute, canonical directory paths explicitly in memory,
never via env/gh/Cloudflare profiles/cache discovery. The launcher needs Linux,
`/proc/self/fd`, effective process UID custody, ordinary no-follow/exclusive-open
semantics and working directory fsync. Each path is traversed with real directory
file descriptors and `O_DIRECTORY|O_NOFOLLOW`; every ancestor must be root-owned or
launcher-UID-owned and have no group/other write permission. The real/effective UID must agree, and delivery/journal must be distinct directory inodes. Each final directory
must be launcher-UID-owned with exactly 0700 (no special bits). Symlink components,
relative/dot/repeated/trailing-slash paths and world-writable ancestors (including
ordinary `/tmp` and `/dev/shm`) are refused. The trusted parent chooses a protected
mount/path; this slice neither creates nor selects a production storage domain.

The parent must keep delivery and journal outside this public checkout and public artifacts. The one-shot delivery directory contains two deliberately supplied files:

| Name | Exact content | Maximum bytes |
| --- | --- | --- |
| `manifest.json` | Exact private #127 UTF-8 JSON manifest described above | 32768 |
| `credentials.json` | UTF-8 JSON with exactly `schema: 1`, `githubToken: string` (1–4096 printable ASCII characters), `snapshotToken: null` or dedicated stage 64-lowercase-hex string | 8192 |

Both must be nonempty regular files, UID-owned, mode exactly 0400, link count 1,
with no symlink. The adapter opens with `O_NOFOLLOW|O_NONBLOCK`, reads at most the
size bound plus one, checks descriptor metadata again (device/inode, size,
ctime/mtime, owner/mode/link count), and copies bytes synchronously before any
await. It closes the consumed descriptors before parsing or awaiting; deletion does not promise secure physical erasure. It attempts to unlink both fixed names even if opening/validating/reading
one fails. An unsafe directory is never traversed to remove files. A directory at
a file name cannot be unlinked: that invocation fails, and the operator must retain
custody of the rejected delivery. No retries or recursive cleanup are offered.

After consumption, the independently supplied valid session pins are claimed,
the delivery directory is fsynced, and only then are credentials/manifest decoded
and authenticated. Invalid UTF-8, BOM, JSON, extra keys, altered manifest digest,
operation pins, credential/auth/read failure all leave a claim spent. Wrong trusted
path/configuration or failure *before exclusive claim creation* may make recording
impossible: there is no dispatch or claim guarantee in that case, and no automatic
retry. Ambiguous storage outcomes require the parent to stop and preserve storage.

The public approval remains **only** `approve-observer-read sha256:<MANIFEST digest>`.
The manifest contains no credentials or credential hashes. Credentials have their
own file and never enter the digest approval, journal, returned state, arguments,
provider/RPC/child, logs, public errors or artifacts. The launcher alone holds them
in memory and passes them only through the existing fixed GitHub GET authentication
and #126 snapshot Authorization paths. Injected HTTP must be a trusted fetch without
ambient auth, proxy, tracing or request logging. The only publishable value is
`result.public`; #122 state remains private in-memory carry. JavaScript strings and
buffers cannot promise zeroization. Swap/core dumps, debugger access, backup copies,
privileged UID/root/kernel attacks and malicious trusted owner mutation are outside
this boundary. Descriptor checks detect ordinary unsafe files, not hostile root.

A tool-delivered secret file is **not assumed** to satisfy these rules or the
existing deployment's `/dev/shm/gq-protected/...` 0400 layout. The parent alone calls
`request_secret` when genuine delivery is needed. If its delivered mode/path is
incompatible, a trusted owner-only transfer process must first pin and validate the
explicit source descriptor, copy bounded bytes without printing them into exclusive
0400 destination files in a protected 0700 delivery directory, and consume the
source under its actual tool custody rules. No shell interpolation, chat echo,
public repository copy, or mode relaxation in this loader is acceptable. That
transfer and its tool-specific source/ancestor guarantees remain parent work;
this change implements consumption of the final exact format, not a tool adapter.

The separate journal is a caller-supplied **persistent local filesystem** directory.
It is never the delivery tmpfs, an Actions cache, artifact or concurrency group.
The filesystem type filter accepts Linux ext4, XFS, Btrfs and overlayfs only;
this is a refusal filter, not proof of persistent backing or fsync correctness.
Overlayfs in offline tests is CODE evidence only. The parent must independently
prove the actual mount/backing filesystem, durable file **and directory** fsync,
exclusive storage domain shared by every permitted launcher, custody over lifetime,
restart/host-loss behavior and backup/rollback integrity. Code cannot establish
runner-loss durability or all-runner exclusion. Hosted `ubuntu-latest` is ephemeral;
no persistent runner is selected, registered or proven here. No caller boolean can
supply that proof or enable this library.

Each session maps to the first byte of SHA-256 of its private 64-hex `session` ID,
as a two-hex-digit filename: **256 permanent slots maximum**. The claim uses
`O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, then bounded complete writes, descriptor
validation, file fsync and directory fsync, all before **any GitHub or Worker**
network dispatch. A concurrent process cannot create the same slot; collisions
between different sessions also block safely. Before reserving, the adapter scans
at most 256 entries with bounded reads and refuses any unexpected name, unsafe
file, partial/invalid record, unsupported filesystem or full journal. Concurrent
partial records may conservatively block unrelated sessions too. Blocking local
filesystem calls cannot be cancelled or deadline-bounded by a JS timer.

Each private entry is ≤2048 bytes, exact JSON keys `schema:1`,
`purpose:"observer_reads"`, `stage`, `candidate`, `session`, `nonce`, `readyAt`,
`expiresAt`, `sha256`, `status:"spent"`. These are the finite independently sealed
#127 identity/digest/timing pins, not a raw manifest, URL, credential, token hash or
HTTP response. Status deliberately never changes: success, auth failure, read
failure, process crash and ambiguous storage completion all remain spent. A changed
nonce/digest/stage/candidate cannot reopen an existing session slot. Expiry never
permits reassignment. Journal metadata is private and never a public artifact.

No delete, force-clear, stale-lock stealing, automatic retry or compaction exists.
Maximum record payload is 256 × 2048 bytes plus bounded names/filesystem metadata;
collisions can block well before capacity. A crash before file fsync may leave a
partial/empty claim, which blocks the journal; after file/directory fsync the spent
claim blocks restarted use. These statements assume the actual filesystem contract;
local process tests do not prove power-loss recovery. A crash before exclusive
creation cannot record a claim, but cannot dispatch either. Storage damage/rollback
must never be interpreted as permission to recreate a missing claim.

Safe retention/compaction needs a separately reviewed external frontier proving
that all related sessions/approvals/deliveries/launchers are permanently retired,
with reconciled ambiguous claims and rollback-safe exclusion. No such policy is
selected here. At collision, corruption or exhaustion, stop; preserve unreconciled
claims and obtain parent review. A fresh empty directory, renamed storage or backup
restore is not an automatic escape from the blocked state.

This is **read-session replay custody**, not an alert-send journal. No Discord
notification is sent, and no support/provider/restore owner is released. Provider
uncertainty, notification dispatch/receipt deduplication, continuous evidence carry,
recovery and restore safety require separate reviewed semantics. Genuine approval,
source-reviewed numeric vvaz OR gmarques identity, independent target/activation
attestation and fresh exact-record revalidation remain mandatory; manifest approval
cannot prove Cloudflare ownership, activation or continuous progress writes.
#125 pre-validation review consumption, #126 deadline stream disposal and #122
failure carry remain unchanged. Actual-wire continuity, health and incident recovery
remain unknown. Configured 2026-10-17 runtime remains unproven under the existing
2026-09-16 test runtime; #20/#29, receipt/human acknowledgment and parent fallback
policy remain open/unverified. No production enablement.

Minimal practical next step: parent reviews this exact schema and bounded retention
choice, supplies independently reviewed identity/target evidence and demonstrates
protected persistent storage custody offline before arranging genuine private file
transfer and a fresh digest-only approval. No source store/vendor or runner is
configured by this PR. Genuine delivery, target attestation and host-loss proof are
still required LIVE work, not caller flags.

Run `pnpm --filter gq-support-worker exec vitest run --config tools/observer/vitest.config.ts`
under Node 26.12.1 with maxWorkers 1, plus all ten negative controls above. The
new suite exercises actual file reads/unlinks/exclusive claims/fsync and independent
child processes contending/restarting in ephemeral home-directory test storage;
real fs operation seams inject open/write/fsync and descriptor-metadata failures
without requiring privileged chown or a host crash. Only fake HTTP is injected.

## Configured-date local validation update

The [configured-runtime gate](../../../docs/research/configured-runtime-validation.md)
now supplies local startup and behavior evidence at the unchanged **2026-10-17**
production date. Run `pnpm --filter gq-support-worker test:configured-runtime`
from the repo root with Node 26.12.1. Exact gate-only workerd `1.20261027.1`
executes the real Alchemy Worker build and local D1; the September-date negative
control is refused. Historical September fixture results remain distinct.
This does not provide live provider/TLS/account/DNS proof, parent fallback policy
or persistent custody/storage proof. Those remain pending independently, along
with operational approvals/Test F/drills/receipt/human acknowledgment and #20/#29.
No production enablement or global MVP-ready claim follows.

## Exact tracked GitHub Actions wire adapter (stacked on #129)

`github-actions.ts` exports `observeGitHubActions(input, io)`, a trusted launcher
library with **required injected HTTP**, explicit private source context and a
separate dedicated `actionsReadToken`. It is not wired into #127/#128's manifest,
credentials, approval purpose or launcher. Their existing `githubToken` is for
identity/comment/permission reads; **Actions:read is a future explicit prerequisite**
for this new purpose, never a silent scope increase. Caller-supplied context and
fake HTTP establish neither private custody nor approval. #127 approval grants no
deployment, notification, retry or other provider write authority.

The parent supplies `repositoryId`, a validated existing `Context` with <=20 exact
expectations, and exactly matching `tracked` entries. Each entry has a unique private
64-hex `identity`, the exact existing expectation and an independently approved
`ref`. Identity is a parent-owned join handle, not an API field or authentication
claim; existing private `State.workflowFailures` retains the full expectation tuple.
The context pins repo, allowlisted workflow filename, event, run ID/attempt/head,
stage/candidate/generation. Every outstanding expectation, including one older than
24 hours, is directly read. No discovery, list endpoint, pagination, age eviction,
automatic replacement, deployment API or generic GitHub client is added.

Fixed API origin: `https://api.github.com`, repo `Quick-Release/gq-support` only.
At most **23 sequential GETs**: one metadata read per distinct allowlisted workflow
(max 3), then one exact attempt read per expectation (max 20). Routes are only
`/repos/Quick-Release/gq-support/actions/workflows/{allowlisted_filename}` and
`/repos/Quick-Release/gq-support/actions/runs/{positive_run}/attempts/{positive_attempt}`.
Response links are compared but never followed. `pages:0` in normalized `Read`
means no list pagination; it does not conceal HTTP request cost. Metadata is cached
only within this invocation. There are no retries, cancel/rerun calls, scheduler,
CLI, sender, enabled workflow or added privileges.

Metadata's numeric `id`, exact `.github/workflows/{filename}` path and URL join
`workflow_id`/`workflow_url` from the actual run object. Supported workflow states
include disabled/deleted states: current enabledness cannot suppress a tracked
historical attempt. Unknown or malformed states still refuse. Run and head
repository numeric IDs/full names/API URLs must match independently supplied repo
identity and the fixed repo. Run ID, attempt, event, SHA and head branch must match.
CI is push/main; deploy is workflow_dispatch/main; release is workflow_dispatch/main
or push of the exact approved `plugin-v` version tag. These restrictions reflect
the checked-in workflows and are deliberately narrower than arbitrary dispatch.
Names, display titles, run path strings, jobs and actor text provide **no** stage,
pipeline identity or deployment-readiness authority. Stage/candidate come solely
from the independent expectation. Unknown/additional API fields are ignored only
after bounded decoding; documented GitHub object envelopes are decoded and joined,
never accepted as the old normalized fixture contract.

Timestamps must be real canonical UTC instants, nonfuture and ordered
created <= started <= updated (started required for in_progress/completed).
Status/conclusion consistency is enforced. Completed failure/timed_out/action_required
becomes finite `workflow_failure` evidence. Queue/in-progress/stall, waiting/unknown
states, cancellation, skipped, missing/deleted/denied, malformed or incomplete reads
cannot prove success. Exact complete success is **workflow evidence only**, never
service readiness, deployment receipt, runtime health or notification delivery.
Unrelated/older/equal-time success cannot recover retained failures. Only an
independently approved exact higher attempt with complete affirmative proof may
recover under the existing protocol's candidate/generation/time constraints.
Newly observed old failures also remain visible below a prior recovered watermark.

Limits: **10 seconds total**, additionally clipped by explicit `expiresAt` (at most
5 minutes from start); **64 KiB/response**, **512 KiB total**, **1024 chunks/response**.
Inputs and function references are copied/captured before awaits. Fixed headers:
Accept `application/vnd.github+json`, Accept-Encoding `identity`, User-Agent
`gq-support-observer`, X-GitHub-Api-Version `2026-03-10`, and the dedicated bearer.
GET, redirect:error, credentials:omit, cache:no-store; exact final URL, nonredirected
basic/cors/default response, JSON content type and status 200 required. Cookies,
compression, inconsistent content length and unexpected status/type are refused.
Streaming bounds, UTF-8/JSON validation and monotonic clock checks apply before
normalization. Abort/expiry/deadline, permission refusal, malformed identity or
uncertain I/O stop **all later reads**. Refused/pending/late streams are cancelled
without awaiting noncooperative disposal; ownership precedes the post-await clock
check, including the #126 deadline race. This bounds library waiting/bytes, not a
noncooperative injected implementation's memory or remote execution.

Successful normalized `Read[]` and `state` are **private**; only `result.public` is
publishable. Finite public coverage is scoped to the exact tracked set: complete
only after every exact read yields a valid decisive terminal result, partial when
some valid evidence survives an unresolved read, unknown when none does. Positive
failure evidence survives partial coverage and subsequent missing sources. The
real `decodeBatch`/`evaluate` retain failure identities, HTTP observation fencing,
unknown telemetry and all other source requirements. This adapter emits no HTTP,
Cloudflare, readiness or snapshot evidence. Public output contains no raw responses,
errors, URLs, headers, IDs, titles, topology, expectations, credentials or hashes.
No ambient gh/env/profile/App/Alchemy/deploy/SQL credential discovery occurs.

Minimum future entitlement: dedicated fine-grained repository **Actions:read** for
this repository, with no Actions write permission. No token is configured here.
The official endpoints also permit unauthenticated reads of public resources;
GitHub's unauthenticated primary limit is 60 requests/hour/IP, with secondary limits
also applicable. This library deliberately requires an explicit credential and does
not fall back to unauthenticated or ambient auth. See the
[official contract research](../../../docs/research/github-actions-tracked-runs.md)
for source links/current API version and exact offline proof limits.

Validation: the observer suite includes actual GitHub-shaped envelope/evaluator
vectors and runtime canaries; all ten existing controls remain required plus
`node worker/tools/observer/actions-negative-controls.mjs` (removed workflow/head
joins, cancellation-as-success, empty-as-success). Run with Node **26.12.1**,
`--config tools/observer/vitest.config.ts --maxWorkers=1`. No live entitlement,
lag/completeness, permissions, real repo/workflow identity or custody proof follows
from fake HTTP. The #129 configured-date gate's two passing cases and reviewed zero
findings remain separate local evidence; production date/runtime/CI pins are unchanged.

Remaining: untracked-run discovery, Cloudflare telemetry/deployment adapters,
continuous storage witness and durable failure carry, durable notification
journal/sender, persistent runner/storage/host-loss witness, genuine private LIVE
inputs/source approvals/permissions and target attestation, Test F/drills/receipt
and human acknowledgment. Parent fallback policy remains pending. #20/#29 stay open;
production remains disabled. The next smallest safe slice is an offline, separately
reviewed Actions-read purpose/credential handoff into the existing one-shot private
custody path, binding exact tracked refs/identities and source scope without enabling
execution or broadening the existing approval purpose. Discovery is later work.
