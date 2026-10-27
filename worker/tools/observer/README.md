# Offline observer protocol

Pure library only; no monitor entry point, network, scheduler, persistence or send.
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
transport's `vantage` classification. No HTTP transport exists, so TLS, redirect
refusal, endpoint allowlisting, streaming byte caps and private-host rejection
are **not implemented or tested**. Byte caps apply to already received byte arrays.
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
Network transport, scheduler, journal and sender remain absent. See the latest
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
