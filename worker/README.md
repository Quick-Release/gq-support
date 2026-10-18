# Support Worker enrollment

GitHub App registration, stage secrets, CI deployment, key rotation and incident
response are in the [key custody runbook](../docs/runbooks/github-app-key-custody.md).
Staging/prod Alchemy deployments now require that stage's App credentials and
run a read-only registration preflight before declaring resources. Development
stages do not receive an App key. Both Apps and encrypted CI sources are set up;
staging App-key replacement/revocation passed live authentication checks. Staging
CI deployment, Worker authentication, the custody audit and the Worker-side
replacement/revocation rehearsal have passed; see the runbook for evidence.

`src/repository-mappings.ts` is the reviewed Repository mapping registry. It is
intentionally empty until real Slots are approved. Each entry includes Slot,
Client, WordPress project, authoritative environment, numeric GitHub repository
ID and default Developer. Deploy mapping changes through Alchemy. Removing an
entry denies its keys after deployment; request payloads cannot override it.

## Cloudflare credentials

Use the Tipme account recorded in `AGENTS.md`. The account-owned API token
`GETQUICK Support Alchemy` grants Workers Scripts Write, D1 Write, and Secrets
Store Write within that account. It has no token-management grant and expires
on January 14, 2027. Its token ID is `48f5559e9daad1e3e324771d3708468f`.

The credential is stored at `https://secrets.getquick.io` in the **GQ Support**
project (`01M52TXAYNKP6QGHR8PZYYDEY6`), environment `dev`, as
`CLOUDFLARE_API_TOKEN`; `CLOUDFLARE_ACCOUNT_ID` is stored alongside it.
The `preview` and `prod` Sigillo environments are empty.

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
Cloudflare account ID. The CLI requires both explicitly and always targets
remote D1. Run from `worker/` using your own Wrangler login or Cloudflare
credentials with D1 read/write access; no operator credential is bound to the
Worker and there is no operator HTTP endpoint.

```sh
pnpm exec wrangler login
pnpm operator enroll shop/production --account-id <account-id> --database-id <database-id>
pnpm operator status shop/production --account-id <account-id> --database-id <database-id>
pnpm operator revoke shop/production --account-id <account-id> --database-id <database-id>
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

The full restore gate, including runtime rotation/self-revocation history,
restore epochs and suppression replay, remains rollout work in #20; this CLI
ledger alone is not evidence that a restored database is safe to serve traffic.

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
pnpm operator resume shop/production int_<id> 2026-10-18T12:00:00Z operator-7 permissions-restored --account-id <account-id> --database-id <database-id>
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

No check ever lifts a suspension. After verifying the cause is resolved, an
Operator runs:

```sh
pnpm operator unsuspend shop/production operator-7 verified-private --account-id <account-id> --database-id <database-id>
```

The evidence must match the recorded cause: `verified-private` (public),
`verified-unarchived` (archived) or `access-restored` (lost access). `status`
shows the current suspension. The command writes a `repository_audit` row before
its conditional update. The next create checks the repository again, so an
unsafe repository suspends again at once.

Verification: `pnpm --filter gq-support-worker test`, `typecheck` and `load-test`.
The delivery load test runs 24 Slots, including a busy Slot, across three provider
installations against real local D1 with four competing sweeps and fake GitHub. It checks fairness beyond the frontier
bound and shared pacing. Local results do not measure production provider latency.

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

`requestStatusRefresh` is the trusted target-keyed wake-up for future webhook
consumers. Its generation changes even for two notifications in the same
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
