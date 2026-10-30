# Support Worker enrollment

GitHub App registration, stage secrets, CI deployment, key rotation and incident
response are in the [key custody runbook](../docs/runbooks/github-app-key-custody.md).
The signed GitHub webhook route, stage HMAC secret sources, rotation and pending
live-spike checks are in the [webhook runbook](../docs/runbooks/github-webhooks.md).
Staging/prod Alchemy deployments now require that stage's App credentials and
run a read-only registration preflight before declaring resources. Development
stages do not receive an App key. Both Apps and encrypted CI sources are set up;
staging App-key replacement/revocation passed live authentication checks. Staging
CI deployment, Worker authentication, the custody audit and the Worker-side
replacement/revocation rehearsal have passed; see the runbook for evidence.

`src/repository-mappings.ts` is the reviewed Repository mapping registry, with
one list per deployed stage. A Worker picks its stage's list from its App
slug, which deployment pins per stage, and any other stage gets none.
Production's list is empty until real Slots are approved. Staging maps only
the synthetic sandbox repository. Each entry includes Slot, Client, WordPress
project, authoritative environment, numeric GitHub repository ID, pinned GitHub
App installation and default Developer. Deploy mapping changes through Alchemy. Removing an
entry denies its keys after deployment; request payloads cannot override it.

## Cloudflare credentials

Use the Tipme account recorded in `AGENTS.md`. The account-owned API token
`GETQUICK Support Alchemy` grants Workers Scripts Write, D1 Write, and Secrets
Store Write within that account. It has no token-management grant and expires
on January 14, 2027. Its token ID is `48f5559e9daad1e3e324771d3708468f`.

The credential is stored at `https://secrets.getquick.io` in the **GQ Support**
project (`01M52TXAYNKP6QGHR8PZYYDEY6`), environment `dev`, as
`CLOUDFLARE_API_TOKEN`; `CLOUDFLARE_ACCOUNT_ID` is stored alongside it.
The `preview` Sigillo environment is empty. The `prod` environment holds only
`SUPPORT_GITHUB_WEBHOOK_SECRET`, the prod App's webhook secret, as the recoverable
copy of the value in the `prod` GitHub Environment and the App's webhook settings
(see [GitHub webhooks](../docs/runbooks/github-webhooks.md)). App private keys never go in Sigillo.

The current workstation has an Alchemy profile named `gq-support` configured
with this token. Select it with `--profile gq-support`; choose the deployment
stage explicitly when a deployment is authorized. This machine-local profile
is not included in a checkout. On another workstation, inject the credential
from Sigillo and configure the profile with Alchemy's `--set apiToken=env:CLOUDFLARE_API_TOKEN`
input. Keep values out of command arguments and logs.

The token manager remains in EKIS's Sigillo `ops` environment as
`CLOUDFLARE_TOKEN_MANAGER_API_TOKEN`. Use it only to mint or rotate the Support
credential; application and deployment processes receive the child token.

## Operator commands

Use the database ID from the intended Alchemy stage's outputs and the GETQUICK
Cloudflare account ID, with `--stage` naming the same stage: the CLI checks
Slots against that stage's mappings. The CLI requires all three explicitly and always targets
remote D1. Run from `worker/` using your own Wrangler login or Cloudflare
credentials with D1 read/write access; no operator credential is bound to the
Worker and there is no operator HTTP endpoint.

```sh
pnpm exec wrangler login
pnpm operator enroll shop/production --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator status shop/production --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator revoke shop/production --stage <stage> --account-id <account-id> --database-id <database-id>
```

`enroll` prints a grouped base32 code with 128 random bits, valid for 30 minutes.
Deliver it out of band to the site's admin. Only its SHA-256 hash enters D1.
`status` shows the most recent key's ID, installation ID, origin, enrollment time
and revocation time; no public or private key material is printed. A new code
does not revoke a working installation until the signed enrollment succeeds.

`revoke` records the active key in `revocations.json` **before** revoking it in D1.
Commit this append-only logical ledger after every revocation. The deployed
Worker also denies listed keys, so deploying the ledger protects those operator
revocations after a D1 restore (ADR 0016). A failed D1 write can safely be retried.
Concurrent revoke commands in one checkout are refused by `revocations.lock`;
if a process dies, inspect its log and remove the stale lock before retrying.
Do not remove records. Coordinate ledger changes across operator checkouts.

