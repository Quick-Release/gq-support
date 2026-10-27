# Discord incident route — disabled candidate for #20

This is a **proposed configuration and deduplication policy, pending review and
live verification**, not production readiness or permission to send messages.
The user selected Discord webhooks and vvaz or gmarques as incident/release
authority. No primary/backup ordering, acknowledgment/paging objective, private
contact, or deduplication policy has been approved. #20 and #29 remain open.
No webhook URL was supplied or accessed; all implementation tests use fake HTTP.

## Flow and containment

```text
existing Effect producer → exact-name/flag allowlist → invocation-local counts
  → independent admitted background persistence → existing SupportLedger D1
minute tick, after existing support phases → independent runtime + provider admission
  → one bounded Discord POST → confirmed / explicit rate rejection / blocked-unknown
```

This PR depends on #108 (`e6bb85217c96827bb51ec1759d771730649152bf`). Preserve its
fresh independent-ledger admission and restore epoch checks when integrating.
Both alert persistence and draining enter `contained`; the actual POST also
requires a fresh provider admission. Maintenance denial, ledger unavailability
or a SupportDB epoch mismatch prevents sending. No alert grants restore safety,
lifts containment, releases a suspension, or enables support delivery.

Alert state uses additive **ledger migration 0004**, not SupportDB, so restoring
SupportDB cannot rewind notification receipts or cooldowns. It is not mirrored
into SupportDB or involved in report replay. Never restore the ledger with the
main database. An uncertain POST retains a non-expiring provider obstruction;
a lost drain owner never expires. These can intentionally block restore/release
until an Operator investigates under the #108 recovery protocol. Do not delete
admissions to make a restore appear drained.

The request path only collects finite classes in memory. Persistence attaches
to `waitUntil`, after the support response is determined. Prompt delivery and
webhook refresh have separate collectors; the Cron captures existing phases.
Notification storage failures log only `Support alert state unavailable`; they
do not change an accepted report or create a delivery receipt. Persistence is
best effort: an interrupted wake-up can lose a one-shot notification; recurring
existing producers may recover it. No durable intake/notification atomicity is
claimed. The Cron drain adds at most one two-second HTTP timeout after existing
phase bounds (57 seconds); network retries never loop within an invocation.
There is no new queue, service, health polling, or WordPress page network call.

## Signals wired and gaps

Only names in `worker/src/discord-alerts.ts` are adapted; `alert: true` alone is
not an outbound notification. The adapter never serializes arbitrary log values.

| Existing producer | Routed observation |
| --- | --- |
| Signed webhook receiver `GitHub webhook rejected` | Rejections (currently receiver returns 401, including missing/invalid configuration). All rejection reasons aggregate; no raw request fields. |
| Delivery `Support delivery requires review` | Immediate permission and configuration flags, other conflict/review flags, 15-minute ambiguity, and 24-hour known-non-creation deadline. Exact known outcomes split permission/configuration/deadline/ambiguity classes; all other flagged outcomes remain `delivery_review`. Existing duplicate/conflict flags are retained, not a new duplicate detector. |
| Repository suspension and suspension write failure | Suspended mapping; failure to durably record it; safe verification requiring Operator lift. Verification is a review notice, never a recovery or automatic lift. |
| Status refresh | Existing global oldest-age threshold (one hour), retry attempt-five flag, tracking lost. A later explicit healthy **global refresh-age** observation alone can emit recovery for `refresh_lag`. |
| Status sweep | Existing one-hour lag flags, mapping/historical-installation conflict, per-repository failure. Aggregated per class across repositories; no automatic recovery based on one healthy repository. |
| Cleanup/retention | Existing review and isolated-step failure flags, including step `ledger` for mirror/compaction failure, plus whole cleanup phase failure. Step/reason strings are dropped. |
| Phase wrappers | Existing delivery/cleanup/refresh/sweep failures captured during the scheduled phases; prompt delivery timeout wrapper is outside its collector and remains logs-only. |

**Unwired:** webhook errors outside the receiver (wrong endpoint, runtime crash,
platform 5xx), outer scheduled-tick failure, denied admission/restore replay,
whole-platform/D1 failure, missing Cron, silent retention backlog, arbitrary
authentication rejection, deploy/preflight/migration failures, and acknowledgment
or escalation. The outer tick and prompt wrapper names are allowlisted for
future scoped capture but are outside today's collectors. Failures of the
alert adapter itself remain constant logs only, avoiding recursive alerts.

