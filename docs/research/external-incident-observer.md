# External incident observation for MVP #20

Design, offline protocol, Cron producer, fixed endpoint and HTTPS library CODE, 2026-10-27. **External
observer disabled; no running external observer, sender, scheduler, credentials or live proof supplied.
#20 and #29 remain open.**
Recommendation: use GitHub Actions outside the support Worker for bounded HTTP
and workflow observations; add an explicit Cron progress contract before claiming
missing-work coverage. Keep Discord as the main route. Begin with read-only
verdicts; enable automated sending only after durable sender custody is proven.
No new vendor, monitoring platform, privileged proxy or Cloudflare resource is
needed for that first slice.

The current implemented endpoint contract is [documented below](#fixed-readiness-and-aggregate-wire-snapshot-this-code-slice).
It adds data-free route/runtime readiness and a disabled-by-default aggregate GET;
activation and continuous coverage remain unknown. Earlier sections retain the
design/producer history. This slice uses `t3/observer-progress-snapshot` based on
PR123 `4f3cffa096f091cda89872b04e5aa6946141c0cb`; source branches are untouched.

## Evidence boundary

This dedicated `t3/external-incident-observer` checkout was fast-forwarded to the
authoritative PR120 SHA `6f57bf1381d80fb42c7d30b76eef2f7f0321310d` before edits.
Local/remote `t3/outer-runtime-alerts` was absent. GitHub PR metadata and remote
refs instead identify `t3/outer-runtime-failures` at that SHA. Source branches
were untouched. PR120 remains unmerged; its reported Standards 0 / Spec 0 and 21
focused tests are supplied review context, not tests rerun here.

Read [domain](../../CONTEXT.md), ADRs [0013](../adr/0013-shared-cloudflare-resources-per-stage.md),
[0016](../adr/0016-restores-never-rewind-revocations-or-deliveries.md),
[0019](../adr/0019-uncertain-creates-require-review.md),
[integration readiness](mvp-integration-readiness.md),
[operational readiness](operational-readiness.md), [Discord runbook](../runbooks/discord-alerts.md),
[CI](../../.github/workflows/ci.yml), [deployment workflow](../../.github/workflows/deploy-worker.yml),
[protected entry](../../worker/deploy/planning-entry.ts),
[unset live configuration](../../worker/deploy/reviewed-planner-config.ts),
[runtime](../../worker/src/worker.ts), [phases](../../worker/src/scheduled.ts),
[maintenance](../../worker/src/maintenance.ts) and [alert transport](../../worker/src/discord-alerts.ts).
Internal failure capture is wired after usable bindings; platform/pre-binding
failures, absent ticks, outside workflow failures and receipt remain external gaps.
A returned tick is insufficient evidence: phases catch failures/timeouts, and
maintenance can deny work. The nominal 57-second phase sum is cooperative.

At the original design slice, no dependencies were installed. To check the exact locked
contracts without running package scripts, the published `alchemy@2.0.0-beta.83`
and `@cloudflare/workers-types@5.20261015.1` tarballs were extracted only in `/tmp`.
Alchemy `src/Cloudflare/Workers/CronEventSource.ts:202–247` passes a
`ScheduledController` to the callback, then applies `Effect.ignoreCause`;
workers-types `index.d.ts:2648` declares `scheduledTime`, `cron`, `noRetry`.
The callback at that original slice discarded the controller; the internal
producer below now retains it. These were package-source facts,
not installed-runtime or deployment proof. [Published Alchemy source](https://www.npmjs.com/package/alchemy/v/2.0.0-beta.83),
[published type package](https://www.npmjs.com/package/@cloudflare/workers-types/v/5.20261015.1).

## Requirements and usable sources

`NOW` means adapters can be implemented/tested without production changes;
`CODE` requires a new heartbeat/readiness contract; `LIVE` means scoped configuration
and evidence are still required; `POLICY` is a human operational decision.
All stages use Tipme account `8f38791a8c37b182239af2a385ab3c31`. Separately reviewed
stage manifests must supply actual Worker name, HTTPS origin, candidate/deployment
identity and activation time; no names, zone IDs, database IDs or run IDs are
invented here. Reject cross-account/stage/revision evidence. REST Cloudflare paths
below are relative to `https://api.cloudflare.com/client/v4`.

| Signal / level | Exact source, scope and time | Reliability, normalization and missing evidence |
| --- | --- | --- |
| Total route, platform 5xx, pre-binding failure: NOW + LIVE | External Actions HTTPS GET to reviewed stage origin, fixed `/internal/observer/v1/readiness` after CODE below. Before that, optional GET of fixed `/__gq_observer_probe__`, expecting the existing exact 404 `{"code":"not_found"}` contract. No auth/body/query, redirect, cookie or support endpoint; runner records UTC start/end and status class. | Current unknown-path request still enters maintenance admission and binding resolution; it can write admission bookkeeping, although it never invokes support CRUD. It is only reachability evidence. If strictly zero runtime writes are required, wait for CODE readiness. DNS/TLS/timeout/5xx is observed unavailability at this vantage point, not proven platform root cause. A 404 or 200 cannot prove GitHub delivery, Cron, App validity or Discord. Never save response body/headers/URL. |
| Worker errors corroboration: NOW + LIVE | `POST /graphql`, `viewer.accounts(filter:{accountTag: reviewed account})`, `workersInvocationsAdaptive(limit:100, filter:{scriptName:reviewed Worker,datetime_geq:start,datetime_leq:end})`; request only `dimensions{datetime scriptName status}` and `sum{requests errors}`. Deduplicate overlapping boundary buckets. | Official [query](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) provides these fields, not complete invocation records or a guaranteed HTTP-5xx breakdown. [Adaptive sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/) applies. Positive errors corroborate; zero/empty never establishes health or Cron absence. If row limit/pagination or GraphQL errors prevent complete query processing, label partial. Effective retention, ingestion lag, dataset entitlement and sampling remain LIVE unknowns; the [metrics page](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#metrics-retention) describes historical availability, not this query's completeness. |
| Cron configured: NOW + LIVE | `GET /accounts/{account}/workers/scripts/{reviewed Worker}/schedules`; require exact `* * * * *`, record fetch time and returned schedule metadata. | [Schedules API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/) returns configuration, **not executions**. Missing expected configuration is configuration drift only after successful authenticated, schema-valid response. 401/403/empty envelope/timeout is unavailable. No invocation start/completion inferred. |
| Cron start vs terminal work: CODE + LIVE | New bounded progress snapshot described below, keyed by stage, candidate, scheduled UTC minute and attempt; separate observed start, terminal result and completed phases. External observer compares expected minutes after activation/maintenance exclusions. | No documented complete start/completion API established here. [Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) distinguishes scheduled time from execution time; Past Events status reflects promise failure, not successful business phases. Current caught failures and Alchemy ignoring causes further prevent treating platform “success” as completion. Missing heartbeat means **missing evidence**, not proof Cron never ran. |
| Logs / Cron Events: optional LIVE investigation | `POST /accounts/{account}/workers/observability/telemetry/query`, explicit dataset + reviewed Worker equality + event type + fixed failure class, UTC millisecond `timeframe:{from,to}`. Invocation selector is `$cloudflare.$metadata.type = cf-worker-event`. Exact service/event keys and dataset must first be discovered and reviewed; refuse to query all datasets. | [Query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/) currently requires **Workers Observability Write**. Exclude from default read-only observer rather than silently grant it. Filter keys are discovery-dependent, so this is not a runnable query manifest. [Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) can be sampled/truncated and retained for a limited period; effective settings/lag are unverified. [Cron Events](https://developers.cloudflare.com/workers/configuration/cron-triggers/#view-past-events) is a dashboard investigation surface, not a complete machine-readable completion contract. No raw logs exported. |
| Deployment / workflow failure: NOW + LIVE | `GET https://api.github.com/repos/Quick-Release/gq-support/actions/workflows/{file}/runs?branch=main&event={expected event}&created={bounded UTC range}&per_page=100`; allowlist `deploy-worker.yml` (`workflow_dispatch`), `ci.yml` (`push`), `release-plugin.yml` (`workflow_dispatch` on main). Also query `release-plugin.yml` with `event=push` and **without** `branch=main`, then accept only privately expected `plugin-v*` tag/head identities; the actual workflow supports tag pushes. Use run ID + `run_attempt`, `head_sha`, `created_at`, `run_started_at`, `updated_at`, status/conclusion; `GET .../actions/runs/{run_id}/jobs?filter=all&per_page=100` for bounded job/attempt evidence. | [Runs API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow), [jobs API](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run). Terminal failure/timed_out/action_required are incidents; cancellation/skipped require expectation reconciliation, never health. Run `updated_at` is not exact deployment failure time. Do not infer stage from display text: join deploy run to private approved request/run/stage/candidate record; unmatched means stage unknown. Use a maximum 24-hour discovery window and fetch each outstanding run directly via `GET .../actions/runs/{run_id}` even when created earlier, so old reruns/waits cannot fall out of observation. No deploy is expected periodically. A successful workflow is not live deployment/readiness proof. Truncated pages, missing tracked attempts and permission failures are unknown. |
| Active deployment corroboration: NOW + LIVE | `GET /accounts/{account}/workers/scripts/{Worker}/deployments`; compare latest deployment ID, versions and creation time with approved stage candidate record, fetched at observer time. | [Deployments API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/) lists active deployments, not failed attempts before a deployment exists. Missing/mismatched identity is drift/unknown, never auto-approve or auto-redeploy. Retention and propagation lag unverified. |
| Alert-route state and Discord receipt: CODE + LIVE | New snapshot exposes only finite local route state (`disabled`, `ready`, `blocked_unknown`, `rate_limited`) and last attempt/confirmed time. External sender records its own durable attempt. Future authorized `POST https://discord.com/api/webhooks/{private id}/{private token}?wait=true`, no redirects. | Local ready is configuration/state evidence only. [Discord execute](https://docs.discord.com/developers/resources/webhook#execute-webhook) server confirmation is separate from human acknowledgment. No secret URL exists here; no test is sent. Timeout/5xx/unknown response leaves receipt uncertain; broken Discord cannot announce its outage through Discord. Transport confirmation of an external message does not prove the Worker's sender works. |
| Operator receipt and observer absence: POLICY + LIVE | Explicit acknowledgment by vvaz **or** gmarques in existing restricted incident record, bound to incident generation and UTC time. GitHub observer run metadata can show last started/completed run only when independently inspected. | No ack API, owner deadline, escalation destination or fallback is approved. GitHub failed run is independent visible evidence; notification settings and human receipt are unverified. A missing observer cannot send its own alarm; another check in the same scheduler adds no independent scheduling guarantee. |

## Smallest implementation and custody

One reviewed observer entry in this repository, independently executed by Actions,
with separate jobs/manifests/credentials for `staging` and `prod`. Start as manual,
read-only validation with sending and scheduling explicitly off. Later propose UTC
`2-59/5 * * * *` to avoid the hourly boundary. GitHub documents a minimum five-minute
interval, default-branch execution, delays/dropped jobs and public-repository
inactivity disablement; this is **best-effort observation, no maximum detection
delay**. A delayed run evaluates wall-clock evidence age and reports the uncovered
interval, rather than replaying every missed poll. [Schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

```text
Actions outside Worker
  bounded HTTP + GitHub reads (+ optional account analytics/metadata)
  -> strict decoder -> finite verdict + coverage/unknown reasons
  -> sanitized failed run / private evidence
  -> [disabled until durable custody] one bounded Discord attempt
Worker progress snapshot -> evidence input only; never its own absence detector
```

Use `permissions: {contents: read, actions: read}` and checkout only a reviewed
immutable default-branch observer revision with persisted Git credentials off.
Never check out the triggering run's code, consume PR artifacts/caches as trusted
inputs, interpolate titles into shell, or expose secrets in PR runs. A future
`workflow_run` listener is optional; if added, it only reads trusted run metadata,
verifies repository/workflow/event/head against the private expectation record,
and executes the pinned observer. It never inherits approval to deploy or reads
untrusted run artifacts. GitHub warns privileged `workflow_run` code can access
secrets even after an unprivileged workflow. [Event security](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[secure use](https://docs.github.com/en/actions/reference/security/secure-use).

Default credentials: this repository's short-lived Actions read token; a distinct
per-stage snapshot-read capability authorizing **only** the fixed aggregate GET,
when implemented. No App key, installation credential, broad Alchemy state bearer,
SupportDB/ledger SQL token, deployment token or ambient CF profile. Optional
analytics needs a separately delivered Tipme `Account Analytics:Read` token;
this is account-scoped telemetry, not a script-only permission merely because a
query filters a script. Separate stage credentials do not alone establish stage
isolation. Omit that adapter unless its actual scope is acceptable.
[Analytics token](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/).
For schedules/deployments prefer the documented Individual Workers Metadata
Read-Only permission bound to the reviewed Worker **only after live scope proof**;
do not substitute an account-wide script read grant silently. See the linked API
permission lists in the matrix. No token is created or requested here.

Keep secret delivery in trusted private parent custody using existing one-shot
owner-only file/session conventions; no secrets in workflow inputs, command lines,
URLs in diagnostics, summaries, artifacts or public manifests. A later GitHub
Environment secret setup is a separate reviewed custody change, not assumed from
the existing deployment's private-file model. Do not forward the deployment
session wholesale. Stage-read capability and Discord send URL are separate.
Preserve the approved Worker Logs-on/traces-off exception while Discord is enabled,
and credential-removal-before-traces restoration when disabled. The Node sender
must also disable HTTP debugging/tracing and discard raw provider errors/bodies.

### Durable send ownership is a real prerequisite

Recommendation: reuse the **future verified protected runner's private durable
journal**, separate per stage, outside the support Worker and its restore domain.
This avoids granting Actions broad D1 write access or adding a privileged API
proxy. The actual workflow uses `ubuntu-latest`; neither persistent storage nor
a protected runner is established. Therefore this is a **required runner/storage
capability**, not an implementation available now. If existing runner custody
cannot provide it, keep sending disabled and return with a narrowly scoped storage
proposal; do not silently add a Cloudflare resource/provider or broaden grants.

The journal needs exclusive ownership across every runner/restart, atomic
compare/update, fsync of file and directory before dispatch, and durable reads
after runner loss. A local `flock` plus rename is sufficient only after proving
one persistent filesystem and no other writers; hosted-runner workspace, Actions
cache/artifact, job concurrency and “latest run succeeded” are not that proof.
GitHub concurrency controls overlap/queuing, not send-receipt atomicity.
[Concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency).
D1 is transactional storage but its [SQL query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
is not a table-limited incident capability. Do not hand an observer a general SQL
credential to existing private support databases to solve deduplication.

Proposed finite keys: stage × eight classes (`http_unavailable`, `worker_errors`,
`cron_start_missing`, `cron_incomplete`, `workflow_failure`, `deployment_drift`,
`telemetry_unavailable`, `alert_route_unavailable`). Keep one active generation per
key, saturating count at 999999, first/last event and observation times, latest
candidate, last covered watermark, cooldown and receipt state. Bound the approved
run expectation list to 20 outstanding runs per stage; overflow becomes unknown,
never eviction of unresolved ownership. Quiet terminal history expires after
seven days; retain unresolved receipt latches until explicit reconciliation.
No per-Client/Reporter/request/URL dimensions.

Before sending, durably transition `pending -> dispatching` with generation and
attempt. A crash while dispatching becomes `blocked_unknown`, even if no POST
actually reached Discord. Never expire/reassign that send automatically. Confirmed
200 advances only that generation to `transport_confirmed`; an outdated response
cannot close a newer incident. Apply the existing bounded transport rules:
one attempt/minute/stage, only valid explicit 429 permits bounded retry (three
attempts maximum, honor server delays); timeout/5xx/redirect/unsupported responses
latch unknown. No automatic resend, reminder or takeover on an uncertain receipt.
Recovery requires new affirmative source evidence; never silence, expiry or an
empty query. Send at most one recovery for an active generation, subject to the
same receipt ownership. vvaz or gmarques may reconcile a route; neither is primary,
and no action clears support/restore/provider ownership.

## Bounded contracts and proposed windows

The original design proposed a fixed authenticated aggregate snapshot
`GET /internal/observer/v1/snapshot` (read-only, no support records) and a data-free
readiness GET **before** support admission. Readiness may check binding availability
without listing/creating support data; its success claims only its listed checks.
Snapshot reads existing stage-local state; no new side-effecting probe or hidden
GitHub/Discord test. These endpoints are now implemented by the CODE slice below;
readiness checks only route/runtime execution, and activation/coverage stay unknown.

Record a bounded 60-minute ring of scheduled slots: scheduled UTC minute from the
controller, attempt ordinal (at most four retained attempts/slot, overflow explicitly partial), actual start time, terminal time and finite
phase outcomes (`ok`, `failed`, `timed_out`, `contained`, `not_run`). Record start
before work, terminal **after** phase outcomes settle, and notification-drain result
separately. Do not record success in an unconditional finalizer. Existing caught
phase failures/denials need explicit result plumbing before a completion marker
is trustworthy; preserve current deadlines, ordering and restore admissions.
Snapshot has generated-at time, stage/candidate, activation/maintenance generation,
ring coverage start/end and storage-read outcome. Missing bindings/write failure
can prevent heartbeat evidence and must remain unknown. A heartbeat producer
cannot prove its own absence; Actions owns deadline evaluation. [Controller semantics](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/).

Proposals for review, **not approved SLOs**:

| Observation | Proposed threshold / reason | Required interpretation |
| --- | --- | --- |
| HTTP | One GET/run, 10s total budget; incident after two failures on separate runs | Reduces one-off noise; isolated 5xx still recorded. Two successes can establish route recovery, not delivery recovery. No extra mutating retry. |
| Cron starts | At observer UTC minute T, evaluate the ten slots in [T−12 minutes, T−2 minutes), allowing 2 minutes settling | No starts in those ten expected slots means `cron_start_missing` evidence incident only with fresh, valid snapshot covering those slots. Unavailable snapshot is telemetry unavailable. Delay can exceed 10 minutes: no notification deadline promised. |
| Cron completion | Start exists, terminal absent after 3 minutes; any explicit failed/timed_out phase is failure | 3 minutes exceeds nominal cooperative 57s plus persistence/drain allowances; it is an investigation threshold, not cancellation or proof work stopped. Latest success cannot erase an earlier unresolved slot. |
| Analytics | Overlapping last 15 minutes ending 2 minutes before observer time | Settling allowance is a proposal requiring measured lag. Positive error count is corroboration; zero is no reported errors in sampled data. No percentage SLO or zero-traffic health claim. |
| Workflows/deploy | Failure immediately when observed; tracked nonterminal run older than 30 minutes becomes stalled/unknown | Queue/reviewer waits are distinguished from job failures. 30 minutes is a review threshold, not apply timeout; retained apply owners never expire. |
| Route/observer | Blocked route immediately when observed; last observer completion older than 20 minutes is a review gap when independently checked | No Discord self-outage alert or independent scheduler claimed. Disabled/maintenance windows remain explicit exclusions, never healthy ticks. |

Input budget proposal: per stage/run at most 64 KiB per response, 1 MiB total,
100 aggregate rows/query, 3 GitHub pages/workflow and 20 tracked job lookups;
stop at budget and label coverage partial. Bound all streaming reads even without
Content-Length. HTTPS allowlists, redirects refused, no arbitrary user URLs.
Only fixed stage/class/outcome enums, reviewed SHA, integer UTC times/durations,
counts and coverage flags reach the evaluator; discard raw inputs after decoding.
Public output is at most 2 KiB of stage/class/count/times/verdict, no IDs/links to
private topology, message content, raw URLs/headers/errors, support data or hashes
of personal data. Discord payload uses the same finite fields and no mentions.

Required decoder/evaluator vectors for the next offline slice:

| Fixture / negative control | Required verdict |
| --- | --- |
| Missing/null/malformed/wrong-stage/wrong-account/wrong-candidate; 401/403; bad TLS | unavailable or invalid; never normal or missing Cron proof |
| Valid empty analytics vs empty heartbeat envelope | no reported sampled errors vs invalid/missing evidence; neither healthy |
| GraphQL HTTP 200 with errors, partial pages, truncated response, unknown sampling/lag | partial/unknown coverage; preserve independently valid positive failure evidence |
| Fresh ring containing expected slot with start only; explicit timeout/containment | incomplete after grace; failed/contained is not success |
| Valid ring covering ten expected slots with no starts | missing start evidence, not proven non-execution |
| Late/stale/future/out-of-order/duplicate evidence | reject impossible times, do not regress watermarks or double count; old success cannot recover newer failure |
| HTTP readiness 200 while tracked GitHub deploy fails; Discord 200 without human ack | route available + independent workflow failure; transport confirmed + acknowledgment unknown |
| Crash before/after dispatch, lost response, concurrent sender, recovery racing failure | retain durable uncertain ownership; no automatic resend/recovery/reset |
| Oversized body/row count, injected PII/unknown fields, redirect to private host | bounded rejection without logging payload or following redirect |

The offline protocol slice below exercises these vectors with fake provenance;
transport and durable custody remain unwired. It is not a functional monitor.
No Worker entry stub or enabled workflow is included.

## Implemented offline slice — 2026-10-27

Stack base verified from PR121 metadata: actual head ref
`t3/external-incident-observer`, pinned `e961cfefae6dd1452b20b3e28b63dda3564b371f`.
The dedicated implementation branch is `t3/offline-observer-evaluator`; no source
branch rewrite or other checkout was used.

[Protocol and exact limits](../../worker/tools/observer/README.md),
[pure evaluator/decoders](../../worker/tools/observer/protocol.ts),
[selected GraphQL projection](../../worker/tools/observer/analytics-wire.ts) and
[fixture tests](../../worker/tools/observer/protocol.test.ts) implement strict
normalized input decoding and the eight fixed classes. Trusted private context
pins account/stage/candidate/activation/generation and exact workflow expectations;
response fields cannot authenticate themselves. Public output is at most 2 KiB
and excludes private identities, topology, raw content and error causes.

At the offline-only slice, snapshot/readiness wire contracts were **proposed and unwired**;
the current CODE section below supersedes that status. The internal
Cron producer CODE below now records local progress; it supplies no external read
capability or activation/coverage proof.
Workflow/deployment JSON is explicitly a normalized projection, not a fabricated
complete provider response. Only the selected documented analytics envelope has a
wire projection; its output still requires independently trusted provenance.
It never infers complete coverage from HTTP 200 or absent GraphQL errors. No new
API facts or live observations are claimed. All deadlines remain proposals,
including an explicit 15-minute HTTP pair window in this offline slice.

The bounded in-memory carry preserves failure watermarks and unresolved Cron/run
identities; it supplies no custody or receipt proof. Missing/unknown input cannot
recover incidents. Old successful attempts cannot erase failed attempts. A fresh
complete successful retry can resolve a retained attempt only under the stricter
rules in the module README. Sampled zero analytics cannot resolve prior errors;
no affirmative analytics recovery contract exists yet. A negative receipt model
keeps uncertain dispatch blocked and human acknowledgment unknown; no journal,
send, reset or authenticated reconciliation implementation exists.

Validation: **77 protocol tests** pass under Node **26.12.1**, Vitest **5.0.5**,
`maxWorkers: 1`, isolated from D1/global Worker setup. Five fixed broken variants
are detected by real assertion failures: empty-as-healthy, completion-from-start,
stale recovery, duplicate failure count and unknown-receipt reset. The first real
red-to-green regression caught older snapshot observations clearing a newer
failure. Affected ESLint and Worker TypeScript checks pass; all 114 CI-script
policy tests, runtime/workflow policy, redacted secret scans and whitespace checks
pass. These are offline
fixtures and hygiene checks, not live source/transport or operational proof.
HTTP/TLS/redirect/private-host enforcement and streaming byte limits are unwired;
protocol byte limits apply before JSON decoding of supplied byte arrays.

The internal producer slice below now preserves controller UTC minute, start,
settled phase/drain results, attempts, overflow and maintenance generations.
The next CODE slice is a separately scoped authenticated aggregate reader and
data-free readiness before support admission, with independently verified
activation and an explicit partial/coverage contract. The 100-row consumer must
not silently truncate the 240-row producer. Restore/provider ownership remains
outside observation authority.
Only after that come trusted wire adapters, LIVE identity/scope/schema/lag/sampling
proof and separately authorized drills. Durable journal/runner survival and human
receipt proof remain separate prerequisites before sending or scheduling.

The parent choice between temporary GitHub failed-run visibility and independent
fallback remains **pending**. Neither is approved by config, tests or this code.
No operational authority is added; #20 and #29 remain open.

## Subsequent implementation and live acceptance checklist

1. **Offline observer protocol (implemented above; no policy/credentials needed):** strict decoders,
   expectation joins and finite evaluator in an isolated tool, fake clock/HTTP only.
   Pass the vectors above and leak canaries; negative controls must fail on
   empty-as-healthy, completion-from-start, stale recovery and unknown resend.
   No production entry or enabled scheduler. Review thresholds before enabling.
2. **CODE heartbeat/readiness:** bounded ring and snapshot-read capability scoped
   separately per stage; explicit phase results and maintenance exclusions. Tests
   exercise actual scheduled callback, failed/denied phases, binding failure,
   concurrent/out-of-order slots and read-only/no-support-data probe. Independently
   reading progress must never release retained restore/provider admissions.
3. **Custody/state integration, still disabled:** prove protected runner identity,
   exclusive persistent journal/crash recovery and per-stage separation. If not
   possible under current grants, publish the specific missing storage/grant
   requirement before designing/provisioning anything. Read credentials authorize
   only chosen sources; do not inherit planning/App/deployment credentials. Parent
   privately supplies capabilities and destination only for authorized live work.
4. **LIVE source proof (separately authorized):** record actual account/stage/Worker
   and endpoint identity; token resource scope/expiry; authenticated permission
   failures; finite response schema; measured lag, sampling, retention and access.
   Bind expected deployment run/attempt/candidate/stage privately. Verify configured
   Cron separately from start and phase completion. Prove journal survives runner
   loss and duplicate dispatch refusal. No account/profile discovery is implied.
5. **Authorized staging drills, exact candidate/targets/window/restoration owner:**
   synthetic readiness failure without support CRUD, withheld start/terminal
   heartbeat, failed workflow before apply, stale/partial/denied telemetry, runner
   cancellation, Discord explicit rejection/uncertain receipt and recovery. First
   prove with fake transport. Real Discord send requires later authorization,
   private destination and access/retention review; record server confirmation and
   a separate vvaz-or-gmarques human acknowledgment. No production disruption or
   deployment/restore drill is authorized by this checklist.
6. **Production enablement:** approved dedup/receipt policy, independent-outage
   coverage decision below, candidate-specific release approval and measured pilot
   evidence. Managed Composer/tested-ZIP upgrades remain MVP policy. Live manifests,
   protected runner/reviewers, writer exclusion, private credentials, post-plan
   candidate approval, remote RPC, Test F and recovery drills remain unverified;
   this docs PR closes none of them or #20/#29.

## Minimal user decision frontier — parent review only

Proceed with offline CODE without requesting secrets or permission. Technical
schema, scope and persistence proofs are engineering work, not questions to shift
to the user. Preserve vvaz **or** gmarques authority with no hierarchy.

To claim timely notification during Discord failure or Actions scheduler loss,
an independently observed destination/owner coverage arrangement is unavoidable:
the failed component cannot establish its own timely receipt. Recommend accepting
GitHub failed-run visibility as a **temporary manual investigation surface**, while
leaving this automatic-outage/receipt gate open. It is not an approved fallback:
GitHub notification delivery, recipient access and monitoring frequency are
unverified, and no run may exist when scheduling fails. After reviewing this
proposal, the parent may ask only whether that limitation is acceptable for the
pilot, or which existing independent destination/coverage and acknowledgment
window to approve. Do not invent one, enroll a vendor, or send a test now.

## Original design publication validation

Docs-only diff against pinned PR120: 62 local documentation links/anchors checked;
`git diff --check`, `scripts/ci/gitleaks.sh dir docs`, workflow policy and runtime
matrix policy passed. Affected-suite classification is empty for these Markdown
paths; JS lint/types and Worker tests are not affected and were not rerun. No
protocol executable/tests were added in that original docs-only publication.
These checks establish documentation hygiene,
not live observation, alert delivery or readiness. Current GitHub issue metadata
confirms #20 and #29 OPEN; hosted PR checks/reviews remain uninspected.

## Internal Cron producer CODE slice (2026-10-27)

This dedicated `t3/cron-progress-producer` checkout started at PR122 head
`66a7c74c5236b538091f0068bb1ee6d758ebe6e8`; source branches were untouched.
Frozen dependencies were installed for this implementation.
The internal producer is now wired to the actual installed Alchemy
`CronEventSource` callback in `worker/src/worker.ts`. It keeps the controller's
UTC `scheduledTime` separately from invocation start (`Date.now()`); retries
allocate distinct attempts rather than replace a finished tick. This establishes
local invocation observations only. Cron cannot observe its own absence, and a
platform-successful callback does not prove business success.

`SupportLedger` migration `0005_cron_progress.sql` adds aggregate tables only;
it changes no historical migration, database identity, retention, restore epoch,
maintenance admission or provider ownership. Remote migration applicability is
**unknown**: native offline tests use explicit synthetic prior histories;
ledger 0002 must already be committed and is never rewritten or converted.
Progress tables are outside `ledger_entry` replay/mirroring and outside
`maintenance_operation` drain. Their writes never unblock recovery or authorize
work. The producer stores only stage, exact reviewed 40-hex source candidate,
maintenance generation, scheduled minute, attempt 1–4, UTC start/terminal and
finite phase/terminal enums. No Client, Reporter, request, repository, provider
identity, URL, payload or error cause is copied.

Delivery, cleanup, refresh and sweep preserve their order, original deadlines,
caught errors, HTTP contracts and cancellation. A local finite failure signal
also covers isolated item failures/retries; it carries no error data. `ok`
means that the bounded local pass returned without an observed failure, not
that every durable intent or uncertain remote write was resolved. Maintenance
refusal is `contained`, timeout is `timed_out`, failure is `failed`, and work
never reached is `not_run`. Notification drain reports independently. Disabled
notifications are `not_run`; denied/rate-limited drain is `contained`. Terminal
`settled` describes local settlement, including caught phase failures; consumers
must inspect every phase. Outer failure/interruption uses `failed`/`interrupted`.
Terminal is written only after nested work and finalizers settle. The nominal
57-second support budget is cooperative: noncooperative finalizers and D1 or
notification cleanup can exceed it. No 57-second completion is fabricated.

Each progress operation has a 100ms cooperative observation deadline: start,
four support phase updates, drain update, terminal (at most 700ms total added
cooperative overhead). A hung/failed write emits only fixed
`Support Cron progress unavailable`; support continues without a recovery
obstruction. A timed-out D1 request may settle late. Updates compare the full
immutable owner, require the current maintenance generation and an unfinished
row in the retained window; phase values only move from `not_run` to a finite
result. They cannot rewind a terminal or newer owner. An interrupted invocation
never resumes support work to obtain evidence. A stale generation cannot
terminalize its previous work; its old incomplete row remains evidence.

The ring has exactly 240 addressable cells: 60 scheduled minutes × four
attempts. Concurrent allocations are serialized by an atomic D1 batch. A fifth
attempt or a too-old invocation is rejected and latches `partial`. Eviction of
an unfinished or nonhealthy row also latches `partial` before reuse. Old rows
can remain physically present until reused, so the fixed row bound is stronger
than a TTL claim. The marker is deliberately sticky: no later successful tick
proves that lost unresolved evidence was reconciled. Late failures within the
ring retain their original attempt; finished rows are immutable.

Protected retained planning explicitly supplies the reviewed source head to the
shared Worker declaration through a declaration-only context service (no
ambient Config/environment lookup), as public `plain_text` bindings
`SUPPORT_RELEASE_CANDIDATE` and `SUPPORT_RELEASE_STAGE`. The actual native upload
broker requires exactly one of each with the retained head/stage, in both
Discord modes. It does not accept a custody secret or ambient runtime setting
as release authority. Unprotected declarations without this explicit identity
produce `unknown` and the runtime skips progress, while support still runs.
The binding is release identity, **not** activation proof. Activation time and
snapshot coverage remain **unknown/unimplemented**.

### Producer slice follow-up contract (historical; implemented conservatively below)

No endpoint, new secret, external reader, broker resource, workflow, scheduler,
sender, journal or observer enablement is supplied here. A next slice must
provide an independently authenticated read-only capability limited to the two
aggregate progress tables, never the Worker's broad SupportLedger SQL binding
or admin/restore capability. It must bind account/stage/candidate, independently
verify activation and maintenance generation, and return a bounded coherent
projection of scheduled minute/attempt/start/terminal/phase outcomes plus
storage availability and explicit partial/overflow status. Missing identity,
stale generation, failed writes, absent entitlement, missing activation or a
partial marker cannot establish complete coverage.

The existing offline snapshot decoder caps a response at 100 rows, whereas this
producer can retain 240. That protocol is unchanged. A future adapter must use
bounded pagination with an audited coherent coverage contract, or return a
smaller explicitly **partial** window; it cannot truncate 240 to 100 and claim
complete coverage. Sticky partial/lost evidence needs an explicit reconciliation
contract before it can be cleared. The current decoder has no field for the
producer's terminal outcome, partial marker or unknown activation; it must not be fed fabricated
activation or complete provenance. Real external source/authentication is still
required. #20 and #29 remain open; all LIVE manifests, permissions, reviewers,
runner/exclusion, credentials, approvals, RPC/Test F and drills remain unverified.
The parent's pending fallback choice is neither required nor approved by this
independent CODE slice.


### Producer validation (CODE only)

All runs used Node **26.12.1** and Vitest **`--maxWorkers=1`**.

- RED against PR122's actual Worker registration/callback: the controller-minute
  regression fails with no progress row; restore the implementation afterward.
  The scheduled deadline regression also fails because the old scheduler returns
  no finite results. Real cleanup storage failure with logging suppressed
  reproduced false `ok`; explicit phase signals fix it. The real additive repair
  regression reproduced a successful repair being mislabeled failed; it now
  preserves success while incomplete repairs remain explicit.
- Final focused producer/delivery/broker run: **93 tests / 6 files passed**.
  Workerd D1 tests fill all **240** cells, allocate concurrent attempts, reject
  the fifth attempt, retain a late older failure, fence out-of-order/finished and
  stale-generation writes, and mark unresolved eviction partial. Callback tests
  cover cancellation, noncooperative finalizers, separate drain failure, hung
  observation I/O, missing identity and runtime-generated `gqcanary_` privacy
  canaries. No literal private payload is used as an observation dimension.
- Complete Worker run on unchanged committed runtime source
  `dc02cff830c5184a123bcd4db8df075ab54b5860`: **1,289 tests / 53 files passed**,
  **722.92 seconds**. This includes actual installed shared-graph/native upload,
  both stages/Discord modes, additive migration policy/history/identity/retain,
  authenticated dispatch, one-shot apply and retained failed-continuation locks.
  All native HTTP/RPC/storage evidence is synthetic/offline; no remote settings,
  permissions, migration applicability or live receipt is inferred.
- After that full run, three additional test-only write-rejection/missing-ledger
  cases were added: the final callback file passes **20 tests**. No runtime or
  deployment source changed after the full run. Worker typecheck/lint pass.
- Unchanged offline protocol: **81 tests passed**, preserving PR122 HTTP identity
  pins and late-Cron-failure carry. **114 CI-script tests**, workflow/runtime
  policies, root/app JS lint and **3** lint controls pass. Worker/docs and
  candidate-reachable history secret scans and whole-slice whitespace checks pass.

An exploratory native run while source was still being edited reported 61 passes
and three failures; it is not passing evidence. Two partial full runs were stopped
for the suppressed-log and metadata-repair corrections before the final complete
run above. They are not counted as final validation. Only the final frozen-source
run establishes the reported complete Worker result. Subsequent changes are tests
and documentation only, so no additional expensive full run was performed.
Hosted checks/reviews remain **uninspected**; no CI polling/watch or merge was
performed. Pushes use `GQ_SUPPORT_SKIP_PRE_PUSH=1`; no shared DDEV/browser work ran.
No LIVE operation, credential/profile access or notification was performed.

### Fixed readiness and aggregate wire snapshot (this CODE slice)

This section supersedes the unwired endpoint/100-row limitation described above.
`GET /internal/observer/v1/readiness` now runs before raw D1 acquisition, App key
setup, support admission, CRUD, wakeups and runtime alert persistence. Its fixed
`{version:1,check:"route_runtime",result:"available"}` means only that this route
executed. It reads no storage or private configuration and asserts no D1, App,
Cron or Discord health. It can therefore answer despite a raw binding failure.

`GET /internal/observer/v1/snapshot` is disabled by default. Exact reviewed
configuration and App-owned private custody must supply an independent random
32-byte capability, encoded as exactly 64 lowercase hex characters, in the
Authorization Bearer header. This is solely aggregate-GET authority. It is not
an App key, general State bearer, SQL credential or deployment token. The Worker
hashes the current two fixed-format values per request and compares fixed-size
buffers using the installed Workers `crypto.subtle.timingSafeEqual` extension.
Unsupported crypto, missing/wrong tokens and disabled mode fail before storage.
There is no warm secret/digest/response cache. The API is documented in
[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal).

Both routes reject methods other than GET, queries (including empty `?`), bodies,
cookies and Origin. They issue no redirects, CORS grants or cookies. Every
response, including denial/unavailability, carries browser/CDN no-store headers.
No endpoint takes SQL, paging, limits, stage, candidate or timestamps from the
request. Authentication is followed by current release/stage custody-pin checks.

The snapshot executes one fixed SELECT inside one D1 batch, including progress
control, maintenance generation/mode, finite Discord control and every retained
cell. A single statement supplies coherence without separate-page races. No
SupportDB, support records, receipts, App identity, Reporter, Client, repository,
request, CLI output or Alchemy State is read. It acquires no restore owner and
cannot release generations or alter admission/drain/replay. Controls and rows
are validated before output; malformed/missing bindings, storage errors and a
250ms cooperative deadline return fixed 503 `observer_unavailable`, without
causes. Already dispatched read-only D1 work cannot be cancelled by this deadline.

Version 1 has exact keys: version, generated, stage, candidate, generation,
maintenance, watermark, partial, activation, coverage, route, ticks. Ticks are
13-element tuples: stage, candidate, generation, scheduled minute, attempt,
start, terminal-or-null, terminal outcome index-or-null, then delivery/cleanup/
refresh/sweep/drain outcome indices. Terminal indices are settled/failed/
interrupted (0–2); phase indices are not_run/ok/failed/timed_out/contained (0–4).
All integers must be nonnegative safe integers, timestamps cannot exceed generated,
slots must be ordered distinct minute/attempt pairs, attempts are 1–4, and
terminal time/outcome must agree. Candidate is exact lowercase 40-hex. Rows from
prior candidates/generations remain visible; they cannot prove current health.
The route enum describes only local configuration/control, not Discord delivery
or human receipt. Disabled notifications remain explicit; not_run/contained never
become ok. No provider request occurs.

This heartbeat-only decoder explicitly accepts **240 cells**, preserving the
producer's entire 60-minute × four-attempt capacity. Other query decoders remain
at 100 rows. Count plus fixed LIMIT refuses excess cells, and sticky partial is
preserved. SQL bounds malformed strings and rejects noninteger numeric storage
before JSON crosses the binding. A valid maximum-width tuple is under 160 ASCII
bytes (including safe-integer widths); 240 tuples plus fixed envelope stay below
40 KiB. The implementation additionally enforces 60 KiB of row JSON and 64 KiB
for the complete response. There is no pagination or cursor consistency claim.

**Activation is null and coverage is unknown on every response.** No reviewed
activation/continuous-coverage witness exists in the producer. Watermark, generated
and latest row cannot supply that proof. The actual-wire adapter in protocol.ts
validates this DTO, pins stage/candidate/maintenance generation, preserves failed/
interrupted terminals and phase failures, and always refuses missing-start proof
or affirmative recovery from this wire version. It does not fabricate activation
from the private context. A retained incident cannot recover on invalid, partial,
stale or unknown evidence. Prior HTTP identity/advancing timestamps and late-Cron
failure ownership remain unchanged. Supporting affirmative recovery later needs
reviewed activation, continuous coverage and maintenance exclusion metadata.

The existing GitHubAppSecret lifecycle now owns a bounded observer-secret
transition before Discord custody: disable, inspect, exact token/stage/release
writes or verified removal, then inspect. It uses one-shot ordered operations,
nested authentication and final synchronous abort/deadline/window guards; checks
binding names/types and leaves observability unchanged. Disabled mode removes old
observer secrets before Discord's verified removal can restore traces. Enabled
Discord still has logs on and traces off; disabled Discord restores traces only
after removals. An Authorization header supplies no evidence for a new trace
exception. Public mode/stage/release plus an opaque per-session nonce participate
in the retained candidate. No token or token hash enters props, State, offline
child, public candidate, errors, logs or the App RPC subprocess. The retained
launcher alone can consume a future privately delivered owner-only file; this
slice requested/accessed no credentials. Unset LIVE config still refuses before
private file acquisition. Privileged profiles/resources remain unchanged.

Remaining: external HTTPS transport/endpoint origin validation, independently
reviewed activation/expectations/exclusions, scheduler/workflow, durable sender
and journal, POLICY fallback decision, private custody delivery and LIVE proof.
No observer is enabled and no notification, drill, deployment, setting or State
operation was performed. Receipt/human acknowledgment remain unverified; #20
and #29 remain open. The smallest next CODE step is a reviewed activation and
continuous-coverage evidence contract; transport can then consume this DTO without
inventing coverage. The pending parent fallback policy is independent of these
endpoints.

### Endpoint validation evidence (CODE only)

All commands ran with `/home/valerio/.local/share/mise/installs/node/26.12.1/bin`
first in PATH (**Node 26.12.1**). Every Vitest run used `--maxWorkers=1`.

- RED: two actual-registration tests failed because readiness/default-disabled
  snapshot acquired bindings first. Another RED test failed because malformed
  unrelated support configuration prevented handler initialization. The final
  registration bypasses that configuration and raw storage, and tests an
  authenticated snapshot with SupportDB absent and no admission/support/App work.
- Focused final route/custody/broker/provider run: **103 tests / 5 files passed**.
  This covers installed-workerd timing-safe verification, current-token rotation,
  unsupported crypto, fixed errors, query/body/method/cookie/origin denial,
  cooperative hung-read timeout, full 240-cell coherent D1 output, overflow,
  malformed/NUL-corrupted data, generation/candidate pins, ordering/staleness,
  real-wire failure carry and maximum-width byte budget. New custody-name upload
  rejection tests use otherwise valid metadata and matching bundle digests.
- Final complete Worker run on frozen runtime commit
  `9f061351e64067721f45e70b6c1bf12c5d7f0c42`: **1,333 tests / 55 files passed**,
  **777.25 seconds**. The actual shared native graph/Worker/App custody/broker/
  output tests exercise both stages and all four Discord/observer mode pairs.
  Only first-party fake HTTP and fake private inputs are used. App RPC execution
  is synthetic; its exact environment/input keys exclude observer capability
  material. No live App identity, binding, setting or receipt is inferred.
- Offline protocol: **81 tests passed**, retaining prior advancing HTTP pins and
  late-Cron failure ownership. All **five negative controls** are detected by real
  assertion failures. The temporary-copy runner now includes the shared actual
  wire decoder; module-load failure is not accepted as a detected regression.
- **114 CI-script tests**, runtime/workflow policies, Worker typecheck/lint,
  root/app JS lint, **three lint controls**, Worker/docs and candidate-reachable
  history secret scans, and whole-slice whitespace checks pass.

Exploratory runs while source was changing found missing tracked-source copies,
empty-query handling and configuration-before-readiness defects. Two incomplete
broad runs were stopped for corrections; none is counted as passing evidence.
Only the complete frozen-source run above establishes the full-suite result.
Afterward, only tests/docs changed: the workerd fixture now explicitly asserts
that correct authentication reaches the ledger callback and wrong authentication
does not. That focused file passed **17 tests**; typecheck and lint were rerun; runtime/custody source
was unchanged and the full suite was not repeated.

Reproduction commands (from the repository root):

```sh
pnpm --filter gq-support-worker exec vitest run --maxWorkers=1
pnpm --filter gq-support-worker exec vitest run test/observer-http.test.ts test/observer-custody.test.ts test/worker-runtime-alerts.test.ts test/planning-apply-broker.test.ts test/mvp-integration.test.ts --maxWorkers=1
pnpm --filter gq-support-worker exec vitest run --config tools/observer/vitest.config.ts --maxWorkers=1
node worker/tools/observer/negative-controls.mjs
pnpm --filter gq-support-worker typecheck
pnpm --filter gq-support-worker lint
pnpm test:ci
node scripts/ci/runtime-matrix.mjs policy
node scripts/ci/workflow-policy.mjs
pnpm lint:js
pnpm test:lint
scripts/ci/gitleaks.sh dir worker
scripts/ci/gitleaks.sh dir docs
scripts/ci/gitleaks.sh git --log-opts='4f3cffa096f091cda89872b04e5aa6946141c0cb..HEAD' .
git diff --check 4f3cffa096f091cda89872b04e5aa6946141c0cb
```

The actual-wire adapter supplies no disabled-drain or maintenance exclusion proof;
a settled terminal with drain=not_run still cannot count as healthy completion.
The smallest next step remains a reviewed activation/continuous-coverage and
exclusion contract, followed by fixed external transport. POLICY fallback,
scheduler/workflow, durable sender/journal and private LIVE delivery/proof remain
pending. Receipt is unverified and #20/#29 stay open. No LIVE operation, credential/
profile access, remote settings/State change, deploy, notification, drill, GitHub comment,
merge, hosted-check polling/watch, browser, PHP or DDEV work was performed.
Pushes use `GQ_SUPPORT_SKIP_PRE_PUSH=1`; hosted checks/reviews remain uninspected.

## Bounded activation and record evidence contract

This slice starts at authoritative PR #124 SHA
`837baea59bb49393ce935fce9f26c972749a99ae`. GitHub reports its head branch as
`t3/observer-progress-snapshot`; the requested `t3/observer-read-surface` ref is
absent. The pinned SHA takes precedence. Earlier proposed health/coverage rules
are not implemented activation or continuity witnesses.

**NOW implemented, offline only:**
[`snapshot-evidence.ts`](../../worker/tools/observer/snapshot-evidence.ts) validates
an exact private manifest and separately supplied custody pins, then the actual
v1 wire adapter attaches a bounded private assessment to Batch. It grants no
public health or recovery. No runtime producer, endpoint, migration, Alchemy
provider, retained planning/candidate custody, DB retain policy, failed-window
protection or ownership-release behavior changes.

The private manifest is at most 8 KiB with these exact fields:

| Fields | Required meaning and validation |
| --- | --- |
| `schema`, `proof` | `1`, `reviewed_business_activation`; release/deployment creation timestamp is not this proof. |
| `account`, `stage`, `candidate`, `deployment`, `version`, `generation` | Tipme account, staging/prod, 40-hex reviewed source SHA, exact UUID deployment and single UUID version, safe nonnegative maintenance generation. Independently supplied custody must match all pins. No weighted/multiple-version inference. |
| `activatedAt`, `validFrom`, `validTo` | UTC milliseconds; activation no later than validity start; half-open validity contains now; length at most 60 minutes. Context activation must match. No retroactive extension from latest tick or now. |
| `issued`, `evidenceObserved` | UTC safe integers, validity start ≤ evidence observed ≤ issued ≤ now; observed no older than two minutes. This is a proposed freshness limit, not an approved SLO. |
| `reviewer`, `record` | Exactly vvaz **or** gmarques and a 64-hex digest identifying the restricted authenticated operational review record. Custody must match both; no hierarchy or escalation order. |
| `snapshotSha256`, `observation`, `readAt` | SHA-256 of exact snapshot bytes, independent runner observation integer and UTC read time, bound to trusted Read. Evidence observed ≤ read time ≤ issue; read time is within validity and at most two minutes old. Capability consumes once, even on mismatch. Replaying or copying it cannot grant new claims. |
| `notification` | Reviewed `enabled` or `disabled` expectation bound to these pins. Disabled plus wire route=disabled yields only private `reviewed_disabled`; not_run/contained never becomes ok. Neither value proves provider health, delivery or receipt. |
| `exclusions` | At most 60 sorted, nonoverlapping `{from,to,generation,reason}` intervals inside validity, same generation, positive duration, reasons only maintenance/restore/rollback. Context intervals must match exactly. The same actor/record must authorize every interval in that private manifest; this authentication is an external duty. Exclusions never erase record gaps or failures here. |

Custody is a separate exact object containing the six identity pins plus
`sha256`, `reviewer`, `record`. Hashes check integrity, **not signer identity,
review approval or historical truth**. The validator cannot create those facts.
A caller-created custody object is only an offline test seam. Single-use capability
refusal is process-local; revalidating the same manifest bytes can create another
capability, so authenticated issuance/replay refusal across runs remains an external
loader/journal duty. Exact body/time/observation binding cannot become a new observation
by replaying those bytes. No live loader or durable replay/reissue journal,
restricted record location, authenticated author verification, single-version
provider observation or real activation attestation has been supplied. The
existing approved operations authority is vvaz or gmarques ([recorded decision](operational-readiness.md#confirmed-operational-decisions--2026-10-27)); this contract grants neither a new
operator role nor production approval. The external reviewer must establish
business activation, current exact deployment/version and maintenance generation,
reviewed notification mode and the reason/authorization of every exclusion from
actual restricted evidence. A deployment timestamp alone is insufficient.

The trusted transport must independently check exact current deployment/version
and fixed authenticated read origin and supply observation/time/pins. It remains
unimplemented. The manifest is never accepted from the untrusted response. It
contains private identities and must stay outside source, public artifacts,
Worker props/State, offline public candidates and publishable verdicts. There
are no secrets in the schema. The module returns only fixed refusal errors.

**What the bounded proof means:** the existing
[`observerRequest`](../../worker/src/observer-http.ts) reads all ≤240 cells and
controls through one fixed SQL statement, refusing corrupt/excess cells, failed
storage, byte overflow and timeout. Its actual DTO is strictly decoded. Given
trusted fixed-route provenance and matching reviewed input, `coherent_ring_read`
reports explicit whole-minute `[from,to)` bounds and absent matching-candidate/
generation record slots **at that coherent read**. Bounds intersect requested
interval, reviewed validity, activation, completed generated-time minutes and
the conservative retained range (at most 60 minutes, also no earlier than
watermark−59 minutes). They are not silently extended to a full hour. Partial
transport, sticky partial/overflow, evicted unresolved evidence or unavailable
storage cannot grant that record assessment. Other queries still cap at 100;
wire stays 240 cells / 64 KiB, public stays eight fixed classes / ≤2 KiB.

Record absence is an **evidence gap**, not Cron nonexecution and not successful
writes throughout the gap. In
[`progressIO`](../../worker/src/cron-progress.ts), a failed/timed-out start can
leave no record and no sticky partial marker; already dispatched I/O may settle
late. Runner loss before a start, partial phase storage, rollback, and maintenance
or restore gaps have no independent continuous-write witness. HTTP 200, a
permission boolean, zero/empty results, release creation time and watermark do
not repair that absence. Accordingly actual-wire `activation=null`, evaluator
coverage unknown and private `continuity=unknown` remain unchanged, including
when this validator accepts external activation input. Missing starts cannot
be classified as execution failures and successful rows cannot recover retained
failures on this wire. Disabled drain expectations do not make completion healthy.

The adapter now retains each row's candidate/generation instead of discarding
old identities. Fresh observations of explicit failed/timed_out/interrupted
records latch even when their generated/slot times are old. Unfinished attempts
still use the proposed incomplete deadline. Failure identity includes candidate,
generation, slot and attempt; a new deployment/generation, exclusion, newer
success window or missing/evicted row cannot reconcile it. Overflow stays latched.
Unknown cannot recover an incident. Existing advancing HTTP pairs/pins, late
Cron latch and #123 cleanup-due failure / #124 constant-time auth/custody remain.

**Remaining CODE:** smallest safe next slice is a fixed read-only HTTPS transport
that verifies current exact pins and returns unknown where provenance or review
is absent, without provider-write/SQL-admin capabilities. A private authenticated
manifest loader needs an actual restricted review-record location and
independent actor/proof verification before accepting real attestations. Complete
Cron coverage/recovery additionally needs a separately reviewed, bounded witness
for successful progress storage across the claimed interval, durable unresolved
identity carry, late-I/O fencing and rollback/restore/maintenance continuity.
No complete flag or operator boolean substitutes for it. That witness is not
available now and this slice does not design a new monitoring platform.

**Remaining LIVE/preconditions/assumptions:** collect genuine exact-pin activation
and notification/exclusion evidence under existing authority; verify independent
transport identity/scope and clocks; validate journal/runner-loss continuity and
sender/receipt custody. Scheduler/workflow adapters, durable journal, sender and
receipt proof remain unwired. Parent fallback policy remains pending independently.
#20/#29 remain open. This is not production enablement or approval.

**Configured runtime validation gap retained:** the earlier local workerd review
could not start configured compatibility **2026-10-17** and used test date
**2026-09-16**. This slice retains that fixture date and does not lower production
configuration or claim configured-runtime proof. Offline Node checks and local
D1/older-date workerd tests establish only their stated bounds.

### Evidence-contract validation (local only)

Node 26.12.1 was selected with
`PATH=/home/valerio/.local/share/mise/installs/node/26.12.1/bin:$PATH` for every
Node/pnpm command below. Exact commands from repo root:

```sh
pnpm --filter gq-support-worker exec vitest run --config tools/observer/vitest.config.ts --maxWorkers=1
pnpm --filter gq-support-worker exec vitest run test/observer-http.test.ts test/cron-progress.test.ts --maxWorkers=1
node worker/tools/observer/negative-controls.mjs
pnpm exec eslint worker/tools/observer worker/test/observer-http.test.ts --max-warnings=0
pnpm --filter gq-support-worker typecheck
node scripts/ci/runtime-matrix.mjs policy
node scripts/ci/workflow-policy.mjs
scripts/ci/gitleaks.sh dir worker
scripts/ci/gitleaks.sh dir docs
git diff --check 837baea59bb49393ce935fce9f26c972749a99ae
```

- RED: two new real-wire failure regressions failed with unknown instead of
  incident; the prior **81 tests passed** in that same run.
- GREEN: isolated protocol/contract **121 tests / 2 files**; affected producer/
  endpoint tests **22 tests / 2 files**. All **five negative controls** still
  cause actual assertion failures. No claimed “21 probes” or broad-suite count
  is inferred from the task shorthand.
- Local real D1 producer → authenticated endpoint bytes → strict adapter →
  evaluator covers 240 cells, reviewed narrow disabled expectation without
  healthy completion, failure carry, and a timed-out heartbeat write absent at
  read then actually settling later. Partial/evicted unresolved evidence,
  malformed/wrong-pin/stale/future/rollback inputs, race/body changes,
  capability replay, exclusions and enabled-mode forgery cannot grant health.
  Runtime privacy canaries use `gqcanary_` plus fresh random material.
- Affected lint/types, runtime/workflow policies, Worker/docs secret scans and
  whitespace pass. No runtime source changes justify a broad Worker rerun; the
  prior full-suite result remains historical, not rerun evidence for this slice.

PR #124's reported independent Standards=0 / Spec=0 review is parent context,
not a review of these new changes. Hosted checks/reviews are uninspected. No live
HTTP/account/state/credentials/profiles/secret requests, deployment/settings,
notifications/drills, GitHub messages/comments, merge, browser, PHP, DDEV or
CI polling/watch occurred. Push uses `GQ_SUPPORT_SKIP_PRE_PUSH=1`.

### Evidence capability review correction

Independent review found one P2: parsing/provenance/context or budget rejection
could leave the caller's single-use snapshot review capability reusable. The
batch now consumes it before any snapshot validation, and reserves its internal
replacement for the first snapshot only. A rejected first read cannot pass that
authority to a later read or retry. Non-snapshot batches do not consume it.
Eight new cases reproduced the defect before correction, covering malformed
JSON/UTF-8/wire data, size, status, context, batch bounds and same-batch retry.
All 129 offline tests and five existing negative controls pass after correction;
Worker typecheck and affected lint pass. This adds no authentication, continuity,
health or operational authority. No runtime source or LIVE resource changed.


### Fixed read-only HTTPS library CODE slice

Based on PR #125 `437ce5baf90c28e249ab937e3f33e2329ed13d96`, on the dedicated
`t3/observer-https-transport` checkout; no other worktree or source branch changes.
[`https-transport.ts`](../../worker/tools/observer/https-transport.ts) now connects
exact readiness/snapshot GETs to the actual v1 decoder and evaluator. The
[implemented contract and bounds](../../worker/tools/observer/README.md#fixed-https-transport-this-slice)
supersede earlier statements that transport is absent. No production runtime,
resource, grants, deployment, scheduler, workflow, journal or sender changes.

The only target is an explicitly supplied reviewed canonical workers.dev HTTPS
origin whose first label equals the reviewed Worker. No custom routes, paths,
queries, userinfo, ports, IP/localhost/private literal targets, redirects, cookies
or ambient credentials/proxies are accepted. Target/context account, stage,
candidate and generation match before dispatch. Exact deployment/version pins are
external trusted inputs; no response field authenticates them. Stage-to-origin,
DNS resolution/target safety, account ownership and current deployment/version
attestation are still an independent loader duty. **Lexical validation is not DNS
or ownership proof**. No authenticated loader or live identity evidence exists.
A valid manifest/digest/caller-created pins cannot establish authority on their own.

The injected standard fetch receives fixed GET/Accept/Accept-Encoding:identity, redirect:error,
credentials:omit, cache:no-store, AbortSignal and snapshot-only Authorization.
Readiness has no credential and requires the exact data-free endpoint contract;
success authorizes no additional operation. Snapshot needs its own explicit stage
read capability. Private inputs are detached before awaits. Ten seconds bounds
the entire two-read run, with ≤64 KiB and ≤1024 chunks per body, ≤128 KiB total,
two responses and ≤240 snapshot cells. Content-Length is checked but not required; only absent/identity Content-Encoding
is accepted to avoid comparing decoded bytes with compressed lengths.
Final URL/redirect/status/JSON type are checked, raw headers/body/error text are
discarded, streams cancelled on refusal and late responses disposed. Cancellation
or deadline stops remaining dispatches with no retries. Noncooperative injected
I/O can outlive cancellation; bounded return is not remote cancellation proof.

Public output is ≤2 KiB, finite transport availability, snapshot acceptance,
reviewed-external-input status, unknown continuity and existing eight-class verdict.
Private state is request-local carry only. Invalid/denied/stale/future/wrong-pin
snapshots cannot recover incidents; independently valid explicit failure rows
remain useful, including partial rings. Read completion times/IDs feed existing
strictly advancing same-candidate/generation HTTP confirmation. Network/HTTP failure
is unavailability at this vantage, not proven platform root cause. Route success
never implies business delivery, Cron, App or Discord health.

#125 private review is consumed before **all validation** of a run requesting
snapshot, including target, credential, readiness, cancellation and denial failures.
Only genuine independent custody may grant bounded exact-byte/ID/time external
claims; continuity/activation wire/coverage stay unknown. No insecure chat/input
secret plumbing or review boolean was added. The authenticated loader, durable
reissue/replay refusal and future private parent delivery remain separate work.

Remaining CODE: real GitHub/Cloudflare adapters, authenticated target/review loader,
continuous progress-storage witness with late-I/O fencing, scheduler, durable
unresolved journal and sender. Remaining POLICY: parent fallback choice. Remaining
LIVE: genuine manifests/current pins, scoped permissions, runner/storage proof,
exclusion/credential custody, approvals, Test F/drills, confirmed receipt and human
acknowledgment. #20/#29 stay open. No production enablement or operational policy
was inferred. The configured 2026-10-17 runtime remains unproven by installed
workerd at test date 2026-09-16; production compatibility is unchanged.

Smallest next safe slice: specify and test the authenticated target/review loader
against a selected restricted review-record and actor-authentication contract,
without adding live reads or an enabled entry point. Its real source/custody is
still missing and must be supplied independently; no boolean can fill that gap.


#### HTTPS library validation (offline/local only)

Node 26.12.1 was selected with the explicit supplied path for all Node/pnpm commands.
Dependencies were linked with `pnpm install --offline --frozen-lockfile --ignore-scripts`
(1,385 cached packages, zero downloads). Final commands/results:

```sh
pnpm --filter gq-support-worker exec vitest run --config tools/observer/vitest.config.ts --maxWorkers=1
# 214 tests / 3 files passed
pnpm --filter gq-support-worker exec vitest run test/observer-http.test.ts test/cron-progress.test.ts test/observer-custody.test.ts --maxWorkers=1
# 31 tests / 3 files passed
node worker/tools/observer/negative-controls.mjs
# five deliberately broken protocol copies detected by real assertions
node worker/tools/observer/transport-negative-controls.mjs
# three deliberately broken transport copies detected by real assertions
pnpm --filter gq-support-worker typecheck
pnpm exec eslint worker/tools/observer worker/test/observer-http.test.ts --max-warnings=0
node scripts/ci/runtime-matrix.mjs policy
node scripts/ci/workflow-policy.mjs
scripts/ci/gitleaks.sh dir worker
scripts/ci/gitleaks.sh dir docs
git diff --check 437ce5baf90c28e249ab937e3f33e2329ed13d96
# types, lint, policies, both secret scans and whitespace passed
```

The injected-fetch vectors verify exact methods/headers, credential-free readiness,
snapshot-only Authorization, input mutation isolation, final URL/path/query/redirect
refusal, invalid/delayed headers/body, streaming cancellation, chunk/byte caps without
Content-Length, exact-cap valid JSON, 403/5xx/invalid 200, runtime-random privacy
canaries, pre/between/body cancellation and total timeout, late/noncooperative I/O,
wrong identity/stale/future/partial wire, old failure carry, equal-time/cross-revision
HTTP refusal and pre-validation one-shot consumption. Local actual endpoint/D1 tests
exercise both stages and the 240-cell ring without network or TLS assertions.

Initial typechecking exposed the installed Workers type surface's narrower Fetch
options/Response types; fixed options are retained at runtime and checked against
that baseline without changing production configuration. Final checks above pass.
No broad Worker run was warranted: production runtime source is untouched. No live
observer/provider HTTP, account/State/settings, credentials/profiles/secret requests,
deployments, notifications/drills, GitHub comments/messages/reviews, merges, DDEV,
browser, hosted CI polling or watches were performed. Git publication uses
`GQ_SUPPORT_SKIP_PRE_PUSH=1`. Hosted checks/reviews are uninspected, and parent
review results are not a review of this slice.

### Transport review correction: deadline response ownership

Independent Standards review found no defects; Spec review found one P2.
If fetch returned at the clock deadline before the timer callback ran, the
post-await deadline check could reject before cleanup owned the response.
The fetch settlement handler now captures the response before that clock check,
so rejection cancels the stream. Truly late settlement still requests disposal
and cannot start another dispatch. Two new readiness/snapshot cases reproduced
zero cancellations before correction and now require exactly one. All 216
offline observer tests, eight negative controls, typecheck and affected lint pass.
No runtime source, live TLS/DNS/account evidence or operational authority changed.

## Authenticated digest-only review loader CODE slice

Stacked on #126 head `5d1e3bb4a92be30f9e6bb5d6fd59c0113f8addd3`,
`worker/tools/observer/review-loader.ts` now implements a bounded trusted-launcher
library and exact-record handoff. This supersedes the earlier **loader code absent**
status only; real private delivery, external attestation and durable replay refusal
are still absent. No review record exists or is granted by this task.

Quick-Release/gq-support is PUBLIC, with default branch main. Proposed approval is
one exact #20 comment containing only `approve-observer-read sha256:` and 64 lowercase
hex characters, without whitespace or other text. It binds all exact private
manifest bytes; no private target/account/deployment/version/generation or credential
material may enter public GitHub text/artifacts. This grammar and a maximum five-minute
session window are implementation proposals for review, not policy approval or an SLO.

The [full library contract](../../worker/tools/observer/README.md#authenticated-digest-only-review-loader-this-slice)
specifies exact manifest keys, independent stage/head/session/nonce/window/hash pins,
optional exact #125 JSON text and the precise API routes, fields and bounds.
Only source-reviewed numeric vvaz/gmarques IDs are accepted, using the existing
deployment verifier's custody pattern. No live numeric IDs are configured in the
repo and none were invented; test IDs are synthetic. vvaz OR gmarques has equal
existing authority, with no hierarchy or new grant.

Current official GitHub docs were checked for
[exact comment GET/response fields](https://docs.github.com/en/rest/issues/comments#get-an-issue-comment),
[user identity](https://docs.github.com/en/rest/users/users#get-a-user) and
[repository permission](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user).
The verifier checks exact comment ID, repository/issue URLs, author numeric ID,
login and User type, raw body and creation/update timestamps. It independently
checks current actor identity and repository write/admin legacy permission
(maintain maps to write). It does not use `author_association`, a local JSON reviewer,
an approved flag, fake verifier callback, list/latest comment, environment approval
or invented GitHub fields as proof. It follows no response links. No repository
permission change or broader token scope is requested by this slice.

The session consumes before all validation and awaits, then copies inputs.
Its closure authenticates initially, reauthenticates immediately before **both**
fixed #126 Worker GETs, checks cancellation and all time pins after async checks,
then dispatches without another await. Exact-comment rereads occur after identity
and permission checks. Final verification withholds results if approval changes
while observer I/O is pending; any verification failure is terminal even through
#126's error catch. Editing or deleting the exact selected record revokes it;
other comments are deliberately neither listed nor interpreted. A new record is
never automatically substituted. This concrete handoff does not expose a reusable
boolean/capability that #126 could retain as stale authority. It observes current
API state; it cannot atomically lock GitHub and Worker dispatch or discover hidden
edit history beyond documented timestamps/current body. A change after its last
observation remains an external race, not a claimed cross-provider transaction.

Bounds: cooperative ten-second total session, at most sixteen GitHub GETs,
32 KiB and 1024 chunks per response (512 KiB total GitHub data), no retries.
Redirects, nonexact final URL, pagination links, compression, cookies, malformed
JSON/UTF-8, unknown permissions and non-200 replies refuse. Refused/late streams
are cancelled; noncooperative remote termination is not proved. GitHub and snapshot
credentials have distinct custody and fixed destinations. No ambient fetch/auth,
gh/profile/env discovery, RPC, raw errors, credential logs or artifacts are added.
Only existing finite ≤2 KiB `result.public` is publishable. Private snapshot/carry
remain in trusted launcher memory and never become public state.

Optional #125 custody binds the authenticated actor and SHA-256 of the exact API
comment URL, plus all existing snapshot byte/observation/time and target pins.
That approval proves the actor approved those private bytes, not that Cloudflare
owns the origin/account/deployment or that activation/continuity assertions are
true. The actor's target and activation attestation duty remains explicit external
evidence. No independent Cloudflare source was implemented or verified. There is
no manifest-authority=healthy implication, deploy/send/restore/credential-broadening
authority or incident recovery. Continuous progress-storage witness is unavailable;
private actual-wire coverage/continuity stay unknown and absent records are not
nonexecution. Existing old-failure/candidate/generation pins and eight-class verdict
semantics remain intact.

The object is one-use in process only. Constructing a new object/restarting can
reissue authority; no durable replay claim, cache or artifact is substituted for
the prerequisite launcher-owned replay journal. Real private delivery remains
parent-owned: retain exact bytes and external supporting evidence privately,
accessible to the trusted launcher and approving actor; separately supply reviewed
identity IDs, fresh pins and the selected exact digest record. No private store or
provider was invented. An operator may later create the digest-only record; this
library cannot post it, and this task did not create approval.

Remaining CODE: private authenticated delivery plus independent target-attestation
source, durable replay/unresolved journal, continuous storage witness and late-I/O
fencing, remaining provider telemetry adapters, scheduler and sender. Remaining
LIVE: actual records, identities, custody/scope/permissions and supporting evidence,
runner/exclusions, Test F/drills, transport receipts and human acknowledgment.
Remaining POLICY: independent parent fallback decision. #20/#29 stay open and no
production enablement occurs. Configured runtime 2026-10-17 remains unproven under
test date 2026-09-16; production configuration is unchanged.

Smallest next safe slice: parent-owned private delivery and retained-byte/attestation
custody design, with durable session consumption specified before any enabled flow.
No live observer or approval acquisition is a prerequisite to reviewing this code.

### Review-loader offline validation

Node 26.12.1 was selected from the supplied absolute installation, using one
Vitest worker and the isolated observer configuration (no Worker global setup).
Dependencies linked from the offline frozen cache, with scripts disabled and zero
downloads. Results:

```sh
pnpm --filter gq-support-worker exec vitest run --config tools/observer/vitest.config.ts --maxWorkers=1
# 292 tests / 4 files: original 216 plus 76 loader cases
node worker/tools/observer/negative-controls.mjs
node worker/tools/observer/transport-negative-controls.mjs
node worker/tools/observer/review-negative-controls.mjs
# original eight plus two loader broken copies detected by real failing assertions
pnpm --filter gq-support-worker typecheck
pnpm exec eslint worker/tools/observer --max-warnings=0
node scripts/ci/runtime-matrix.mjs policy
node scripts/ci/workflow-policy.mjs
scripts/ci/gitleaks.sh dir worker
scripts/ci/gitleaks.sh dir docs
git diff --check 5d1e3bb4a92be30f9e6bb5d6fd59c0113f8addd3
```

Loader vectors use GitHub-shaped response envelopes and runtime-generated canaries.
They cover spoofed manifest authority, wrong repo/issue/ID/login/type, independent
identity/permission mismatch, strict grammar/hash/session/nonce/stage/head/purpose/
window pins, expired/future/edited/deleted records, revalidation after revoke and
before the nested snapshot request. Cancellation and expiry after the final
async dispatch check, pending verification/body timeouts, byte/chunk/redirect/header/
malformed response bounds, late-response disposal, immutable copies, concurrent use,
failed-auth/token/snapshot one-shots, both equal-authority actors, optional #125
actor/record/target/byte pins and real #126 decoder/evaluator plus endpoint refusal.
The original 216 vectors and eight negative controls preserve all #125/#122 and
deadline-disposal regressions, including the existing local 240-cell integration.
No live HTTP/TLS/DNS/account/ownership claim follows from injected HTTP.

Types, affected lint, policy checks, both secret scans and whitespace pass. No full
Worker suite is needed for this isolated launcher library; production source behavior
is untouched (the #125 source comment now points to the implemented loader). No
approval record, GitHub comment/review/message, credential acquisition/profile,
account/State/settings operation, deployment/drill/send/merge, DDEV/browser, CI poll
or watch is part of validation. Publication uses `GQ_SUPPORT_SKIP_PRE_PUSH=1`;
hosted checks/reviews are uninspected. No scheduler, sender, journal or entry point
was enabled.

## Bounded private delivery and read-session custody, stacked on #127

The concrete launcher-only adapter is now `worker/tools/observer/private-launcher.ts`.
Its exact delivery schema, descriptor custody, permanent 256-slot replay journal,
filesystem assumptions, blocked retention frontier and remaining parent/LIVE work
are specified in the [observer README](../../worker/tools/observer/README.md#bounded-private-launcher-delivery-and-read-replay-custody-stacked-on-127).
It consumes explicit owner-only `manifest.json` and `credentials.json` files before
parsing, separates MANIFEST-only public approval from credential bytes, and composes
the actual #127 loader with #126 through injected HTTP. Exclusive file creation,
file fsync and directory fsync precede every first GitHub dispatch. No session
expiry, crash, failed auth/read or concurrent launcher can reassign an existing
slot under the stated filesystem contract. Partial/corrupt entries and collisions
block; there is no cleanup or automatic storage replacement policy.

Implemented CODE evidence uses ephemeral fake files, real file descriptors/fsync,
multiple child processes and fake HTTP. It establishes neither persistent runner
nor host-loss durability, backup integrity, all-runner exclusion or genuine target
attestation. Existing deployment delivery requires 0400 files at a specific tmpfs
path; a tool secret delivery is not assumed to meet that path/mode or this adapter's
ancestor rules. Parent-owned safe transfer and persistent storage proof remain
prerequisites, with no store/vendor/runner selected and no discovery/secret request.

This claim is restricted to `observer_reads`; it is not a durable alert-send journal,
notification receipt, continuous storage witness or restore-safety proof. #122 failure
carry, #125 pre-validation capability consumption, #126 stream disposal and exact
vvaz OR gmarques fresh record revalidation remain intact. Supplied #127 Standards0/
Spec0 is context only. Actual-wire continuity/health/recovery stay unknown; #20/#29,
receipt/human acknowledgment and fallback policy stay unresolved. No workflow,
scheduler, live account/State/settings access, notification, drill or deployment was
added. Minimal next step is parent review of delivery/storage custody and retention,
then independently attested identity/target evidence before genuine delivery/approval.
Configured 2026-10-17 runtime remains unproven under 2026-09-16 test runtime.

### Private custody review correction

Independent Standards review found no issues. Spec review found one P2:
closing an ancestor descriptor could throw before ownership moved to the next
opened directory, leaking that directory and retrying an ambiguously closed fd.
Traversal now tracks the new descriptor before closing its predecessor. A new
real-descriptor regression reproduced the leak, then passed five consecutive
post-close failures with no leaked descriptors, no ambiguous-close retries and
no network dispatch. All 339 observer tests, Worker typecheck and affected lint
pass. This does not prove persistent runner/storage or host-loss durability.

## Configured runtime validation follow-up

The [configured-date gate and reproduction record](configured-runtime-validation.md)
now supersede this document's historical local startup gap: actual workerd runs
the unchanged configured **2026-10-17** date using the narrowly pinned gate-only
executable override. Existing September fixture evidence remains distinct.
The real Alchemy Worker build, local D1 snapshot, native auth, binding-free
readiness, generation fencing and containment execute locally; the deliberate
September-date control is rejected. This supplies no live provider/TLS/account
or operational evidence. Parent fallback and persistent custody proof remain
pending independently; #20/#29 remain open and no production enablement follows.

## Exact tracked Actions wire CODE slice, stacked on #129

The [adapter contract](../../worker/tools/observer/README.md#exact-tracked-github-actions-wire-adapter-stacked-on-129)
now decodes official workflow and exact run-attempt object envelopes with independent
expectation/ref/repository identity joins. At most 20 tracked expectations, including
outstanding runs older than 24h, cost <=3 metadata + <=20 exact GETs; there is no list,
discovery, replacement or age eviction. Bounds are 64 KiB/body, 512 KiB total,
1024 chunks/body and 10 seconds clipped to expiry. No retry or enabled entry point.
The [official API research](github-actions-tracked-runs.md) records version
2026-03-10, Actions:read and public unauthenticated limits, without claiming a
configured token or live entitlement/lag/identity/permission proof.

Exact terminal failures reach the real evaluator and private carry even after a
later unresolved source. Old newly observed failures cannot hide below a recovered
watermark. Success remains workflow evidence only; cancellation, waiting, skipped,
missing/denied and partial observations never become healthy readiness. Only an
approved exact higher-attempt retry with complete affirmative source proof can
recover under the existing protocol. Display/title/job/run-path text supplies no
stage/pipeline authority. Raw responses/URLs/headers/IDs/errors/secrets stay private.

The explicit dedicated Actions-read token/context are injection seams, not real
custody/approval. #127/#128's credential bundle and purpose are unchanged; broader
read scope requires a future explicit prerequisite and separate review. No
notification/deployment authority, Actions write grant, scheduler/workflow/CLI,
sender, retry, remote settings/State or production enablement was added. #129's
configured-date gate remains separate local evidence (two cases, reviewed zero
findings), with runtime/CI pins unchanged and no live proof added here.

Remaining untracked discovery, Cloudflare adapters, continuous storage witness,
durable failure storage, notification journal/sender, persistent runner/private
LIVE inputs/source approvals/permissions/attestation, Test F/drills/receipt/human
acknowledgment and parent fallback policy remain open. #20/#29 stay open. Next
smallest safe slice: offline Actions-read purpose/credential delivery through the
existing one-shot custody path, binding tracked refs/identities and scope, with
explicit separate review before any execution is enabled.