Status recovery after missed webhooks or a long outage has three commands. They
write only sweep bookkeeping and a counts-only `status_audit` row; the
[missed-webhook runbook](../docs/runbooks/missed-webhooks.md) gives the order:

```sh
pnpm operator status-health --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator status-reconcile <ISO-outage-start> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator status-repair <ISO-window-start> <ISO-window-end> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
```

`status-health` reports the due refresh backlog, each repository's last sweep,
active suspensions and whether the open-request pass is running.
`status-reconcile` makes every mapped or tracked repository's next sweep list
from the outage start, and restarts the open-request pass so deleted and
transferred issues are re-read too. `status-repair` refuses until the backlog is
drained, the pass is complete and every sweep is current, and acknowledges the
suspensions it records.

### Suppression ledger and restores

`SupportLedger` is a second D1 per stage that a restore of `SupportDB` never
rewinds (ADR 0016, `src/ledger.ts`). It keeps the current image of every
suppression, erasure, cleanup record, offboarding, repository suspension and
runtime key revocation, without report text. Erasure, offboarding and a site's
self-revocation write it first; each minute's cleanup pass mirrors rows changed
since its last pass (every writer sets `changed_at`), and once a day every row. Commands that suppress or record an erasure need
`--ledger-database-id <ledger-database-id>` (the stack outputs it):

```sh
pnpm operator erase shop/production <opaque-actor> <rs_reference> --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
pnpm operator offboard shop/production <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
```

After a Time Travel restore of `SupportDB`, record it before anything else:

```sh
pnpm operator restore-recorded <opaque-actor> time-travel-restore --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
```

Each Worker then answers `503` and skips its sweeps until it has replayed the
ledger: suppressions, erasures and cleanup records come back, restored rows
under cleanup lose their text, suspensions and key revocations are reapplied
(never lifted) and every request that is not delivered becomes
`outcome-unknown`, reconciled by its marker.

## HTTP behavior

- `POST /v1/enroll` matches the existing WordPress signer's Ed25519 proof and
  body format. The code alone determines the Slot and environment. The signed
  installation ID must match the body. Client-selected mapping fields are denied.
- Code consumption, previous-key revocation and new binding are one D1 batch.
  Every dependent write is conditional on winning consumption. Concurrent retries
  with the same public key return the original binding; a different key,
  installation ID or origin is rejected. Retrying an old code never revives a
  revoked key. A consumed code can complete its same-binding retry after expiry.
- `GET /v1/installation` requires a signed request and returns only `key_id`,
  `environment`, `connected_at` and `mapping_state` (`active` or `suspended`).
- `DELETE /v1/installation` requires a signed request and revokes only that key.
  Signature verification is followed by an atomic active-key/replay check, so
  revocation during verification wins. Status reads use primary D1 without a
  cross-request key cache or read-replica session.
- Enrollment is limited to 10 attempts per IP per fixed 10-minute window, before
  proof verification. The edge's `CF-Connecting-IP` is hashed; raw IPs are not
  stored. A missing edge IP is denied and counter failure returns 503. Requests
  are bounded to 8 KiB (creates to 128 KiB), including bodies without Content-Length.
- The existing PHP canonical string is preserved: `gq-support-v1`, method,
  path/query, key ID, installation ID, epoch-second timestamp, request ID,
  RFC 9530 SHA-256 Content-Digest, separated by newlines without a trailing newline.
  Timestamps allow 5 minutes of skew; signed installation requests consume a
  nonce retained for 10 minutes, with bounded indexed cleanup.
  `contract/fixtures/signing.json` pins this string for PHP and the Worker.