Deploy failure notification cannot safely use this Worker/D1 drain when the
candidate failed to deploy. #109 also intentionally blocks every apply pending
a real safe plan/Test F and configured reviewers. This PR only adds optional
secret/variable inputs to the existing deploy step; reconcile those two lines
with #109 without removing any of its gates. No CI Discord sender or alternative
provider is added. External observation of deployment failure, receiver 5xx,
missing Cron and route failure remains an explicit readiness gap. Cron cannot
prove its own absence. No per-page or self-monitoring call closes that gap.

## Proposed bounded incident policy

- Key: this stage's independent database plus finite event class (24 possible
  classes today). No request, Reporter, Client, repository or contact dimension.
  Different problems in the same class aggregate and can be hidden by this
  coarse deduplication; Operators still need restricted source logs. This is a
  minimal routing proposal, not an approved escalation policy.
- First observation opens a version, with first/last milliseconds and count
  saturated at 999,999. Repeats update state without another message. The first
  message's count is a snapshot; there is no periodic reminder or edit.
- Only explicit healthy global refresh age changes `refresh_lag` to recovery.
  A recurrence opens a new version. Other classes have no automatic recovery;
  silence/expiry must never be described as resolution. A recovery observation
  can supersede an unsent incident; it asserts observed health, not prior receipt.
- A tick atomically reserves a singleton drain slot. At most one POST per minute
  across isolates; ordering is oldest first and then class. This bounds traffic,
  not latency; it is not a Discord quota or paging objective.
- `wait=true` requests server confirmation; only 200 marks that version sent.
  No message body or ID is consumed or retained. This is not human acknowledgment.
  `allowed_mentions: {parse: []}` is mandatory; no embeds, user fields or links.
- Retry **only** a 429 rejection with a valid numeric `Retry-After` header in
  seconds (fractional allowed), no earlier than its deadline or the local minute
  bound. Exhausted-bucket responses also honor `X-RateLimit-Reset-After`.
  Three POST attempts per state version maximum. Exhaustion leaves it unsent
  until explicit state change/expiry; it does not assert receipt. There is no
  hard-coded Discord per-route quota. Body-only/malformed rate responses block
  the route; the documented header alternative is the supported subset.
- Timeout/transport, 5xx, unexpected 2xx, redirects and other unsupported responses
  block the route with no automatic retry. Unknown delivery retains provider
  admission; known 400/401/403/404/429 can retire admission. Route health cannot
  notify over its failed route. Inspect it through independent Operator access.
- Rows expire after **seven quiet days**, during an admitted configured drain.
  Active recurring rows stay bounded by the finite class set. The same condition
  after expiry can open again. This bounds local state, not Discord history.
  Disable/outage/containment delays cleanup; no deletion falsely proves recovery.

## Payload, secrets and tracing

The allowlist contains stage (`staging`/`prod`), reviewed 40-hex release (or an
explicit `unrecorded` label), fixed event class, bounded count and integer times.
There is no arbitrary operational correlation in the payload: class/stage/release
are enough for this slice. Submitted text/context, Reporter subject/hash,
Submission/Change ID, nonce, token, cookie/header, provider body, unrestricted URL
and Client contacts are excluded. The Discord URL is a credential, never a log
or error value. Only canonical `https://discord.com/api/webhooks/<id>/<token>` is
accepted; custom hosts, user info, explicit ports, query, fragment, escaped paths,
API-version variants, forum/thread options and redirects fail closed. Workers
uses `redirect: manual`; Node custody calls use `error`.

**Review the tracing tradeoff:** automatic Cloudflare outbound fetch spans contain
`url.full` and `url.path`; query redaction cannot protect a credential in a path.
The candidate disables automatic Worker traces while retaining structured Logs.
This intentionally departs from the general workers-best-practices tracing
recommendation for secret custody. Before secret upload the apply-only provider
reads settings and refuses enabled/unknown trace configuration. The post-apply
custody audit also checks traces disabled, `secret_text` without `text`, state,
bundle and local logs/files for the exact URL/token. It prints no credential.
External setting drift, debugger/network capture and third-party log destinations
still require access review. Never enable HTTP debug logging. No live custody
or effective retention verification has occurred.

