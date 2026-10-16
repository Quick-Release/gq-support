# Support delivery design

Resolution of [Design durable intake, Queues delivery, and GitHub duplicate reconciliation](https://github.com/Quick-Release/gq-support/issues/11), agreed with the maintainer on 2026-10-16. [Storage](support-storage-design.md), [API](support-api-contract.md), [GitHub integration](research/github-app-issue-integration.md), and [privacy](support-privacy-design.md) are inputs. This is an implementation-ready decision, not a claim of implemented delivery or deployment.

## Decision and scope

Accept a Support request by atomically recording its Submitted text, request identity and create intent in D1. Return `202 accepted-pending` after commit. Attempt delivery promptly in bounded background work; recover due work with a once-per-minute scheduled sweep. Target seconds normally and roughly a minute for recovery when capacity and providers permit; these are targets, not guarantees. Neither the response nor a background wake-up claims a GitHub issue exists.

D1 is the authoritative outbox. A best-effort post-commit `waitUntil()` wake-up may reduce latency, but lost execution is recovered from D1. Defer Queues and a DLQ: there is no D1/enqueue dual write in the first slice. Revisit Queues if measured pending age, sweep cost or volume requires it; any later queue carries opaque identities only and remains a wake-up, with duplicate handling and a DLQ. Do not add Durable Objects, a WordPress outbox, comments, attachments or Reporter status mutations here.

## Acceptance and responses

- Resolve the Slot, repository and immutable Reporter subject from trusted authentication and approved mapping. Pin the repository and GitHub App installation for delivery; do not reroute old intents when mappings change.
- `(slot, reporter_subject, submission_id)` identifies one request. The canonical Summary/Description digest identifies its body. Same key and body returns the existing resource; different body is `409`. Concurrent duplicate intake must not consume extra quota or leave orphan intents.
- One D1 transaction inserts the Support request and `create, seq=0` intent and debits new-submission quotas. Suppression, mapping, payload and quota checks precede durable acceptance; failure cannot leave a partial accepted request. Conditional SQL returning zero changed rows must not let dependent inserts proceed.
- A new acceptance returns `202` with the public request identity, `delivery: accepted-pending` and no Support status yet. The internal intent ID and GitHub identity are not browser fields. A same-key replay returns its current representation: `201` if delivered, `202` for other recorded outcomes, with `delivery` distinguishing pending, failed and unknown. Preserve the existing contract's `Location` on delivered responses.
- Confirmed non-acceptance means `503 gq_support_not_accepted`; an ambiguous D1 commit outcome requires a same-key primary lookup, then `504 gq_support_outcome_unknown` if still unresolved, never a false not-accepted claim; exceeded intake quota means `429` with retry guidance. Browser/WordPress timeout or malformed response means `504 gq_support_outcome_unknown` and same-key reconciliation, even if the service actually committed. A known service-side unknown outcome is a resource with `delivery: outcome-unknown`, not a fabricated transport failure.
- Preserve existing browser rules: frozen body and Submission ID on uncertain retries, at most three automatic checks while open, no automatic retry on `429`, and a new ID only after known failure/conflict. Unknown requests cannot be superseded as failed.

## Scheduling, ownership and fairness

Use narrow named D1 queries for cross-Slot scheduling; retain `storageFor(slot)` for scoped request access. Primary reads remain required. The scheduler chooses due work fairly across Slots sharing a GitHub App installation, rather than draining a busy Slot first; it must make bounded progress and preserve each request's intent order.

The active create permit is keyed by **GitHub App installation**, not WordPress installation or Slot. Multiple Slots may share that provider installation. Persist both the installation permit and per-intent claim with an opaque owner/generation, attempt identity, expiry and next-due time. Only the winning, current owner can authorize an outbound attempt or update its result. Every dependent write must check ownership; D1 batch success alone does not mean a conditional claim won. Extend the schema with a new forward migration, never by changing migration `0001`.

Record the attempt and mark the intent `in_flight` **before** issuing one GitHub POST. Do not use an HTTP retry wrapper on creates. Recheck repository safety, suppression, current permit, deadline and attempt ownership immediately before dispatch. Store only sanitized outcome classes. A crash after authorizing dispatch is uncertain even if the process might not have sent bytes.

Set finite HTTP timeouts and run delivery only in bounded post-response or scheduled execution. Establish the invocation execution deadline before acquiring ownership, so a delayed D1 claim response cannot start a POST after its permit could have drained. Recheck the deadline after every awaited claim/read and before dispatch. Do not recycle an installation permit into another active create while the previous execution can still begin its POST: the implementation must define and test its execution-drain bound, not just a short database lease. Expired intent claims become `outcome_unknown`; a stale owner cannot overwrite newer state. A verified late positive response may be handed to a separate conditional reconciliation path, never blindly committed by a stale owner.

Once that execution window has drained, another request may proceed while the uncertain request remains under review. An unknown request does not hold the whole installation indefinitely. Database fencing cannot cancel a GitHub server-side operation already underway; serialization is of service-authorized dispatch, not a promise of strict provider execution order or exactly-once effects.

Respect provider rate feedback and pace content-generating calls across the shared installation, including label/assignee repairs. Keep a conservative fleet budget below provider ceilings and test it against current GitHub limits before shipping. Provider throttling delays accepted work; it does not revoke acceptance. Preserve capacity for reconciliation and avoid one installation's failure starving unrelated installations.

### Initial intake quotas

Use atomic D1 counters, checked together with acceptance:

| Scope | Short window | Daily window |
|---|---:|---:|
| Reporter within a Slot | 5 per 10 minutes | 20 per day |
| WordPress installation / Slot | 20 per 10 minutes | 100 per day |

Daily means a rolling 24-hour window; re-enrollment must not reset Slot quotas. Same-key lookups do not debit new-submission quotas, but authentication/replay checks and bounded read/abuse limits still apply. Quota-store failure rejects new creates without claiming acceptance. These are starting limits: load-test them, quota atomicity and fleet fairness before implementation ships.

## State machine and retries

Public `delivery` maps `pending` and `in_flight` to `accepted-pending`, `outcome_unknown` to `outcome-unknown`, and the other terminal values directly. GitHub remains authoritative for `open`/`closed`; delivery failure must not synthesize Support status.

| From | Evidence | To / action |
|---|---|---|
| Unaccepted | Acceptance transaction commits | `pending`; return Received |
| `pending` | Current owner wins due claim and provider permit | `in_flight`; record attempt, one POST |
| `in_flight` | Valid create response and issue identity | `delivered`; persist identity and observed status |
| `in_flight` | Explicit retryable rejection proving no issue was created | `pending`; schedule retry |
| `in_flight` | Known terminal rejection | `failed`; alert on configuration/permission problems |
| `in_flight` | Timeout, reset, 5xx, malformed success, mutation redirect or abandoned claim | `outcome_unknown`; reconcile, no automatic POST |
| `outcome_unknown` | One verified match | `delivered`, or redact if erasure is outstanding |
| `outcome_unknown` | No match, incomplete scan or several matches | Remain unknown; follow review policy |
| `pending` | 24 hours since acceptance | `failed`; alert, preserve retained report |

Automatic create retries are allowed **only** after confirmed non-creation, not simply because an error looks temporary. Honour `Retry-After` and primary reset times; otherwise use bounded exponential backoff with jitter. Never retry inside the original create call. Stop automatic creates 24 hours from acceptance, including when a rate-limit delay falls beyond that deadline. An in-flight or uncertain attempt at the deadline stays uncertain until its outcome is known; the deadline cannot prove failure. Missing labels or assignees after successful creation are separate idempotent repair work, never another create.

For known configuration/permission rejection, suspend the mapping as appropriate, alert immediately and fail delivery. Re-enrollment/key revocation does not revoke previously accepted work; erasure, explicit delivery cancellation/offboarding and repository-safety checks do prevent new dispatch. The delivery implementation must distinguish those controls.

## Unknown outcomes and reconciliation

Use the original intent's first-line marker in the pinned repository. Require the App bot as creator and a plausible attempt time window; skip pull requests. List by creator, `state=all`, creation-descending, paginating back before the first attempt minus five minutes. Use persisted bounded scan progress if runtime/rate budgets prevent finishing. An incomplete, failed or rate-limited scan is never an absence result. The API's `since` uses updated time and is not the creation cutoff.

Schedule read-only reconciliation about 1, 5, 15 and 60 minutes after ambiguity is observed, then hourly through 24 hours, subject to provider delays and scheduler capacity. Alert after 15 minutes unresolved; a multiple match alerts immediately. At 24 hours stop automatic reconciliation for that attempt, retain `outcome-unknown` and hand off to an Operator. A later trusted positive observation may still resolve it. Execution-drain safety controls dispatch; it need not prevent read-only reconciliation.

- **One match:** validate repository identity, bot author, marker and time, then bind it conditionally to the request. An edited marker is a correlation hint, not authorization; a conflicting identity or suspicious match requires review.
- **Several matches:** retain ambiguity, record candidate identities for review, and never choose the lowest number automatically, close or delete issues.
- **No match:** continue the read schedule, then review. Negative lists do not prove absence: indexing/visibility, moving pagination, edits, transfers, deletion and delayed provider processing all matter. Do not issue another create automatically, even after two scans.

The service promises no blind repeat of an uncertain create, not exactly-once GitHub side effects. A repository collaborator can change the body of a bot-authored issue without changing its creator; bot filtering does not authenticate the marker. Detected inconsistencies require investigation.

## Operator recovery and alerts

Use the Operator's independent credentials, never a WordPress capability or installation key. Recovery is audited using opaque request/intent/attempt identities, actor, time, action and sanitized evidence; no report text, subjects, Submission IDs, credentials or response bodies enter logs.

1. Inspect the pinned mapping, attempt history, provider response classes and candidate issue identities.
2. For a verified existing issue, attach its identity conditionally, or redact it for an outstanding erasure. Multiple/conflicting candidates require explicit review; do not silently select one.
3. A failed request with confirmed non-creation can be resumed by an Operator with an explicit new bounded retry deadline and audit reason. Keep the same logical request and marker, revalidate safety/suppression and do not revive a superseded request. Browser resubmission of a failed request instead uses a new Submission ID under the existing supersession rules.
4. Unknown requests have no force-create action. Empty searches are insufficient evidence. They remain under review unless positive evidence resolves them or independently verified non-creation permits a reviewed transition; require all executions to have drained first.
5. Erased, superseded, offboarded or unsafe-mapped work cannot be resumed. A restore follows ADR 0016 before any traffic or dispatch.

Alert immediately for permission/configuration failures, multiple/conflicting matches and suppression failures; after 15 minutes for unresolved ambiguity; and when a known-undelivered request reaches its retry deadline. Group repeated alerts without hiding affected requests. Track oldest due age, pending count, failed count, unknown age, sweep success, claim conflicts and delivery latency. The operations ticket owns alert routing and rollout objectives; this decision does not authorize sending notifications now.

There is no DLQ in this slice. D1 failed/unknown records and the audited review/resume workflow are its recovery backlog. A poisoned record must be isolated and alerted so it cannot stop a sweep. If Queues are adopted later, queue retention, redrive authorization, dead-letter handling and suppression checks become release gates.

## Erasure, retention and restoration

Erasure stops new creates immediately. Allow an already-dispatched attempt to drain; purge service-held Summary, Description, derived title and optional context as soon as active execution no longer needs them. Keep only a restricted reconciliation/redaction record: opaque request and intent IDs, pinned repository/installation, attempt time and any discovered issue identities, suppression/erasure reference and progress. Remove Reporter subject, Submission ID and body digest when no longer needed for the erasure workflow; do not keep a content digest as a substitute for erased text.

If late discovery occurs after the original derived title and its digest have been purged, do not retain erased text merely to enable comparison: redact the known App-authored report body and require Operator review of the title when safe automatic title comparison is unavailable.

An empty marker scan does not complete erasure for an uncertain create. Keep erasure `needs_review` while the remote outcome is unresolved; if an issue is found, redact and report residual copies. Minimal unresolved reconciliation records remain until the remote outcome is resolved or an Operator records an explicit exception; the erasure remains incomplete. The ordinary 45-day tombstone compaction starts only after that reconciliation no longer needs the record, never while remote work remains outstanding. This exception is disclosed and tracked, not a claim of complete erasure.

Requests never confirmed delivered retain Submitted text for at most **12 months from acceptance**, unless erased sooner. Unknown requests reaching that limit lose their text and retain only the restricted review record needed to resolve the remote outcome. Confirmed delivered requests retain the existing 12-month-after-last-observed-close policy; open delivered requests remain retained. Offboarding retains its 30-day purge rule and does not redact the Client's GitHub issues, but must suppress dispatch and account for already uncertain attempts. Restore suppression precedes all sweeps; restored non-delivered intents become unknown, never pending for blind replay.

## Failure matrix and required verification

| Crash / failure boundary | Durable state | Recovery / assertion |
|---|---|---|
| Before or during acceptance transaction | None, or full committed request + intent + quota debit | Rollback is all-or-nothing; same-key retry discovers a committed result |
| After commit, before response or wake-up | `pending` | Browser checks same key; minute sweep finds work without browser activity |
| Concurrent same-key creates / quota boundary | One accepted request | Exactly one debit and intent; conflicting body gets 409; no over-limit acceptance |
| Claim loses / delayed claim response / batch UPDATE changes zero rows | Unchanged owner | No POST or dependent write by loser; a claim response received after the execution deadline cannot dispatch |
| After permit/attempt commit, before POST | `in_flight` | Expiry becomes unknown, even if no bytes were sent; no blind create |
| GitHub side effect before response / identity write | `in_flight` or unknown | Marker finds identity; empty/incomplete scan never licenses create |
| Success persisted, process crashes before wake-up finishes | `delivered` | Repeated sweep/re-POST returns known result, no create |
| D1 result write fails / stale callback / lease expires | Unknown, or newer generation | Reject stale state updates; drain execution before another dispatch; accept verified positive evidence through reconciliation |
| Provider throttles or explicitly rejects transiently | `pending`, known not created | Honour delay and 24-hour acceptance deadline; no tight loop |
| Mapping becomes public, archived, inaccessible or suspended | No authorized new POST | Safety check at dispatch; alert and honest failure |
| One Slot has a large backlog / poison record | Other eligible Slots remain due | Fair bounded scheduling; isolate bad record; shared-installation permit respected |
| Erasure races a scheduled, claimed or uncertain attempt | Suppressed + restricted cleanup work | No new create; drain, purge local text, find/redact issue; never report false completion |
| Restore reintroduces old intent | Unknown until reconciliation | Replay suppression/revocation before traffic; no duplicate or erased-text resurrection |

Run deterministic Worker tests with fake GitHub, controlled clock and injected failure points. Cover same/different Reporters and Slots using the same Submission ID; concurrent scheduler/wake-up execution; short and daily quota boundaries/outage; fairness and provider budgets; late provider completion; edited/missing/duplicate markers; shifted/incomplete pages; late success after 24 hours; failed resume, unknown resume refusal and erasure/offboarding races. Keep shared API fixtures and WordPress adapter/browser checks. Load-test starting quotas and dispatch pacing before release; retain packaged-plugin, security and privacy gates. No live Client reports or production credentials in untrusted CI.

## Implementation ownership

1. **Accept a plain-text Support request**: authenticated intake, atomic request/intent/quota acceptance and current-state replay; reuse the implemented WordPress adapter/form and shared fixtures.
2. **Deliver accepted Support requests to GitHub**: D1 scheduling, claims and installation permits, fairness, retry deadline, recovery controls and fault-injection tests.
3. **Create, repair and reconcile Support request issues**: provider operations used by the scheduler, marker verification, repairs and read-only reconciliation. Reuse **Build the GitHubGateway service in the Worker**; do not build a second delivery engine.
4. **Authenticate installations and enforce Worker resource scope**: trusted scope, request replay, shared atomic quota path and outage behavior; coordinate rather than duplicating quota accounting.
5. [Make delivery erasure and retention safe under unknown outcomes](https://github.com/Quick-Release/gq-support/issues/46) owns delivery cancellation, minimal unresolved records and retention boundaries; it is a production-data gate alongside the existing full privacy design. **Define per-client observability, safe rollout, updates, and recovery runbooks** owns rollout, alert integration and drills.

## Verified platform constraints and sources

Reviewed 2026-10-16 against official documentation:

- [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [result metadata](https://developers.cloudflare.com/d1/worker-api/return-object/): atomic batches and changed-row reporting; a zero-row conditional UPDATE is not a SQL error.
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): minute-granularity scheduling and bounded scheduled/post-response execution; no per-intent durability guarantee from a wake-up.
- [GitHub create/list issue API](https://docs.github.com/en/rest/issues/issues): no documented create idempotency key, provider fencing token or bounded negative-list proof.
- [GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api): serial requests, mutation pacing, rate feedback and pagination movement.
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/): at-least-once, unordered delivery would still require claims and reconciliation.