- `POST /v1/requests`, `GET /v1/requests` and `GET /v1/requests/{id}` require a
  signed request and an attested `reporter_subject` and `scope`. The key selects
  the Slot; Slot-owned rows are reached only through `createStorageFor`. A create
  records the request, its `create` intent and the Reporter and Slot quota debits
  in one D1 batch and returns `202 accepted-pending`. A same-key retry returns
  the existing request (`201` once delivered) without a debit; another body is
  409. Quotas, scope and failure codes are listed in the
  [security design](../docs/support-security-design.md#implemented-installation-authentication-32).
  Every call also spends a request budget (120 per Reporter and 600 per Slot per
  ten minutes). Delivery to GitHub is not implemented yet: intents stay `pending`.
- TLS is required. Unknown, expired and conflicting codes return the same 400
  error; rate limits return 429. Internal failures return generic 503 errors.
  Responses use `Cache-Control: no-store`; errors and request bodies are not logged.

`support.getquick.io` is still a placeholder. No service origin or Cloudflare
provisioning is established by these changes.

## Verification

The Worker pins Alchemy `2.0.0-beta.83` and Effect / `@effect/platform-node`
`4.0.5`. Its Vite 8 and Vitest 5 development dependencies satisfy Alchemy and
Effect's peer requirements. Effect 4's HTTP modules use the `effect/http/*`
exports. The old `rc.112` transitive overrides are no longer needed.
CI checks CLI startup as well as the application tests.

```sh
pnpm exec alchemy deploy --help
pnpm typecheck
pnpm exec vitest run test/enrollment.test.ts
pnpm test
pnpm load-test   # about 90 s; LOAD_SLOTS / LOAD_REPORTERS / LOAD_CONCURRENCY scale it
```

Tests exercise the HTTP handler and operator command interface against workerd
D1 via Miniflare. They do not access a remote Cloudflare account.

Platform behavior checked against the installed Wrangler and Cloudflare docs:
[D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[primary reads and Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/),
[Ed25519](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), and
[Wrangler D1 queries](https://developers.cloudflare.com/d1/wrangler-commands/#execute).

### Support issue provider operations

`src/support-issues.ts` exposes `supportIssues.create`, `repair` and `reconcile`
for the delivery scheduler described in `docs/support-delivery-design.md` (#38).
These operations do not dispatch intake records or own installation permits.

- Construct `SupportIssueIntent` from trusted, pinned operational records. The
  title is intake's derived title; the label and default Developer are approved
  mapping configuration. Attribution takes only an environment, opaque
  installation reference and Reporter pseudonym (`rs_…`), never a raw subject,
  username, email or Submission ID. The versioned template fences Reporter text
  with a tilde run longer than any in that text; context fields remain omitted.
- Persist authorization/attempt ownership **before** calling `create` once.
  Persist the returned GitHub identity even when metadata is missing. An
  `OutcomeUnknown` goes to reconciliation, never a generic mutation retry.
  The scheduler must recheck execution deadlines and erasure/suppression before
  dispatch; provider operations cannot provide durable authorization themselves.
- Call `repair` with that trusted identity under the installation mutation budget.
  It reads current metadata and sends at most one additive POST. `RepairPending`
  needs a later paced repair; `Repaired` changes no delivery identity. A repair
  failure leaves the successful delivery intact. Gateway errors retain rate
  feedback. Silent provider drops are detected by the final read.
- `reconcile` reads one creator-filtered, creation-descending page (100 issues)
  per call, plus the preceding page on resumption to verify its boundary has
  not shifted through insertion, deletion or transfer. Persist a `Continue.progress` checkpoint with the intent and pass it
  to the next call. Checkpoints hold only scope, pagination and candidate
  identities, never Reporter text. An error preserves the previous checkpoint;
  retry that read under the provider budget. A shifted/inconclusive scan needs a
  fresh scan at the next scheduled check. Never interpret either as absence.
- Supply the recorded attempt's bounded dispatch window and configured App bot
  login. Before erasure, supply the exact original template/title as
  `expectedIssue` (reconstruct it with `supportIssues.prepare`); after purging text use `null` with `erasurePending`. A known
  GitHub identity, if any, must also match. Repository identity is checked live.
  A single candidate is re-read after completing the scan; changed content or
  identity requires review. A collaborator can copy even the entire template:
  this is correlation evidence, not authentication. Before committing a result,
  the scheduler must conditionally verify request ownership and ensure the
  returned identity is not already bound to another request.
- `Unknown` always remains outcome-unknown, including complete empty scans.
  `alert: true` signals suspicious or multiple matches for immediate Operator
  review; it sends no notification. No operation selects a duplicate, closes,
  deletes or recreates an issue. Scheduling (1/5/15/60 minutes, then hourly),
  unresolved alerts after 15 minutes, the 24-hour review deadline and late
  positive binding belong to the delivery scheduler, not this module.
- An erased discovery returns `RedactionRequired` with an identity, never a
  create or repair. Route it to the privacy redaction workflow (#46); when
  original text was purged, `reviewTitle` requires Operator title review. This
  signal alone does not claim erasure is complete. Multiple/suspicious erased
  discoveries still require review, with candidate identities for cleanup.

## Durable GitHub delivery

Issue #25 adds one D1 scheduler (`src/delivery.ts` and `src/delivery-store.ts`)
using the existing GitHub gateway and Support issue operations. A committed
acceptance wakes bounded `waitUntil` work; `* * * * *` recovers missed wake-ups.
Public outcomes already project pending/in-flight, delivered, failed and unknown
without exposing provider identities or errors. No GitHub key leaves the Worker.

Delivery mappings additionally need `githubInstallationId` and
`clientOriginLabel`. These and the environment/default Developer are pinned at
acceptance. Changed or missing mappings fail closed rather than rerouting old
reports. Migration 0005 marks pre-migration pending/in-flight work unknown and
requires review because it has no pinned provider installation.

The migration starts `delivery_control.enabled = 0`. After rollout/restore checks,
an independently authenticated Operator can enable the intended database with
`UPDATE delivery_control SET enabled = 1 WHERE id = 1`. Disable it before restore
or incident recovery. This is a dispatch gate, not a complete restore procedure:
#20 owns restore suppression replay, and #46 owns erasure/retention integration.
Do not enable production report delivery until those gates are satisfied.
`delivery_suppression` denies new creates/repairs by Slot or request; removing a
WordPress key alone does not cancel accepted reports.

Each invocation can authorize dispatch for 20 seconds from its start; the adapter
interrupts background work at 25 seconds. Installation permits cannot recycle
uncertain execution for 60 seconds from invocation start. The gateway's finite
15-second requests and final deadline/ownership check after token minting prevent
a delayed claim or lookup from starting a POST outside that window. This bounds
service dispatch, not remote GitHub execution. Stale owners cannot persist results;
read-only marker reconciliation handles positive late observations.

All creates and additive metadata repairs share a 10-second installation budget
and a conservative fleet-wide 10-second admission budget (at most 360
mutations/hour across this stage). Failed claims may consume admission without
creating an issue; they can never enlarge the budget. Provider cooldown is
persisted independently of each request deadline, applies to read-only
reconciliation too, and is checked again when claiming a previously selected
candidate. Read-only work bypasses the execution-drain lock, not provider
throttling. Expired unsent work fails
without waiting for an installation permit. Rejections honour provider delays and use bounded
backoff with jitter otherwise, up to 24 hours from acceptance. Unknown creates
never automatically POST again. Reconciliation checkpoints and candidate identities
are persisted, following the 1/5/15/60-minute, then hourly schedule through 24 hours.
Structured Effect logs and spans contain intent/generation/outcome only. Alerts
are log events for operations to route, not outbound notifications.

An independent Operator may resume a **failed**, confirmed non-created request:

```sh
pnpm operator resume shop/production int_<id> 2026-10-18T12:00:00Z operator-7 permissions-restored --stage <stage> --account-id <account-id> --database-id <database-id>
```

Supply an opaque actor, an explicit deadline within the next 24 hours and one of
`configuration-fixed`, `permissions-restored`, `provider-recovered`. The command
writes an audit before its conditional mutation, rechecks mapping/suppression,
and refuses unknown, superseded or unsafe requests. The audit records the
attempted authorization even if the command loses eligibility before mutation.
For a positive observation discovered after the automatic reconciliation window,
`pnpm operator reconcile <slot> <intent> <opaque-actor> positive-evidence` (with
the same account/database flags) audits and schedules one additional bounded
hour of read-only reconciliation. It verifies the pinned repository, App author,
marker, attempt window and conflicts through the provider contract. A negative
scan still cannot create an issue. There is no WordPress or public HTTP recovery
endpoint and no force-create action.

### Suspended mappings

Every create and metadata repair first mints a fresh repository-scoped token,
which resolves the repository by numeric ID and refreshes its cached name. The
mint response's `private` and `archived` facts decide whether to POST; only a
mint that omits them costs one `GET /repos/{owner}/{name}`. A public or archived
repository, or lost App access (a transfer, removal from the installation,
deletion, or an uninstalled or suspended App), suspends the repository
(`repository_state.suspended_reason`) and logs `Repository mapping suspended`
with `alert: true`. The suspension covers every Slot mapped to that repository.
Reporters then get `gq_support_not_configured` on submit, `GET /v1/installation`
reports `mapping_state: "suspended"`, existing requests keep their last-known
status, and accepted unsent work is held, not sent.

The scheduled repository sweep checks every approved mapping, even without
Support requests or webhooks, and keeps checking suspended repositories. Each
due sweep uses a fresh read-only repository-scoped mint. If the mint omits
`private` or `archived`, verification makes exactly one repository read.
Transient provider failures and rate limits retry without proving lost access.

No check ever lifts a suspension. A healthy sweep records `verified_safe_at`
and logs `Suspended repository verified safe; Operator lift required` with
`alert: true`. Suspended repositories keep their requests' last-known status,
including during individual refreshes. After a passing sweep later than the
suspension, an Operator runs:

```sh
pnpm operator unsuspend shop/production operator-7 verified-private --stage <stage> --account-id <account-id> --database-id <database-id>
```

The evidence must match the recorded cause: `verified-private` (public),
`verified-unarchived` (archived) or `access-restored` (lost access). `status`
shows the current suspension and its `verified_safe_at`. The command requires
`verified_safe_at > suspended_at` both before writing the `repository_audit`
row and in its conditional update. A renewed unsafe observation clears passing
evidence; a check begun before that observation cannot restore it. Migration
0011 adds this verification bookkeeping. The next create checks the repository
again, so an unsafe repository suspends again at once.

The fake GitHub tests cover both mint shapes: present `archived` needs no extra
repository read, omitted `archived` needs one per verification. The
[staging spike on 2026-10-18](https://github.com/Quick-Release/gq-support/actions/runs/39129327430)
observed `mintIncludesPrivate: true`, `mintIncludesArchived: true` and
`createRepositoryReads: 0`. This confirms the zero-extra-read path for that
live response; the fallback remains necessary if GitHub omits either fact.
Installation scope and the other spike observations are recorded in the
[key custody runbook](../docs/runbooks/github-app-key-custody.md#live-evidence--2026-10-18).

Verification: `pnpm --filter gq-support-worker test`, `typecheck` and `load-test`.
The delivery load test runs 24 Slots, including a busy Slot, across three provider
installations against real local D1 with four competing sweeps and fake GitHub. It checks fairness beyond the frontier
bound and shared pacing. Local results do not measure production provider latency.

## Operational incidents

Operational incidents (#135, `src/incidents.ts`, migration 0020) are durable
service records the GETQUICK team views, claims and resolves. One open incident
per category and cause groups every observation of a shared failure and lists
each affected Slot; a different cause is a separate incident. The first producer
is the [suspended mapping](#suspended-mappings) path: every unsafe repository
observation records the `repository_suspended` incident for that repository,
listing every Slot mapped to it, in the same D1 batch as the suspension. Further
signals are routed by later #134 tickets.

- Incidents stay unassigned until someone claims one. There are no designated
  responders, claim timeouts, reminders or automatic escalation.
- A claim atomically records its immutable actor, channel, time and audit identity
  in one conditional write, so exactly one concurrent claimant wins, including
  through remote CLI queries. Repeating your own claim succeeds.
- Only the claimant can resolve (`recovered`), and only once trusted records show
  the cause recovered, checked in the same conditional write. For a suspension
  that means the Operator's audited `unsuspend` has lifted it. A recurrence after
  resolution opens a new incident.
- The audit combines open/resolve events with the incident's immutable claim
  fields, recording actor, channel (`service`, `api` or `operator`), action,
  previous/new state and time. Incidents hold no Submitted
  text, Reporter identity, credential, URL or payload; projections omit the cause
  subject and the audit trail.
- Unresolved incidents are kept. A resolved incident disappears from every
  projection 90 days after resolution; the minute tick then deletes it with its
  Slots and audit, in bounded batches.

### Operations API

`/v1/operations/*` is the one authenticated boundary for a staff dashboard such
as Banquinha (`src/operations-api.ts`):

- `GET /v1/operations/incidents` and `GET /v1/operations/incidents/{id}`
- `POST /v1/operations/incidents/{id}/claim` (empty body): `200`, or `409`
  `incident_claimed` / `incident_resolved`
- `POST /v1/operations/incidents/{id}/resolve` with `{"resolution":"recovered"}`:
  `200`, or `409` `incident_not_claimed` / `recovery_not_verified` / `incident_resolved`
- `GET /v1/operations/notifications`: [Discord notification](#discord-notifications)
  delivery health per destination and the failing notifications

The dashboard authenticates its team member itself, then signs every request
with its registered Ed25519 key over this canonical string, newline-separated
without a trailing newline: `gq-support-operations-v1`, method, path/query,
`GQ-Operations-Key-Id`, `GQ-Operations-Actor`, `GQ-Operations-Timestamp` (epoch
seconds, 5 minutes of skew), `GQ-Operations-Request-Id` (16–128 of
`[A-Za-z0-9-]`) and the RFC 9530 SHA-256 `Content-Digest`. The signature goes in
`GQ-Operations-Signature`. Request IDs are single-use for 10 minutes. The Worker
then requires the signed actor in its own staff roster. A bad or unknown
signature is `401 operations_unauthorized`; a valid signature for an actor
outside the roster is `403 operations_forbidden`. Installation credentials,
Discord identities and Discord membership are never accepted. No route performs
recovery: that remains the independently authorized Operator CLI.

The stage's access is explicit deployment configuration, from the GitHub
Actions variables `SUPPORT_OPERATIONS_API_KEYS` (a JSON object of key ID to
base64 raw public key) and `SUPPORT_OPERATIONS_STAFF` (comma-separated opaque
actor IDs, `[A-Za-z0-9_-]{1,64}`). Neither is secret. Unset or malformed
values close the API. No Banquinha key or staff roster is registered yet; the
roster changes only by redeploying.

### Incident CLI fallback

When the dashboard is unavailable but D1 is healthy, an Operator can inspect
and claim incidents with the usual account and database flags:

```sh
pnpm operator incidents --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator incident <incident-id> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator incident-claim <incident-id> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
```

`incident` adds the restricted audit trail. `incident-claim` follows the API's
claim rule, recorded with channel `operator`. The claim and its audit metadata
are one statement, so remote CLI races leave no losing claimant's audit event.
Resolution goes through the operations API. Neither path can write while D1 is down.

## Discord notifications

Accepted Support requests and Operational incidents are announced in two
separate Discord channels through channel webhooks (#136, `src/notifications.ts`,
migration 0022). The minute tick derives notifications from durable state after
delivery, cleanup and incident expiry, within a 4-second phase bound. Intake and
incident writes never wait for Discord, so a Discord outage or misconfiguration
never loses or delays a report or an incident.

- **Support requests** channel: one message per request accepted in the last
  24 hours, showing its actual delivery outcome. "Accepted; pending GitHub
  delivery (no issue confirmed yet)" is edited to "Delivered: GitHub issue
  created" only once the issue number is recorded, or to a needs-Operator-review
  state when the create failed or its outcome is unknown.
- **Operational incidents** channel: one message per open incident, edited
  when it is claimed and resolved. An incident claimed before its first send is
  announced once, already claimed. Nothing reminds about or escalates an
  unclaimed incident.
- Messages hold only the state, Slot, category, opaque request or incident ID,
  claimant, and trusted links built by the service: the runbook in this
  repository and, when the [repository mapping](#suspended-mappings) records its
  reviewed `repository` (`owner/name`), the confirmed GitHub issue. Without one
  the issue is named by number and repository ID. Never Submitted text, Reporter
  identity, credentials, payloads or URLs from requests. Mentions are disabled.
- Delivery state is one row per source and destination, separate from the
  source. A source, destination and transition is sent once Discord confirms it;
  a later transition edits the known message, and a deleted message is reposted.
- Each attempt is recorded as `outcome_unknown` before the request. A lost
  response is therefore retried, and Discord may show that notice twice:
  exactly-once Discord delivery is not promised, and a retry never creates an
  incident. Failures retry with exponential backoff (1 minute doubling to 1
  hour) for 8 attempts per transition, then become `failed` and log
  `Discord notification failed` with `alert: true`. A 429 waits Discord's
  `retry_after` and defers that destination (all, if global) without spending an
  attempt. Error codes are bounded: `outcome_unknown`, `rate_limited`,
  `provider_unavailable`, `destination_rejected`, `request_rejected`, `message_missing`.
- Rows hold no content and never outlive their source: request rows go when the
  request is erased or purged, or 7 days after acceptance; incident rows go with
  the incident's expiry. Discord's own copies contain only the metadata above.

Inspect and recover with the operations API or the Operator CLI:

```sh
pnpm operator notifications --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator notification-retry <support_requests|operational_incidents> --stage <stage> --account-id <account-id> --database-id <database-id>
```

`notifications` lists per-destination pending/failed counts, oldest pending
change and last confirmed send, plus failing notifications with their bounded
codes. After fixing the cause, `notification-retry` re-arms that destination's
failed notifications; they are rendered from current state, so a resolved
incident is announced as resolved.

### Discord configuration

Each stage's destinations are the Worker secrets
`DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL` and `DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL`,
deployed from the stage GitHub Environment secrets
`SUPPORT_DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL` and
`SUPPORT_DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL`. A webhook URL embeds its
token, so it is a credential: keep it out of variables, issues, logs and
command arguments. The deployment preflight rejects a value that is not
`https://discord.com/api/webhooks/{id}/{token}` or one webhook used for both
channels, and every apply uploads set values and deletes unset ones. An unset
destination is closed: nothing is queued for it, and enabling it later
announces open incidents and requests from the last 24 hours only.

No destination is configured for any stage yet. See the
[support operations runbook](../docs/runbooks/support-operations.md#discord-notification-setup)
for setup and evidence.

## Support status refresh

The minute tick runs delivery/reconciliation first, then status refreshes, then
repository sweeps. The phase timeouts total 57 seconds. Refreshes use the same
repository-scoped, read-only gateway as the sweep. A changed sweep observation
queues an individual refresh; unchanged listings preserve its ETag.

Migration 0009 adds durable refresh generations, attempt ownership/backoff and
a singleton daily-pass cursor. Every daily pass queues open, actively tracked
requests in ID order at a fixed creation-time cut-off. Queue writes and cursor
advancement are atomic, so a later minute resumes an interrupted pass. Closed,
unbound, lost and suppressed requests are not fetched. Repository and App
installation identities come from the pinned operational records.

Defaults are 100 daily candidates and 10 issue reads per tick, a daily interval
of 24 hours and a 10-second refresh dispatch window. Configure the first three
with `STATUS_REFRESH_DAILY_BATCH_SIZE`, `STATUS_REFRESH_READS_PER_TICK` and
`STATUS_REFRESH_DAILY_INTERVAL_MS`. A large backlog may need more than one tick;
size these bounds for the stage's request volume and GitHub read budget.

`requestStatusRefresh` is the trusted target-keyed wake-up for verified issue
webhooks and sweep observations. A matching webhook durably queues the request
and starts a bounded read-only refresh with `waitUntil()`; the minute tick
recovers unfinished work. See the [webhook runbook](../docs/runbooks/github-webhooks.md)
for event and identity filters. Its generation changes even for two notifications in the same
millisecond. Successful reads clear only the generation/owner they started
with. A 200 applies status under GitHub's `updated_at` guard; a 304 only advances
observation time. A 301, 410, or an issue 404 with a still-accessible repository
closes the request, marks tracking lost and logs an Operator alert. Requests
never move to another repository. A repository-access failure remains due for
Operator review rather than being mistaken for a missing issue.

Errors retain the obligation, count attempts and back off exponentially from
one minute to an hour, with up to one additional backoff interval of jitter.
GitHub rate limits also persist the installation-wide cooldown shared with
delivery. A cancelled read's durable claim is eligible after one minute.
Structured `Support status refresh retry` events alert from attempt five;
`support.status.refresh.oldest_due_age_ms` reports the oldest outstanding
obligation and alerts after one hour, including obligations in backoff.
Route these and `Support status tracking lost` events to Operator monitoring;
these events do not send outbound notifications. No Reporter text, provider
response bodies or tokens enter them.

Verification: `pnpm exec vitest run test/status-refresh.test.ts` exercises the
scheduled entry, local workerd D1, fake GitHub and the signed installation API.