Alternatives if disabling traces is unacceptable: retain this feature disabled
until Cloudflare offers verified per-fetch suppression/path redaction; or approve
a separate isolated sender design. No such sender is provisioned here. Do not
solve this by exposing a URL credential to automatic traces.

## Private provisioning and scoped drill — parent only after review

1. Review the concrete PR, tracing tradeoff, proposed class dedup/expiry/recovery,
   route ownership and independent observation gaps with vvaz or gmarques.
   Preserve managed Composer/tested ZIP upgrades, enrolled v1 until verified
   upgrades, additive v1 and expand-only migrations. No implicit rollout approval.
2. Parent requests the URL through **T3 `request_secret`**, never chat. Select
   the existing authorized Discord incident channel/webhook and access policy;
   do not invent a channel, responder order or contact. No child secret request.
   Keep values out of prompts, CLI arguments, plaintext repo files and artifacts.
3. With separately authorized configuration work, put it in the intended GitHub
   Environment encrypted secret `SUPPORT_DISCORD_ALERT_WEBHOOK_URL`. Its variable
   `SUPPORT_DISCORD_ALERTS_ENABLED` remains absent/false until enablement approval.
   The deploy step injects these as `DISCORD_ALERT_WEBHOOK_URL` and
   `DISCORD_ALERTS_ENABLED`; `GITHUB_SHA` supplies the revision. No value enters
   Alchemy resource props/outputs: the existing apply-only App-secret provider
   installs `secret_text` after the owning Worker and enables last. Disabled
   deployment removes URL/revision bindings and sets enabled false.
4. #109's safe-plan/Test F/reviewer gates and explicit production-rollout approval
   still apply. This candidate authorizes no deploy. Apply additive ledger
   migration before code; do not roll back the ledger schema. Verify disabled
   operation and containment first. Record only names, revision, counts and outcomes.
5. Separately authorize one synthetic staging **notification** drill (no real
   report data). Enable only staging; run a reviewed signed synthetic webhook
   rejection or controlled 15-minute ambiguity case. Confirm one allowlisted
   message and human acknowledgment privately, duplicate suppression, and global
   refresh recovery only when that actual condition is restored. #57's `break`
   changes the App secret and needs its own explicit authorization and restoration
   procedure; it proves receiver 401, not platform 5xx or missing-Cron observation.
6. Abort on secret exposure, unexpected channel/message/mentions, unknown send,
   containment interference or accepted-report regression. Disable the route;
   revoke/delete the Discord webhook in its authorized administration surface
   if exposure is suspected. A variable change alone does not change a running
   Worker; revocation at Discord stops it immediately. Replacement requires a
   fresh privately supplied credential and separately approved deployment.
7. Clean up synthetic reports under existing cleanup policy and the drill's
   Discord messages using authorized access. The adapter does not retain message
   IDs or automate deletion. Discord channel history/access/retention is a new
   operational-data destination requiring private review. Do not claim local
   seven-day expiry removes Discord copies. Record sanitized receipt/ack/outcome
   evidence and leave #20/#29 open until their other gates are met.

For a blocked route/lost owner, inspect only counts/classes/times and operation
IDs through independent Operator tooling. Do not blindly reset `blocked`, clear
an owner or delete provider admissions; this slice deliberately adds no remote
unblock/replay API. Review channel-side outcomes and #108 obstructions first;
prepare any repair as a separately authorized, audited Operator operation.

## Evidence and sources

Local fake-HTTP tests use real workerd D1 migrations/admissions, real webhook
rejection and delivery permission/deadline/ambiguity producers, payload canaries,
concurrent drains, recovery, expiry/count bounds, redirects/SSRF, rate limiting,
uncertain delivery and custody failure. They are not live Discord verification.

Primary docs checked 2026-10-27 against installed Workers types
`5.20260916.1`, Wrangler `4.133.0`, Alchemy `2.0.0-beta.83`, and existing
compatibility date `2026-10-17`:

- [Discord execute webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook): wait confirmation, 200/204 distinction, content 2000 limit and allowed mentions.
- [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits): dynamic buckets and Retry-After seconds/header alternative.
- [Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/): manual redirects; `error` mode unsupported in Workers.
- [Workers context](https://developers.cloudflare.com/workers/runtime-apis/context/): waitUntil shared 30-second post-response lifetime, not guaranteed execution.
- [Workers automatic span attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/): outbound url.full/path/query exposure.
- [Script settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/): deployed observability metadata for custody checks.
