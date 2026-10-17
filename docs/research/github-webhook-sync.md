# GitHub webhook synchronization of Support status

- **Research target:** GitHub issue [#12](https://github.com/Quick-Release/gq-support/issues/12)
- **Status:** Recommended design for the Worker's webhook receiver, status projection refresh, and missed-delivery recovery. Not implemented.
- **Access date:** 2026-10-17. Every GitHub and Cloudflare fact below was read on this date. Re-check before relying on them.
- **Inputs:** [CONTEXT.md](../../CONTEXT.md), [ADR 0003](../adr/0003-durable-acceptance-separates-delivery-from-status.md), [ADR 0006](../adr/0006-ordered-reconciliation-of-support-mutations.md), [ADR 0009](../adr/0009-project-repository-intake-and-reporter-scoped-projection.md), [ADR 0010](../adr/0010-installation-scoped-attestation-not-cross-site-identity.md), [ADR 0013](../adr/0013-shared-cloudflare-resources-per-stage.md), [ADR 0015](../adr/0015-reporters-see-submitted-text-and-projected-status.md), [ADR 0016](../adr/0016-restores-never-rewind-revocations-or-deliveries.md), [ADR 0019](../adr/0019-uncertain-creates-require-review.md), [support storage design](../support-storage-design.md), [support delivery design](../support-delivery-design.md), [support security design](../support-security-design.md), [support privacy design](../support-privacy-design.md), [support domain design](../support-domain-design.md), [support API contract](../support-api-contract.md), [GitHub App research](github-app-issue-integration.md)

GitHub facts are cited to docs.github.com, or to GitHub's published OpenAPI description where the docs page omits payload detail. Cloudflare facts are cited to developers.cloudflare.com, or to the `workerd` runtime source. Anything marked **verify in spike** is an inference that the first implementation slice must confirm against a real App and test repository.

## Scope against accepted decisions

Issue #12 was written before ADR 0009, ADR 0015, the storage design and the delivery design were accepted. Those decisions are fixed inputs here. Where the issue text conflicts with them, this note follows the accepted decision and says so.

| Issue #12 premise | Accepted decision | What this note does |
|---|---|---|
| "Reflect approved GitHub replies" in WordPress; E2E "engineer publishes an approved reply → client sees it" | GitHub comments are internal and never projected ([ADR 0009](../adr/0009-project-repository-intake-and-reporter-scoped-projection.md), [CONTEXT.md](../../CONTEXT.md) "Support request"). Reporters see Submitted text and open/closed status only ([ADR 0015](../adr/0015-reporters-see-submitted-text-and-projected-status.md)). The API has no reply route ([API contract](../support-api-contract.md)). ADR 0007's conversation model is superseded. | Scope is **status projection plus routing and revocation events**. The E2E scenario becomes "engineer closes the issue → the Reporter sees Closed on refresh → nothing is written back to GitHub". A reviewed-reply mechanism is described only as a deferred option that needs a new ADR. |
| Subscribe to "issue/comment lifecycle events" | `issue_comment` is explicitly not subscribed ([GitHub App research](github-app-issue-integration.md#permissions-and-event-matrix)). | Kept: no `issue_comment`. |
| "Durably record/accept valid deliveries" in an inbox; delivery-ID dedup with received/processing/failed/completed | "There is no webhook inbox: deliveries are not stored." Webhook handling is fetch-and-overwrite, so duplicates and reordering do no harm, and correctness never depends on a webhook arriving ([storage design](../support-storage-design.md#invariants-for-11-and-12), invariant 5). | The durable record is a **per-target refresh obligation** (one column on the existing row), not a per-delivery inbox. The four states map onto it. Redeliveries are never discarded, because nothing is keyed by delivery ID. |
| "Process heavier work through the selected durable mechanism" ([Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) cited) | Queues and a DLQ are deferred. D1 is the durable record and a once-per-minute Cron sweep is the backstop ([delivery design](../support-delivery-design.md#decision-and-scope)). Durable Objects and KV stay rejected (ADR 0013, storage design). | Uses `waitUntil()` for prompt work plus the existing minute Cron for recovery. No Queue. |
| "Visibility tests … previews, notifications, attachment links" | None of these exist in the MVP. The resource has no comment, label, assignee or repository fields ([API contract](../support-api-contract.md#resource)). | Visibility tests prove that nothing from a webhook payload except a re-fetched open/closed value can reach a Reporter response. |
| "Invalidate only relevant tenant/site/user caches" | WordPress keeps no transient or object cache, and every response is `private, no-store` ([API contract](../support-api-contract.md)). The only projection is the D1 row. | Invalidation is the conditional overwrite of that one row. |
| "Start the widget with refresh-on-open/manual refresh" | Already decided: load on first show of My requests and on the refresh button; no polling; nothing runs while closed ([domain design](../support-domain-design.md#reporter-experience)). | Kept unchanged. No new browser behaviour. |

Map issue #1 already restates #12 as "secure status synchronization and recovery; GitHub comments remain internal". This note answers that restated scope.

## Recommendation

1. **Endpoint.** One `POST` route on the existing shared Worker, outside the Ed25519 installation-auth path. It accepts only `application/json`, caps the body (1 MB, measured in the spike), and verifies `X-Hub-Signature-256` over the raw request bytes **before** parsing JSON or touching D1.
2. **Signature.** Import the webhook secret as an HMAC SHA-256 key and call `crypto.subtle.verify("HMAC", key, sigBytes, rawBody)`. The Web Crypto spec requires that comparison to be constant-time, and `workerd` implements it with `CRYPTO_memcmp`. Accept a second "previous" secret only during a bounded rotation window.
3. **Subscriptions.** Keep the #8 matrix: `issues`, `repository`, `public`, plus the default `installation` and `installation_repositories`, and `installation_target`. No `issue_comment`. Act on `issues` actions `closed`, `reopened`, `transferred` and `deleted` only. Every other action gets a 2xx and no write.
4. **Routing.** Route only by numeric IDs. The payload's `repository.id` must be a mapped `repository_id`, and `installation.id` must be that mapping's pinned GitHub App installation. Rows are found by `(repository_id, issue_id)`. Anything unmapped or unknown is acknowledged and dropped. No webhook ever creates a row.
5. **Durability before ack.** For a matching `issues` event, one conditional D1 `UPDATE` marks that row's status as due for refresh, then the handler returns `202`. Fail-closed lifecycle events (publicized, deleted, removed, suspended, archived) write the suspension in the same request before returning `2xx`. If D1 fails, return `503`, so GitHub records a failed delivery and recovery can find it.
6. **Processing.** A `waitUntil()` task re-fetches the issue with `If-None-Match` and overwrites the projection, guarded by GitHub's `updated_at` so an older fetch can never overwrite a newer one. The payload's own state is never written. If the task does not finish, the minute Cron picks up the due row.
7. **No echo.** Webhook handlers never call a mutating GitHub endpoint. The App's own events (`opened`, `labeled`, `assigned`, redaction `edited`) therefore cannot loop.
8. **Recovery.** Correctness comes from the periodic per-repository sweep ADR 0015 already requires. This note sets it at every 15 minutes, plus a bounded daily re-check of open rows to catch deletions and transfers. A scheduled delivery-log check (`GET /app/hook/deliveries`, JWT) detects missed deliveries in GitHub's 3-day window and turns them into targeted sweeps and mapping verifications. It does not redeliver them. Redelivery stays an audited Operator tool.
9. **Freshness targets.** Normally within about two minutes of the GitHub change. Without a webhook, within one sweep interval (about 17 minutes). Deletions and transfers without a webhook, within 24 hours. These are measured service objectives, not promises, and the API contract does not change.

## Event and action matrix

Sources: [webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps), [GitHub App research](github-app-issue-integration.md#permissions-and-event-matrix).

GitHub subscriptions are per event, not per action. The `issues` event lists 20 actions (`assigned`, `closed`, `deleted`, `demilestoned`, `edited`, `field_added`, `field_removed`, `labeled`, `locked`, `milestoned`, `opened`, `pinned`, `reopened`, `transferred`, `typed`, `unassigned`, `unlabeled`, `unlocked`, `unpinned`, `untyped`), and "a GitHub App must have at least read-level access for the "Issues" repository permission" to subscribe ([source](https://docs.github.com/en/webhooks/webhook-events-and-payloads#issues)). Project repositories also hold engineering issues (ADR 0009). The Worker will therefore receive every issue event in every mapped repository, and must filter cheaply.

| Event | Actions acted on | Handling | Permission / availability |
|---|---|---|---|
| `issues` | `closed`, `reopened` | Mark row due; re-fetch; overwrite status | Issues: read |
| `issues` | `transferred` | Mark row due; re-fetch follows the 301; see lifecycle table | Issues: read |
| `issues` | `deleted` | Mark row due; re-fetch expects 410; `closed` + `tracking = lost` + alert | Issues: read |
| `issues` | `opened` by the App bot | Optional hint: bring forward reconciliation of `outcome_unknown` intents in that repository. Never binds an identity from the payload | Issues: read |
| `issues` | all others (`edited`, `labeled`, `assigned`, …) | `204`, no D1 access. The Reporter never sees edits (ADR 0015). Erasure checks for retitles with its own GET at erasure time ([privacy design](../support-privacy-design.md)) | — |
| `repository` | `publicized`, `deleted`, `archived`, `transferred` | Fail closed now: write `repository_state.suspended_reason`, alert, schedule verification | Metadata: read ([source](https://docs.github.com/en/webhooks/webhook-events-and-payloads#repository)) |
| `repository` | `privatized`, `unarchived` | Schedule verification only. Never resume from the payload | Metadata: read |
| `repository` | `renamed`, `edited`, `created` | `204`. Names come from each token mint response, and mappings are code | Metadata: read |
| `public` | (no action field) | Same as `publicized` | Metadata: read ([source](https://docs.github.com/en/webhooks/webhook-events-and-payloads#public)) |
| `installation` | `deleted`, `suspend` | Fail closed for every mapped repository on that installation | "All GitHub Apps receive this event by default" ([source](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation)) |
| `installation` | `unsuspend`, `new_permissions_accepted` | Schedule verification of that installation's mappings | default |
| `installation` | `created` | `204`, log. Mappings are approved by reviewed code, not by installation | default |
| `installation_repositories` | `removed` | Fail closed for each mapped `repositories_removed[].id` | "All GitHub Apps receive this event by default" ([source](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation_repositories)) |
| `installation_repositories` | `added` | Schedule verification for mapped `repositories_added[].id` | default |
| `installation_target` | `renamed` | `204`, log. Owner names are refreshed from mint responses | Not stated; see spike list |
| `issue_comment` | — | **Not subscribed.** If it ever arrives, `204` and no write | Issues: read |

Note for #36: the #8 matrix says `installation_target` is "always delivered". The events page says "All GitHub Apps receive this event by default" for `installation` and `installation_repositories`, but not for `installation_target` ([source](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation_target)). **Verify in spike** whether it must be selected at registration. Nothing depends on it, because names are never used for identity.

Note: the #8 matrix also lists `issues.edited` "for status projection freshness". An edit does not change open/closed, and ADR 0015 forbids showing edits, so it is not acted on. This narrows #8's list. It does not reopen it.

## Receiver and signature validation

Facts:

- The signature is in `X-Hub-Signature-256`, "an HMAC hex digest", always prefixed `sha256=`. `X-Hub-Signature` is SHA-1 and "only included for legacy purposes" ([validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)).
- It is "the HMAC hex digest of the request body", keyed with the secret ([delivery headers](https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers)). Payloads must not be modified before verification, and should be handled as UTF-8 ([troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)).
- "Never use a plain `==` operator"; use a constant-time comparison ([validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)).
- GitHub's published test vector: secret `It's a Secret to Everybody`, payload `Hello, World!`, signature `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17` ([same page](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)).
- Workers support HMAC `sign`, `verify` and `importKey` ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)). The W3C spec for HMAC verify says "Return true if mac is equal to signature … This comparison must be performed in constant-time" ([W3C Web Crypto](https://w3c.github.io/webcrypto/#hmac-operations-verify)). `workerd` implements HMAC verify as a length check followed by `CRYPTO_memcmp` ([source at `1568dcf`](https://github.com/cloudflare/workerd/blob/1568dcf0a34da009f0a5c86b31d3a7f832ede97e/src/workerd/api/crypto/digest.c++#L47-L54)).
- Cloudflare's alternative, `crypto.subtle.timingSafeEqual`, needs equal-length buffers ("otherwise an exception is thrown") and is "not constant time with respect to the length of the parameters" ([timing-attack example](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/)).

Design, in order:

1. Accept only `POST` on the fixed path. Reject a `Content-Type` other than `application/json`; register the App with JSON delivery. Reject a missing or oversized `Content-Length`, and also count bytes while reading, because the header can lie. GitHub payloads can reach 25 MB ([payload cap](https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap)). The cap here is lower, because the events used are small and a rejected large delivery is still repaired from the delivery log (see Missed deliveries). **Verify in spike** the largest real `installation` and `issues` payloads.
2. Require `X-GitHub-Event`, `X-GitHub-Delivery` and `X-Hub-Signature-256` matching `^sha256=[0-9a-f]{64}$`. Hex-decode it to exactly 32 bytes. Because the length is fixed before comparison, no timing leak comes from length.
3. Read the body once as bytes from the Web `Request` (`arrayBuffer()`). Do not let a framework parse, re-encode or normalize it first. The current Worker converts Effect's request with `HttpServerRequest.toWebResult` ([`worker/src/worker.ts`](../../worker/src/worker.ts)); **verify in spike** that the body reaching the handler is byte-identical (GitHub's test vector plus a non-ASCII payload).
4. `crypto.subtle.verify("HMAC", currentKey, sig, body)`. If that fails and a `previous` secret is configured, try it. Keys are imported once per isolate from Alchemy-managed Worker secrets, never from D1.
5. On failure return `401` with an empty body. Log only a sanitized reason class and a count. Do not touch D1 before this point, so unauthenticated traffic costs CPU only.
6. After verification, parse JSON. Check `X-GitHub-Hook-Installation-Target-ID` equals this stage's App ID. That catches a staging App pointed at production. **Verify in spike** the exact header values for App webhooks.
7. Allowlist `(event, action)` from the matrix. Anything else returns `204`.

Secret handling: GitHub says use "a random string of text with high entropy" and store it securely ([using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)). The secret is an Alchemy-managed Worker secret alongside the App private key, never logged, never in D1 or WordPress (#8 acceptance criterion 3). An App registration has one webhook secret and one webhook URL, so each stage needs its own App registration (#36). Rotation: set `WEBHOOK_SECRET_PREVIOUS` to the old value, change the secret in the App settings, then remove the previous value after the 3-day redelivery window. **Verify in spike** whether a redelivery of a pre-rotation delivery is signed with the old or the new secret.

Replay: GitHub suggests `X-GitHub-Delivery` against replay attacks ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)). Here a replayed valid delivery can at most trigger a re-fetch, or repeat a fail-closed suspension that an Operator must clear. It cannot make a Reporter see something false, because no payload state is written. Storing delivery IDs would contradict the storage decision for no safety gain, so it is not done. An IP allowlist is optional hardening GitHub mentions ([same page](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)); it is not relied on.

## Tenant routing

- Use numeric IDs only. GitHub: "If you store references to repositories … use their `id`" and "*Never* use identifiers that can change over time" ([App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)).
- `installation` is included "when the event is configured for and sent to a GitHub App", and `repository` is included for repository activity ([common properties](https://docs.github.com/en/webhooks/webhook-events-and-payloads)). In the OpenAPI schemas, `installation` is optional on `issues.*` and `repository.*` payloads and required on `installation.*` and `installation_repositories.*` ([OpenAPI description at `0fa95c5`](https://github.com/github/rest-api-description/blob/0fa95c50cd6fc3d5f736a54f49d9195b4cb139bb/descriptions/api.github.com/api.github.com.json), schemas `webhook-issues-closed`, `webhook-installation-deleted`). A repository-activity delivery without `installation.id` is dropped and counted.
- Step 1, in memory: `repository.id` must appear in the reviewed mapping code. Its pinned GitHub App installation must equal `installation.id`. Mappings are code ([storage design](../support-storage-design.md#decision)). Today `RepositoryMapping` holds `repositoryId` but no GitHub installation ID ([`worker/src/repository-mappings.ts`](../../worker/src/repository-mappings.ts)). The delivery design already requires pinning the provider installation, so #36/#39 add that field.
- Step 2, cheap pre-filter for `issues`: the action is in the acted-on set, and `issue.user` is the App bot. Engineering issues stop here without a D1 query. This is filtering, not authorization. **Verify in spike** the bot's `login` and `id`.
- Step 3, D1: the named cross-Slot query `WHERE repository_id = ? AND issue_id = ?` uses the unique `support_request_issue` index. No row means drop. That covers erased requests, issues the App did not create, and a create whose identity is not yet bound ([privacy design](../support-privacy-design.md): "They never create a row").
- Production and staging Slots can share one repository. `repository_state` is keyed by repository, so a suspension applies to every Slot on it. Each issue still maps to at most one request.
- Cross-tenant tests: the same issue number in two repositories; a mapped repository ID arriving with another installation's ID; an unmapped repository on the same installation (an "all repositories" install); a payload naming a transfer target in another Client's repository.

## Durable acceptance and the refresh state machine

GitHub: "respond with a 2XX response within 10 seconds", and process asynchronously ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)). After 10 seconds "GitHub terminates the connection and considers the delivery a failure"; a 4xx or 5xx is also recorded as a failure ([troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks#timed-out)). Workers: `waitUntil()` "can extend execution for up to 30 seconds after the response is sent"; unsettled promises "are canceled"; it is not for durable work ([context](https://developers.cloudflare.com/workers/runtime-apis/context/)). Cron Triggers run as often as every minute, in UTC ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)), with a 15-minute maximum wall time per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/)).

The request does one short D1 write and no GitHub call. That keeps it well inside 10 seconds and makes the 2xx mean "durably recorded".

Forward migration (never edit `0001`), additive only:

- `support_request.status_refresh_due_at`: set by a webhook or sweep, cleared by a successful fetch.
- `support_request.status_refresh_attempts`: for bounded backoff and alerting.
- `support_request.status_source_updated_at`: GitHub's `issue.updated_at` from the last applied fetch.
- `repository_state.verify_due_at`, and `suspended_at` for alert age.
- A single-row `webhook_delivery_check` with the delivery-log checkpoint (see Missed deliveries).

These are rebuildable, target-keyed obligations, not stored deliveries. They hold no payload, no delivery ID, and no Reporter content.

| Issue #12 state | Here | Transition |
|---|---|---|
| received | `status_refresh_due_at` set | Webhook, sweep, or delivery-log repair: `UPDATE … SET status_refresh_due_at = COALESCE(status_refresh_due_at, now)`. Repeats coalesce into one obligation that keeps the earliest due time |
| processing | `waitUntil()` task or Cron claims the due row | No lease needed: the work is one idempotent conditional GET, and concurrent runs are harmless because the write is guarded (next section) |
| completed | `status_refresh_due_at` cleared | Conditional on the due value read at claim time, so a newer webhook that arrived during the fetch is not lost |
| failed | Still due, `status_refresh_attempts` + 1, next try with jittered backoff | Retryable: 5xx, timeout, 403/429 rate limit (honour `retry-after` / `x-ratelimit-reset`). Alert after repeated failures. Terminal: 404/410 → lifecycle table |

"A redelivery of a failed event must not be discarded merely because its ID was seen" holds by construction: nothing is keyed by delivery ID, so a redelivery always sets the obligation again. Explicit redeliveries keep the same `X-GitHub-Delivery` ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)); the GUID is logged for correlation only.

Fail-closed lifecycle events are applied in the request itself: one `UPSERT` into `repository_state` setting `suspended_reason` and `verify_due_at`, before the `2xx`. Suspension needs no fetch, and the delivery path re-checks repository safety before every POST anyway ([delivery design](../support-delivery-design.md#scheduling-ownership-and-fairness)). If the write fails, return `503`.

The Cron already runs every minute for delivery. The same handler drains due refreshes and verifications with a per-invocation bound and fair ordering across repositories. It also runs the sweeps and the delivery-log check on their own cadence. No extra Cron Trigger or Queue is needed. Revisit Queues if measured webhook volume, due-row age or Cron duration requires it, the same trigger the delivery design uses.

## Ordering, staleness and when to refetch

- "GitHub may deliver webhooks in a different order than the order in which the events took place", and "Webhook deliveries can take a few minutes to be delivered" ([troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks#webhooks-deliveries-are-out-of-order)).
- **Always refetch, never apply.** Every `issues` event only marks the row due (ADR 0015: webhooks "are treated as hints that trigger a fetch"). The fetch is `GET /repos/{o}/{r}/issues/{number}` with `If-None-Match`. A `304` "does not count against your primary rate limit" ([conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)).
- **Monotonic write guard.** Two fetches can finish in reverse order. Write `status`, `status_etag`, `status_observed_at`, `status_source_updated_at` only `WHERE status_source_updated_at IS NULL OR status_source_updated_at <= ?fetched_updated_at`. A `304` refreshes `status_observed_at` only. **Verify in spike** that close and reopen always advance `updated_at` and that it is at second resolution or finer.
- **Late and duplicate events** set the obligation again and cost one conditional GET.
- **Events before the identity is bound.** A close can arrive while the create is `in_flight` or `outcome_unknown`, or before the identity write commits. The row lookup misses and the event is dropped. The delivered transition records the state from the create response, and reconciliation records the `state` returned in the list item. The next sweep catches a change that happened in between. Freshness for this case is the sweep bound.
- **Edits and deletions of comments** are not received and not relevant. Issue edits are ignored (ADR 0015).
- **Close/reopen flapping** converges on the final GitHub state once the last fetch lands, because of the guard.

## The App's own events and echo avoidance

- The App's own writes produce events: create (`opened`), label and assignee repair (`labeled`, `assigned`), and ADR 0018 redaction (`edited`). The `sender` "may be the `ghost` placeholder" and "Don't assume `sender` always identifies the person who caused an event" ([sender property](https://docs.github.com/en/webhooks/webhook-events-and-payloads)). So echo handling must not depend on `sender`.
- **Invariant:** the webhook and sweep code paths never call a mutating GitHub endpoint. Enforce it structurally: the gateway methods they receive are read-only (`readIssue`, `listIssuesSince`, `verifyMapping`, `listDeliveries`). A test asserts that no `POST`, `PATCH`, `PUT` or `DELETE` happens while processing any fixture. With no writes there is no loop, whatever the event.
- `issues.opened` from the bot may expedite read-only reconciliation of `outcome_unknown` intents in that repository. It is a scheduling hint only. Binding an identity still goes through the marker, creator and time-window checks in the [delivery design](../support-delivery-design.md#unknown-outcomes-and-reconciliation). A forged or copied marker in a payload gains nothing.

## Issue and repository lifecycle

This extends the [#8 lifecycle table](github-app-issue-integration.md#lifecycle-cases-and-safe-responses) with the webhook-side detail. Reporter-visible results are unchanged from #8 and the storage design.

| Case | Webhook signal | Confirmation | Result |
|---|---|---|---|
| Issue closed / reopened | `issues.closed` / `reopened` | Conditional GET | Status overwritten under the guard |
| Issue transferred | `issues.transferred`. The schema has required `changes.new_issue` and `changes.new_repository` ([OpenAPI](https://github.com/github/rest-api-description/blob/0fa95c50cd6fc3d5f736a54f49d9195b4cb139bb/descriptions/api.github.com/api.github.com.json), `webhook-issues-transferred`) | GET old issue: "301 Moved Permanently … if the issue was transferred" ([get an issue](https://docs.github.com/en/rest/issues/issues#get-an-issue)) | If the new `repository_id` is mapped to the **same Client**, mint a token for it and move the row's `(repository_id, issue_id, issue_number)` conditionally. Otherwise `closed`, `tracking = lost`, alert. The payload's `new_repository` is a hint, never authority. **Verify in spike** what a token scoped to the old repository gets from the 301, and whether the issue `id` changes on transfer. |
| Issue deleted | `issues.deleted` | GET → 410 "if the issue was deleted" ([same](https://docs.github.com/en/rest/issues/issues#get-an-issue)) | `closed`, `tracking = lost`, alert. Never recreated |
| Repository renamed / owner renamed | `repository.renamed`, `installation_target.renamed` | Next mint returns the current `full_name` | No D1 write. Identity is unchanged |
| Repository publicized / `public` | Both | Not needed to suspend | `suspended_reason = public`, alert, pending creates stay unsent. Only an Operator resumes, after a Client decision (#8) |
| Repository privatized | `repository.privatized` | Verification | Does **not** resume. Report "verified private" to the Operator |
| Repository archived / unarchived | `repository.archived` / `unarchived` | Verification | Suspend writes on `archived`. On `unarchived`, verify and let the Operator resume. Reads keep serving the last projection |
| Repository transferred | `repository.transferred` | Mint by `repository_id` on the pinned installation | Still accessible on the same installation: no change. Otherwise `no_access`, Operator re-approval (#8) |
| Repository deleted | `repository.deleted` | Mint/GET → 404 | `no_access`, alert. Do not mark Reporter rows closed automatically, because a 404 can also mean lost access ([REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)). The Operator decides |
| Visibility changed to `internal` | Unknown | Mint/GET `private` flag | Write-time guard fails closed. **Verify in spike** which event, if any, fires |

## Installation removal and suspension

- `installation.deleted` / `suspend` and `installation_repositories.removed` set `no_access` on every affected mapped repository, in the request. Known-unsent accepted intents follow the #8 and delivery rules: `failed` with an alert. Uncertain creates stay `outcome-unknown`, and delivered requests keep their last projection.
- Either the App owner (or app managers) or the installing account owner can suspend an installation, and "A GitHub App must be unsuspended in the same way it was suspended" ([suspending an installation](https://docs.github.com/en/apps/maintaining-github-apps/suspending-a-github-app-installation)). A suspended installation cannot mint tokens. Whether a suspended installation still receives webhooks is not documented: **verify in spike**. The design does not depend on it.
- `unsuspend`, `added` and `new_permissions_accepted` only schedule verification: a scoped mint, the repository `private` and `archived` checks, and `GET /repos/{o}/{r}/installation` matching the pinned installation (#8). A passing verification is reported to the Operator, who resumes with one audited CLI action (#41). This mirrors the operator-only resume for `public` and keeps one rule for every suspension. Whether `archived` and `no_access` may later clear automatically after verification is a choice for #39/#40.
- Out-of-order lifecycle events (for example `unsuspend` before `suspend`) at worst leave a mapping suspended with a verification showing it healthy. That is the safe direction, and it is visible to the Operator.

## Missed deliveries, redelivery and reconciliation

Facts:

- "GitHub does not automatically redeliver failed deliveries" ([handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)).
- "You can redeliver webhook deliveries that occurred in the past 3 days." For an App, the owner and designated app managers can redeliver ([redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)). The viewing-deliveries page's intro says "past 7 days" while its body says "past 3 days" ([viewing deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries)). Plan for 3.
- `GET /app/hook/deliveries` and `POST /app/hook/deliveries/{delivery_id}/attempts` require a JWT. The list takes `per_page` (max 100), a `cursor` from the `Link` header, and an optional `status` filter: `success` is status code 200–399, `failure` is 400–599. Each item has `id`, `guid`, `delivered_at`, `redelivery`, `status`, `status_code`, `event`, `action`, `installation_id`, `repository_id` and `throttled_at`. Redeliver returns `202`. Both can return `422` "Validation failed, or the endpoint has been spammed" ([REST: App webhooks](https://docs.github.com/en/rest/apps/webhooks#list-deliveries-for-an-app-webhook)).
- GitHub's own example groups deliveries by `guid` ("constant across redeliveries"), treats a GUID as failed only if no attempt has `status === "OK"`, and redelivers one attempt per failed GUID. It starts from a stored checkpoint, defaulting to 24 hours back ([automatic redelivery for an App](https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-a-github-app-webhook)).
- GitHub may throttle deliveries during surges; `throttled_at` shows it ([troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks#webhook-deliveries-are-not-immediate)).

Design:

1. **The sweep is the correctness backstop** (ADR 0015). Every 15 minutes, for each mapped repository with delivered rows, list `creator=<app>[bot]&state=all&since=<last_swept_at − 5 min>` ([list repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues): `since` is "last updated"). Mark changed rows due, or apply the listed state under the same `updated_at` guard. A moving `since` changes the ETag, so these calls are never free `304`s. Budget them as full requests.
2. **Daily re-check of open rows.** A deleted or transferred issue drops out of the list, so the `since` sweep cannot see it. Once a day, run a bounded, resumable pass of conditional GETs over `open` + `active` rows. Unchanged issues return `304` with no primary-quota cost.
3. **Delivery-log check, detection only.** Every 15 minutes (on the same Cron), list App deliveries back to the stored checkpoint, capped at 3 days and a fixed page budget. Group by `guid`. A GUID with no `OK` attempt is missed. Do **not** use `status=failure`: it covers 400–599 only, and a timeout or connection failure may carry another code. **Verify in spike** what `status` and `status_code` a timeout records. For each missed GUID, use the metadata, not the payload:
   - `issues` with a mapped `repository_id`: sweep that repository now.
   - `repository`, `public`, `installation_repositories`: verify those repositories now.
   - `installation` (no `repository_id`): verify every mapping pinned to that `installation_id`.

   Count misses, alert above a threshold, and export `throttled_at` counts.
4. **Redelivery is an Operator tool.** The UI (App owner or managers) or the operator CLI can redeliver within 3 days, through the gateway with the App JWT. Redelivery is safe because every handler is idempotent. It is not automatic: the metadata repair already covers it without re-sending payloads to the Worker.
5. **Older than 3 days, or a long outage:** run a full reconciliation. Sweep every mapped repository with `since = outage start − skew`, verify every mapping, then resume normal cadence. After a D1 restore, ADR 0016's ordering applies first. Projections are rebuildable by this sweep.

Permissions and blast radius: the deliveries endpoints are app-level (JWT), not installation-scoped, and can read delivery request and response bodies (`GET /app/hook/deliveries/{id}` returns `request.payload`). Only the `GitHubGateway` holds the key. Its `listDeliveries` method returns metadata fields only, and never the per-delivery payload. Operator actions use Operator credentials, never a WordPress capability or installation key, and are audited ([delivery design](../support-delivery-design.md#operator-recovery-and-alerts)).

Rate considerations:

- Installation tokens get 5,000 requests per hour per installation. GETQUICK's organization is one installation, so this budget is shared fleet-wide ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
- Sweep cost per hour is about `R × 4` lists plus about `R` token mints. Each mint is scoped to one repository (#8 criterion 2). For 100 repositories that is about 500 requests per hour, 10% of the base limit, leaving room for delivery and reconciliation. Use a read-only permission set (`issues: read, metadata: read`) for sweep mints. That narrows #8's set. A multi-repository read-only token would cut mints, but needs an explicit amendment to #8 criterion 2; it is not proposed here.
- JWT-authenticated App endpoint limits are not stated on the rate-limit page. **Verify in spike**, and treat `422` "spammed" as back-off.
- Pace sweeps serially per installation, as GitHub advises ([REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)), and give delivery and reconciliation priority over sweeps.

### Runbook: missed webhooks

1. **Detect:** alert on misses from the delivery-log check, on Worker `5xx` or `401` spikes on the webhook route, on due-row age, or on a sweep failing for a repository for more than an hour.
2. **Check config:** `GET /app/hook/config` (JWT) shows the configured `url`, `content_type` and `insecure_ssl` ([REST: App webhooks](https://docs.github.com/en/rest/apps/webhooks#get-a-webhook-configuration-for-an-app)). Never log its `secret`. A burst of `401` after a rotation means the secret pair is wrong.
3. **Repair within 3 days:** let the delivery-log check run, or trigger it from the operator CLI. Optionally redeliver specific GUIDs for debugging.
4. **Repair beyond 3 days:** run the full reconciliation sweep with the outage start time.
5. **Confirm:** due-row backlog drained, every repository's `last_swept_at` within one interval, no unacknowledged suspensions.
6. **Record:** an audit entry with actor, time, window and counts. No payloads or content.

## Freshness expectations

Targets, to be measured in the spike and staging, under normal GitHub and Cloudflare availability:

| Path | Target | Bound comes from |
|---|---|---|
| Webhook delivered | p95 ≤ 2 min from GitHub `updated_at` to `status_observed_at` | GitHub delivery delay ("a few minutes" possible) plus `waitUntil()` or the next minute Cron |
| Webhook missed or event before identity bound | ≤ 17 min | 15-min sweep plus 1-min Cron plus fetch |
| Issue deleted or transferred, webhook missed | ≤ 24 h | Daily open-row re-check |
| Repository made public, webhook missed | Creates blocked at the next dispatch; mapping suspended at the next sweep or verification | Write-time guard (#8) |
| Reporter sees a change | On the next first-show or manual refresh after the projection updates | Domain design: no polling |

Metrics: projection lag (`status_observed_at − status_source_updated_at`), oldest due-refresh age, per-repository sweep age, missed GUIDs per check, `throttled_at` count, `401` count, and suspended mappings by reason and age. Alert routing belongs to #20.

The API contract does not expose `status_observed_at`, and this note does not add it. A "last checked" hint for Reporters would be a separate contract change.

## Caches and widget behaviour

- WordPress: no caches to invalidate. Every response is `Cache-Control: private, no-store`, and there are no transients ([API contract](../support-api-contract.md)).
- Worker: no KV and no in-memory projection cache. The D1 row is the only copy, so the guarded overwrite is the invalidation. It touches only the row found by `(repository_id, issue_id)`, so it cannot affect another Slot.
- Revocation: a repository suspension takes effect on the next create through `repository_state` and the write-time guard. Reads keep returning the last projection (#8). Key revocation and role changes are handled by authentication on every read (ADR 0010, security design), not by this receiver.
- Widget: unchanged. My requests loads on first show and on the refresh button. Nothing runs while closed ([domain design](../support-domain-design.md#reporter-experience)). Live sockets, SSE or open-panel polling remain separate, unaccepted decisions. They are not needed to meet the targets above.

## Reviewed replies: deferred option only

Showing any GitHub-sourced text to Reporters would supersede part of ADR 0009, change the API contract, and reintroduce message storage that the storage design removed. It needs a new ADR. If it is ever reopened:

| Option | Assessment |
|---|---|
| Dedicated support-only issues or repository | Already decided against: ADR 0009 supersedes ADR 0001 and ADR 0008 |
| Comment marked "client-visible" in GitHub, via `issue_comment` | Reject. Any collaborator can author, edit or copy a marker, and editing does not change authorship (#8 residual risks). Author identity cannot establish visibility (issue #12's own rule). Comments can be edited after approval, so the service would need a snapshot. It also sends all comment traffic in Project repositories to the Worker |
| Service-side reviewed reply, authored by an Operator or Developer in a GETQUICK tool, stored by the service, and optionally mirrored to GitHub as an App comment | Preferred if needed. Visibility comes from an explicit service-side action, not from GitHub content. No `issue_comment` subscription. The mirror comment would be the App's own write, so the no-mutation invariant on the webhook path still prevents echo |

## Alternatives considered

| Option | Why not |
|---|---|
| Per-delivery inbox keyed by `X-GitHub-Delivery` | Contradicts the storage decision. It adds retention and erasure surface, and gives nothing over target-keyed refresh obligations, because processing is fetch-and-overwrite |
| Apply payload state directly | ADR 0015 treats webhooks as hints. Reordering, redelivery and missed events would make the projection wrong |
| Process synchronously, fetching GitHub before the 2xx | GitHub latency and rate limits could push past the 10 s window, and a slow GitHub would turn into failed deliveries |
| Cloudflare Queues between receiver and processor | Deferred by #11. At-least-once delivery ([source](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)) would still need the same idempotent handling, plus a DLQ |
| Durable Objects for per-repository serialization | Rejected by ADR 0013 and the storage design. The guarded conditional write already serializes the outcome |
| Automatic redelivery of failed deliveries | Re-sends payloads the design does not need. Metadata-driven sweeps repair the same cases with fewer moving parts |
| `timingSafeEqual` on hex strings | Works with care, but `subtle.verify` is spec-mandated constant-time and avoids the length handling |
| Polling GitHub from WordPress or the widget | Rejected by the map and ADR 0015: rate limits are shared across Clients, and there is no idle work |

## Test list

Deterministic Worker tests with a fake GitHub Layer, a controlled clock and injected failure points, as in the delivery design.

**Signature and request handling**

1. GitHub's published test vector verifies. Changing one byte of the body, the signature or the secret fails.
2. Missing header; `sha1=` only; uppercase hex; wrong length; non-hex; empty body; `x-www-form-urlencoded`; oversized `Content-Length`; a body larger than its declared length. All are rejected **before** any D1 call, and no D1 binding is touched.
3. Non-ASCII payload: verified over raw bytes. A test proves that a re-serialized JSON body would fail.
4. Rotation: current secret passes, previous secret passes while configured, and fails once removed.
5. Wrong `X-GitHub-Hook-Installation-Target-ID` (another stage's App) is rejected.
6. Timing smoke check: verify time does not depend on how many leading bytes match (statistical, report-only).

**Routing and visibility**

7. Unmapped repository, mapped repository with a mismatched installation, missing `installation`: `204`, no write.
8. An engineering issue event in a mapped repository: no D1 query (pre-filter).
9. An event for an erased request or an unbound issue: no row created ([privacy design](../support-privacy-design.md)).
10. Fixtures whose payloads carry comments, edited titles and bodies, labels, assignees, internal links and `@mentions`: the Reporter resource is byte-identical except `status`.
11. An `issue_comment` delivery (misconfigured subscription): `204`, no write, no GitHub call.

**Durability, dedup and ordering**

12. Same delivery twice, redelivery with the same GUID after a failed first attempt, and after a successful one: the obligation is set each time, and the result is one correct status.
13. `closed` then `reopened` delivered in reverse; two concurrent fetches completing in reverse order: the final state matches GitHub, with the `updated_at` guard proving no regression.
14. D1 write fails during the request: `503`, nothing applied. Recovered by the delivery-log check.
15. The `waitUntil()` task is cancelled mid-fetch: the row stays due, and the next Cron completes it.
16. A webhook arrives during a fetch: the due marker survives the completion write.
17. GitHub 5xx, timeout, 403/429 with `retry-after`: backoff honoured, attempts counted, alert at the threshold, no tight loop.
18. Close arrives before the identity is bound: dropped, then corrected by the sweep within the bound.

**Lifecycle**

19. Every row of the lifecycle table, including issue transfer inside the same Client, transfer to another Client, delete (410), repository publicized, privatized (no resume), archived/unarchived, transferred, deleted, installation deleted/suspended/unsuspended, repositories removed/added.
20. Out-of-order `suspend`/`unsuspend`: ends suspended, with verification showing healthy.

**Echo**

21. Process every fixture, including the App's own `opened`, `labeled`, `assigned` and `edited`: zero mutating GitHub calls.
22. `opened` by the bot with a forged or copied marker: no identity bound without full reconciliation.

**Recovery**

23. Delivery-log check: GUID with failed then OK attempts (skip), only failed attempts (repair), timeout-coded attempts, pagination across the checkpoint, 3-day cap, `422` back-off.
24. Sweep: `since` window with skew, pagination, PR items skipped, a missing repository (404) leading to verification and no row changes.
25. Daily open-row pass: `304`s, a 410, a 301; resumable after a mid-run cutoff.
26. Full reconciliation after a simulated 4-day outage restores every projection.

**End to end** (staging App, sandbox repository)

27. A Reporter submits; the issue is created; a Developer closes it in GitHub; the Reporter presses refresh and sees "Closed"; GitHub shows no new comment, label or edit from the App; the Worker made no mutating call after creation.
28. The same with the webhook URL temporarily broken: "Closed" appears after the sweep, within the stated bound.

## Acceptance criteria for implementation

1. The webhook route verifies `X-Hub-Signature-256` over raw bytes with `crypto.subtle.verify`, before JSON parsing or D1 access, with an optional rotation secret. Tests 1–6 pass.
2. Subscriptions match the matrix with no `issue_comment`. Handled `(event, action)` pairs are an explicit allowlist, and everything else returns `204` without a write.
3. Routing uses only `repository.id` and `installation.id` against reviewed mappings, plus the `(repository_id, issue_id)` index. No webhook creates a row.
4. A `2xx` is returned only after the refresh obligation or suspension is committed. D1 failure returns `503`.
5. Projection writes come only from GitHub reads, guarded by `updated_at`. Payload state is never written.
6. The webhook, sweep and delivery-log paths have no mutating gateway methods, enforced by types and test 21.
7. The 15-minute sweep, daily open-row pass and delivery-log check run from the existing minute Cron, with bounded work per invocation, fairness across repositories, and priority for delivery.
8. Metrics and alerts from the freshness section exist. Targets are measured in staging before production.
9. The missed-webhook runbook is executable through the operator CLI, is audited, and logs no payloads.

## Implementation slices

1. **Webhook receiver core:** route, size and content checks, signature verification, routing, allowlist, and the forward migration. Builds on #37 (gateway) and #36 (App registration, secret).
2. **Status refresh:** due marker, `waitUntil()` fetch, Cron drain, guarded write, 15-minute sweep, daily pass.
3. **Lifecycle handlers:** the existing ticket #40, using slice 1. #39 owns verification and resume.
4. **Delivery-log check and runbook:** gateway `listDeliveries` (metadata only), checkpoint, repair mapping, operator CLI commands (#41), alerts (#20).

## Verify in spike

- That the body reaching the handler through `HttpServerRequest.toWebResult` is byte-identical to what GitHub signed.
- The values of `X-GitHub-Hook-Installation-Target-Type` and `-ID` for App webhooks.
- Whether a redelivery of a pre-rotation delivery is signed with the old or the new secret.
- Whether `installation_target` must be selected at registration (the docs do not say it is delivered by default).
- The App bot's `login` and `id` on `issue.user` (shared with #8's `creator` check).
- That close and reopen always advance `issue.updated_at`.
- For a transferred issue: what a token scoped to the old repository gets from the 301, and whether the issue `id` changes.
- Whether a suspended installation still receives webhooks, and which event, if any, fires when a repository becomes `internal`.
- The `status` and `status_code` a timed-out delivery records in `GET /app/hook/deliveries`.
- Rate limits for JWT-authenticated App endpoints and for token mints.
- The largest real payloads for the subscribed events, to set the body cap.
- Measured delivery latency and projection lag, to confirm the freshness targets.
- The 3-day versus 7-day delivery retention discrepancy in GitHub's docs.

## Sources

GitHub (accessed 2026-10-17):

- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
- [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [Automatically redelivering failed deliveries for a GitHub App webhook](https://docs.github.com/en/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-a-github-app-webhook)
- [Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)
- [Viewing webhook deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries)
- [Troubleshooting webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [Suspending a GitHub App installation](https://docs.github.com/en/apps/maintaining-github-apps/suspending-a-github-app-installation)
- [Best practices for creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [REST API endpoints for GitHub App webhooks](https://docs.github.com/en/rest/apps/webhooks)
- [REST API endpoints for issues](https://docs.github.com/en/rest/issues/issues)
- [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub REST OpenAPI description, commit `0fa95c5`](https://github.com/github/rest-api-description/blob/0fa95c50cd6fc3d5f736a54f49d9195b4cb139bb/descriptions/api.github.com/api.github.com.json) (webhook payload schemas)

Cloudflare and Web Crypto (accessed 2026-10-17):

- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Protect against timing attacks](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/)
- [`workerd` HMAC verify, commit `1568dcf`](https://github.com/cloudflare/workerd/blob/1568dcf0a34da009f0a5c86b31d3a7f832ede97e/src/workerd/api/crypto/digest.c++#L47-L54)
- [W3C Web Cryptography: HMAC verify](https://w3c.github.io/webcrypto/#hmac-operations-verify)
- [Workers context (`waitUntil`)](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [D1 database API (batch)](https://developers.cloudflare.com/d1/worker-api/d1-database/)
