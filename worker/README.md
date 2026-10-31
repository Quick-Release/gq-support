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
pnpm operator offboard shop/production <opaque-actor> <evidence-ref> --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
pnpm operator offboard-status shop/production --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
```

### Offboarding

`offboard` (#147, `src/offboarding.ts`, ledger migration 0004) ends service for
one Slot in single-statement steps, each safe to have applied alone; rerun it to
complete an interrupted one (it keeps the first grace period, and works once the
ledger holds the offboarding even if the mapping is gone):

1. The ledger audits the attempt (`offboarding_audit`, actor and evidence), then
   records the Slot's suppression and offboarding.
2. The main database suppresses the Slot. From here no create is dispatched,
   no enrollment completes or code is issued, no update key is granted, native
   update requests are refused, and no central application starts or reaches
   its install.
3. The exact report keys and native update keys still usable are revoked in the
   ledger, recorded in `revocations.json` (commit it, as after `revoke`), then
   revoked in the main database with pending download grants and unused
   enrollment codes deleted.
4. The ledger audits the result, which the command also prints: keys revoked,
   `delivery.cancelled` (accepted creates never attempted, which the suppression
   stops), `delivery.uncertain` (intents whose create may have happened, kept
   for review), `central.uncertain` (applications with no settled outcome, which
   may have changed the installation), and `native.last_served` (a package
   already downloaded cannot be taken back; the site may still install it).

Grants, enrollments and central applications check the ledger as well as the
main database, so a restore that dropped the main record cannot reopen access,
and replay revokes every remaining key of an offboarded Slot. Service cannot
resume (`offboarded_access_present`) while one is usable. `offboard-status`
shows whether the main database is complete, the uncertain work, unresolved
cleanup records and the audit; it needs no mapping.

After the 30-day grace the cleanup pass purges the Slot's requests (as before)
and its contact routes, version evidence, signed/installed-files observations,
served-update records, Reporter quota rows and settled central applications,
with or without its mapping, and again after any restore. It keeps the
suppression, offboarding, key/grant revocation rows, unresolved cleanup records
and central applications without a settled outcome. A Slot's disconnect,
`revoke`, `update-access-revoke` and `GQ_SUPPORT_DISABLED` are not offboarding:
accepted work is still delivered. Shared stage resources, repository state,
release, launch, schema and rollback records and GitHub issues are never
deleted to remove one Client.

Deployment order: apply ledger migration 0004 and main migration 0031 before a
Worker or Operator checkout of this version runs; the inventory, cleanup pass and
`offboard` read their new columns and tables.

### Production readiness

`pnpm readiness --stage prod [--evidence <file>] [--drill-report <file>] [--trusted] [--out <file>]`
(`src/readiness.ts`) checks the evidence each operations gate needs before any
Client production onboarding and exits `0` only when ready, `2` otherwise. It
reads this checkout's reviewed configuration and the named files; `--trusted`
also reads GitHub's own run, artifact, issue and comment records read-only with
the Operator's `gh` login, and only that mode is authoritative. Evidence format,
gates and the human sign-off are in the
[production readiness runbook](../docs/runbooks/production-readiness.md).

### Maintenance boundary and restores

The maintenance boundary (`src/maintenance.ts`, ledger migration 0003) is held in
`SupportLedger`, outside the database a restore rewinds. Every request and
scheduled tick reads it together with the restore epoch, with no cached verdict:
while it holds, or when the ledger cannot be read, every route but the
independent checker's probe answers `503` with `Retry-After: 60`, ticks do no
work, and the delivery sweep authorizes no create. A sweep captures the restore
epoch and maintenance generation when it starts, and each create is authorized
only while both are unchanged and the ledger suppresses neither its Slot nor its
request. A GitHub webhook's signature is verified before any D1 access, the
gate's included; a verified one that would write is refused with `503` during
maintenance.

```sh
pnpm operator maintenance-begin <opaque-actor> <restore|incident> <evidence-reference> --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
pnpm operator maintenance-status --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
pnpm operator restore-recorded <opaque-actor> time-travel-restore --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
pnpm operator maintenance-end <opaque-actor> <generation> <evidence-reference> --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
```

Each transition writes a `maintenance_audit` row first, then changes state in
one conditional statement, so concurrent or retried commands change it at most
once. `maintenance-status` shows whether in-flight work has drained (2 minutes),
whether a restore was recorded and replayed. `restore-recorded` is refused
outside a drained `restore` maintenance. Workers then replay the ledger during
maintenance: suppressions, erasures and cleanup records come back, restored rows
under cleanup lose their text, suspensions and key revocations are reapplied
(never lifted), every request that is not delivered becomes `outcome-unknown`,
reconciled by its marker, and checker episodes the service had acknowledged
come back, reopening their incident for review. `maintenance-end` refuses with
bounded blockers (`not_drained`, `restore_not_recorded`, `replay_pending`,
`suppression_missing`, `erasure_missing`, `offboarding_missing`,
`suspension_missing`, `revocation_missing`, `offboarded_access_present`, `erased_text_present`,
`withdrawn_release_current`, `episode_missing`) until the restored database
holds everything the ledger keeps. The procedure is in the
[operations runbook](../docs/runbooks/support-operations.md#d1-restore-or-corrupting-migration).

`enroll`, `resume`, `reconcile`, `unsuspend`, `release-*`, `fleet-launch`,
`fleet-run`, `update-access-grant` and `central-apply` require
`--ledger-database-id` and are refused during maintenance, before a recorded
restore is replayed, or when the ledger cannot be read; `release-withdraw` is
allowed during maintenance once replayed, and records the withdrawn version in
the ledger first. `resume` is also refused for a request the ledger suppresses.
Revocation, erasure, offboarding and update-access revocation are not guarded.

The ledger also retains checker episodes the service acknowledged (metadata
only: component, bounded code, times; 45 days after their last report) and
withdrawn release versions. A report is acknowledged to the checker only once
the ledger holds its episodes too; a failed ledger write leaves the recorded
incident and the checker retries.

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
- The PHP canonical string is `gq-support-v2`, method, path/query, key ID,
  installation ID, plugin version (`GQ-Support-Plugin-Version`), epoch-second
  timestamp, request ID, RFC 9530 SHA-256 Content-Digest, separated by newlines
  without a trailing newline. The legacy `gq-support-v1` string, without the
  version, still verifies; its unsigned version header is ignored (#141).
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
CI checks CLI startup as well as the application tests. Staging and prod deploy
only through `pnpm deploy-gate` from **Deploy Support Worker**; see the
[deployment plan gate](../docs/runbooks/support-operations.md#deployment-plan-gate).

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
`UPDATE delivery_control SET enabled = 1 WHERE id = 1`. This is a dispatch gate
in the main database, which a restore rewinds: it is not a restore barrier. Use
the [maintenance boundary](#maintenance-boundary-and-restores) for restore or
incident recovery.
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
pnpm operator resume shop/production int_<id> 2026-10-18T12:00:00Z operator-7 permissions-restored --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
```

Supply an opaque actor, an explicit deadline within the next 24 hours and one of
`configuration-fixed`, `permissions-restored`, `provider-recovered`. The command
writes an audit before its conditional mutation, rechecks mapping/suppression
(the ledger's too), and refuses unknown, superseded or unsafe requests, and any
resume during maintenance. The audit records the
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
listing every Slot mapped to it, in the same D1 batch as the suspension. Other
[routed operational signals](#routed-operational-signals) (#138) open incidents
from durable records each minute.

- Incidents stay unassigned until someone claims one. There are no designated
  responders, claim timeouts, reminders or automatic escalation.
- A claim atomically records its immutable actor, channel, time and audit identity
  in one conditional write, so exactly one concurrent claimant wins, including
  through remote CLI queries. Repeating your own claim succeeds.
- Any authenticated staff member can resolve a claimed incident (`recovered`), and only once trusted records show
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

- `GET /v1/operations/incidents[?cursor=…]` returns up to 200 incidents and
  `next_cursor` (null on the last page); use that cursor to reach later incidents.
  `GET /v1/operations/incidents/{id}` reads one incident.
- `POST /v1/operations/incidents/{id}/claim` (empty body): `200`, or `409`
  `incident_claimed` / `incident_resolved`
- `POST /v1/operations/incidents/{id}/resolve` with `{"resolution":"recovered"}`:
  `200`, or `409` `incident_not_claimed` / `recovery_not_verified` / `incident_resolved`
- `GET /v1/operations/notifications`: [Discord notification](#discord-notifications)
  delivery health per destination and the failing notifications
- `GET /v1/operations/inventory`: the stage's [Slot inventory](#slot-inventory)
- `GET /v1/operations/health`: [measured support-path health](#measured-health)

The [independent checker's](#independent-outage-checks) probe and report under
`/v1/operations/checker/` are not staff routes: they verify only the checker's
own key, and no staff key verifies there.

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
pnpm operator incidents <next_cursor> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator incident <incident-id> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator incident-claim <incident-id> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
```

`incident` adds the restricted audit trail. `incident-claim` follows the API's
claim rule, recorded with channel `operator`. The claim and its audit metadata
are one statement, so remote CLI races leave no losing claimant's audit event.
Resolution goes through the operations API. Neither path can write while D1 is down.

## Routed operational signals

The minute tick's signal phase (#138, `src/operational-signals.ts`) reads
trusted durable records, never log text, and records what it observes as
grouped [Operational incidents](#operational-incidents), which the
[Discord notifier](#discord-notifications) then announces. Each category's
observation query is also its recovery check, so any staff member can resolve the
incident only once the signal no longer observes its cause. One cause is one
incident whose affected Slots grow with each observation; a recurrence after
resolution opens a new incident. No signal retries, replays or force-creates work.

| Category | Cause (grouping) | Observed when | Recovered when |
|---|---|---|---|
| `delivery_unknown` | Repository | An uncertain create is unresolved after 15 minutes, or at once with duplicate/suspicious matches (`detail: conflicting_evidence`). At 24 hours the same incident becomes `detail: operator_handoff` and its Discord message is edited | Trusted positive reconciliation, or audited review, leaves no such create |
| `delivery_rejected` | Repository | A delivery failed for configuration or permissions (`AppAuthenticationFailed`, `PermissionMissing`, `ValidationRejected`, `MappingUnavailable`, `MissingIdentity`), immediately | The Operator repairs it and `resume`s, or cleanup removes it |
| `delivery_deadline` | Repository | Known non-creation reached the 24-hour automatic retry deadline; the request is kept under its own retention | Audited `resume`, or retention/erasure cleanup |
| `repository_suspended` | Repository | A [suspension](#suspended-mappings), immediately | Audited `unsuspend` |
| `webhook_rejected` | Stage | GitHub's delivery log shows a delivery our receiver answered `401` | GitHub records a later acknowledged delivery |
| `webhook_failed` | Stage | GitHub's delivery log shows a `5xx` or no response | GitHub records a later acknowledged delivery |
| `status_refresh_behind` | Stage | A refresh has been due for over the existing one hour | No eligible refresh is over an hour due |
| `status_sweep_behind` | Repository | The existing one-hour sweep lag, for repositories with tracked requests | A sweep completes |
| `privacy_cleanup` | Purpose | Retention, offboarding or erasure cannot confirm completion: an `unresolved` remote outcome, residual copies of an open erasure, or an incomplete/failed reference search | The Operator's audited reconcile, exception or erasure close |
| `suppression_ledger_behind` | Stage | The suppression ledger mirror has not completed for 15 minutes after first succeeding | A cleanup pass mirrors again |

Webhook outcomes come from GitHub's own App delivery log (`GET /app/hook/deliveries`,
App JWT), counted each minute after the last counted delivery from the newest
page of 100, with the counts and the mark in one D1 batch. The log holds only
GitHub's genuine deliveries, so a forged request is never counted, never routed
and still never touches D1. While GitHub has the service in a rate-limit
cooldown the log is read later. A `5xx` answered while D1 itself is down cannot be
recorded then; it is counted once storage returns. A D1 or Worker outage while
it lasts is detected by the [independent checker](#independent-outage-checks),
not this phase. The two overlap by design: the checker's `component_unavailable`
incident records the outage, and this phase's `webhook_failed` incident, opened
once storage returns, records the deliveries it missed and the status repair
they need. Each is one grouped incident, never one per tick.

### Phase bounds and a distant D1

Every roundtrip a Worker makes to D1 costs wall time inside its phase's bound
(cleanup 5 s, signals 2 s). On the one-Slot staging stage, one UTC hour
(10:00 on 2026-10-31) measured 38 signal timeouts against 17 completions, and 8
cleanup timeouts against 47. The minute tick against real local D1, with a fixed
cost per roundtrip, reproduces both deterministically (`test/scheduler.test.ts`).
At 130 ms per roundtrip, with GitHub at 300 ms, the signal phase's 15 sequential
reads ran past 2 s, so the last three rules started after the bound. At 170 ms,
a cleanup pass of 24 sequential roundtrips, or 30 with the daily full mirror,
ran past 5 s.

Reads that do not depend on each other therefore go to D1 together: the eleven
rules' reads and the retention expiry, each kind's mirror reads, and the paired
reads inside retention, unmapped-Slot and compaction steps. Writes keep their
order. Incident writes go one at a time, one cause of each rule before any
rule's next. Cleanup steps keep their privacy order, compaction records the
ledger before it deletes from the main database, and the mirror marks itself done
only after recording everything it read. A phase cut off at its bound starts no
further D1 statement or batch, so a cut-off mirror runs again in full next
minute. D1 cannot withdraw a statement or batch already submitted, so that one
still completes after the bound. Each step stays safe to stop and repeat.

That the staging timeouts come from the Worker running far from its D1 is an
inference. No live per-roundtrip timing has been measured. After deployment,
confirm in `pnpm operator health` that `scheduler` shows `signals_timed_out` and
`cleanup_timed_out` stopping.

The 15-minute ledger rule is provisional, like any numerical rule not inherited
from the [delivery design](../docs/support-delivery-design.md): tune it from
measured baselines. A write failure in this phase never rolls back a suspension,
erasure, revocation or accepted request; the next tick observes again.

### Measured health

`GET /v1/operations/health` and `pnpm operator health` (`src/operations-health.ts`)
report the same view: the last 24 hours of hourly aggregates (`measured`) and
what durable records show now (`current`). Absent or `null` means not
observed, never healthy. Nothing in it is an objective or SLA; no baseline has
been recorded for any stage yet.

- `measured` rows are `metric`, `outcome`, `client` (or `null`), `count`, and for
  timed metrics `mean_ms`/`max_ms`: `intake` (Worker-entry outcome and latency of
  creates and status changes), `auth` (credential refusals by reason, never a
  Client), `delivery` (each step's bounded outcome, including provider pacing),
  `delivery_confirmed` (acceptance to confirmed GitHub creation), `delivery_claim`
  (a due candidate not won: another execution's claim or pacing), `webhook` (GitHub's delivery log) and `scheduler` (each tick
  phase completed, timed out or failed, with its duration; written in one
  statement bounded at 0.5 s after the 58 s of phase bounds).
- `current` reports durably accepted requests per Client, the pending/failed/
  unknown backlog per Client with oldest due and unknown times, provider
  cooldowns, per-Slot fairness (due Slots, never-served Slots, least recently
  served), and status freshness (tracked requests, oldest observation, refresh
  backlog, oldest sweep).
- `independent` shows the [independent checker's](#independent-outage-checks)
  last reported state of each component, `current` for an hour after its
  observation and then `unknown` (`stale`), or `unknown` (`absent`) if never
  reported. The hour is a display rule, not an objective.
- `usage` attributes measured counts to a Client only through its reviewed
  mapping and verified credentials, and labels everything else shared and
  unestimated.

Aggregates (`operational_metric`, migration 0025) hold hourly counts and
durations per closed metric/outcome and Client only: no request, Reporter,
credential, URL, header, payload or exception text. They are kept 12 months,
then the tick deletes them in bounded batches; they never extend a request's
own retention. Workers Logs keep their configured retention, without Logpush.
Recording never blocks or fails the work it measures.

### Broken-webhook drill verification

`pnpm operator drill-verify webhook <ISO-start>` checks the drill's evidence in
D1 only, never contacting GitHub or Discord: a `webhook_rejected`/`webhook_failed`
incident opened after the start, its sent Discord notification, a later
acknowledged delivery, and a resolution. Each step is `observed`/`sent` or
`absent`/`pending`/`failed`; the verdict is `passed` only when all hold. The
local integration test proves the path with fake GitHub and Discord; it is not
staging evidence. The staging run is gated on authorized Discord setup (see the
[operations runbook](../docs/runbooks/support-operations.md#missed-or-broken-webhooks)).

## Independent outage checks

The independent checker (#139, `src/independent-checker.ts`) runs outside
Cloudflare in the `Independent service check` GitHub Actions workflow
(`.github/workflows/independent-check.yml`), every 5 minutes at best: GitHub
runs schedules late at times and only from `main`. It observes each component
separately, so an outage of one never implies another:

| Component | Observed through | Failing when |
|---|---|---|
| `worker` | The signed probe below, from GitHub's network | No connection, timeout, a `5xx`, or an invalid answer. A `401` means the checker's key is not registered: `unknown`/`unauthorized`, not an outage |
| `support_db`, `suppression_ledger` | The probe: each D1 answers `SELECT 1` within 2 s | It does not |
| `restore_gate` | The probe: the [restore gate](#maintenance-boundary-and-restores) | Maintenance holds or a recorded restore is not yet replayed (`pending`; the probe's `maintenance` field tells them apart); `unknown` when a database is down |
| `service_configuration` | The probe: whether the GitHub App and incident webhook secrets are set | Either is missing: the minute tick, and with it every Discord notification, cannot run |
| `github` | `GET https://api.github.com/rate_limit` with the run's token | No connection, timeout or a `5xx`; a rate limit is `unknown`. This is GitHub's API as the runner sees it, not the App's permissions |
| `discord` | `GET` of the stage's incident webhook, which posts nothing | No connection, `5xx`, or the webhook is gone (`destination_rejected`). A `429` is `unknown` and waited out |
| `dashboard` | `GET` of an approved Banquinha endpoint; a redirect or refusal still answers | No connection or a `5xx`. No endpoint is approved yet (`APPROVED_DASHBOARD_ORIGINS` is empty), so it is `unknown`/`not_configured` |
| `installation` | Nothing: WordPress is never probed, here or on page render | Never; see each Slot's [inventory](#slot-inventory) evidence instead |

`unknown` is neither failure nor recovery, and quiet traffic is never observed
at all. A failing observation opens an outage episode, extended by each later
failure and ended by a healthy one.

- **Reconciliation**: whenever the probe shows the Worker, main D1 and restore
  gate healthy, the checker posts its observations and every episode it still
  holds to `POST /v1/operations/checker/report`. The service records each
  component's latest state and reconciles each episode into the component's
  open `component_unavailable` incident (`detail` names the component), opening
  one if none is open, with the episode's own first and last failure times.
  An episode already recorded only extends its own incident while that stays
  open, so a resent report, or one retried after a lost response, never opens
  a second incident, even after the first was resolved. A reported healthy
  component also ends its earlier episodes, including any the checker has lost
  or expired. Any staff member can resolve the incident once every episode in it has
  ended.
- **Notices**: while the service cannot record an episode, or records it but its
  configuration keeps its notifier from announcing it, the checker posts its own
  minimal notice to the stage's incident channel (stage, component, bounded
  code, times, runbook link; no mentions) and edits it when the episode ends.
  Once the service holds the incident, its own notifier announces it as usual:
  expect one checker notice and one claimable incident message for a storage
  outage. Nothing is posted through a Discord observed failing, and a Discord
  outage itself is carried by the service's incident. A `429` defers every
  checker request to Discord until Discord's `retry_after`, persisted across
  runs. A lost response leaves the notice `outcome_unknown` and it is retried
  up to 3 times, so Discord may show it twice; exactly-once is not promised.
- **No path**: a failing episode with no confirmed notice that the service does
  not hold and announce fails the run, so GitHub's failed-run notification is
  the remaining signal. So does any missing or malformed checker configuration
  or previous state; neither is ever shown as healthy.
- **State and expiry**: the run's state (episodes, notice message IDs, the
  Discord cooldown) and its sanitized summary are the `independent-check-<stage>`
  artifact, kept 7 days and read by the next run from `main` only. The service
  refuses evidence older than 7 days. An episode the service has not reconciled
  within 7 days is dropped and listed as expired in the run summary, so follow
  it up by hand from that run. Each run's summary is also its job summary.

The probe, `GET /v1/operations/checker/probe`, is answered before the restore
gate and performs no recovery, so it works while storage is down. It returns
only `worker`, `support_db`, `suppression_ledger`, `restore_gate`, configuration
presence and the time, never a record, value or secret. Both checker routes need
the checker's own signature: the operations API's wire format with label
`gq-support-checker-v1` and `GQ-Checker-*` headers (`GQ-Checker-Run` names the
workflow run), verified against the stage's `SUPPORT_OPERATIONS_CHECKER_KEYS`
variable (a JSON object of key ID to base64 raw Ed25519 public key; unset or
malformed closes both routes). The probe is signature-only, as a replay reveals
nothing beyond those states. It compares restore epochs and reads the maintenance
boundary (`maintenance`: `active`, `inactive` or `unknown`) with bounded reads,
and never performs replay or other recovery; ordinary gated traffic owns that path.
A report's request ID is single-use for 10
minutes. A staff, Discord or installation identity never verifies here, and the
checker key grants nothing else.

Verification: `pnpm exec vitest run test/independent-check.test.ts` drives the
runner against the Worker's HTTP entry over local D1, fake Discord and GitHub,
with injected Worker, D1, ledger, restore-gate, configuration, GitHub, Discord
and dashboard failures and a controlled clock. It is not staging evidence; see
the [operations runbook](../docs/runbooks/support-operations.md#independent-outage-checks)
for setup, drills and what has not been done.

## Slot inventory

Operators and staff see one restricted inventory row per mapped Slot of the
stage (#137, `src/inventory.ts`, migration 0024), through
`GET /v1/operations/inventory` or `pnpm operator inventory <slot>`. Nothing in
it is a health check: it reports recorded evidence and says what it does not know.

- **Reviewed configuration** (changed by reviewed PR): Client, project, Slot and
  environment, repository ID, reviewed `owner/name` and GitHub App installation
  from the [repository mapping](#suspended-mappings); its optional `deployment`
  (`central`, `native` or `manual`) and `responsibleTeam`; and per stage
  (`stageInventories`, chosen by the pinned App slug like mappings) the Tipme
  account, the Alchemy `GQSupportWorker/<stage>/<logical ID>` resource
  references, and credential custody. Resource IDs come from Alchemy state, not
  this file. An unset value is shown as `null`, never a default. No Slot has a
  reviewed deployment method or team yet, and no credential owner is assigned.
- **Versions**: `desired`, `attempted` and `observed` are separate. The
  installation's signed enrollment records the plugin version it reports
  (`source: enrollment`), and every later `gq-support-v2` request the version
  it signs (`source: signed-request`, at most hourly per version). The
  [approved release](#approved-releases) is every Slot's `desired` version
  (`source: release`) unless a later Slot record says otherwise; its fleet
  dispatch is never recorded as an attempt or observation. Everything else is
  appended by an Operator from deployment or maintenance evidence. `update.outcome` is `none` without an
  attempt, `confirmed` only when an observation of the attempted version is at
  or after the attempt, `failed` only when a failure of that version is
  recorded, whichever is later, and otherwise `unconfirmed`. A dispatch alone
  is never success.
- **Observation display rule**: an observation is `current` for 24 hours, the
  previous-release compatibility window, and then `unknown` with reason
  `stale`; none at all is `unknown`/`absent`. The last value and its time stay
  visible. This is how stale evidence is labelled, not a service objective, and
  missing traffic is never read as healthy. WordPress page rendering makes no
  remote check to refresh it.
- **Independent contact**: staff see only `verified` or `unverified` and the
  verification time. The route, responsible responder, method, evidence
  reference and verifier are restricted to the Operator CLI. Only the latest
  record verifies, and only when it is a `separate-device-drill`: a live
  contact to the Client's existing contract route, from a device separate from
  the WordPress installation, reaching the named responder. An `attestation`
  is recorded but stays unverified, as do records from before migration 0031.
  `inventory-readiness` lists each Slot's blockers (`contact_unverified`,
  `contact_attestation_only`, `contact_incomplete`) and the exact onboarding
  blocker. The route is never invented, messaged or tested by the service.
- **Credentials**: staff see each credential's ID, purpose, owner, stage,
  expiry state (`valid`, `expired`, `never` or `unknown`) and last verified
  rotation date. Locations (secret names and stores), the revocation runbook and
  rotation evidence are shown only by `pnpm operator inventory-credentials`.
  Values are never recorded anywhere in the inventory.

```sh
pnpm operator inventory <slot> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator inventory-credentials --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator inventory-record <slot> <desired|attempted|observed|failed> <version> <at> <evidence-ref> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator inventory-contact <slot> '<route>' '<responder>' <separate-device-drill|attestation> <verified-at> <evidence-ref> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator inventory-readiness --stage <stage> --account-id <account-id> --database-id <database-id>
```

`at` and `verified-at` are ISO UTC times of the evidence, never later than now;
`evidence-ref` is a link or reference without spaces (for example a CI run URL),
never a credential. Each record is one appended row carrying its actor and
recording time, so it is its own audit entry and is never edited; correct a
mistake by recording newer evidence. A superseded contact route goes 30 days
after the record replacing it; a Slot's rows go 30 days after its offboarding,
or 30 days after the cleanup pass first finds it unmapped without offboarding
(migration 0031; mapping it again clears that clock).

## Approved releases

The release policy (#141, ADR 0021, `src/release-policy.ts`, migration 0027)
decides which plugin versions may start new Support requests and status changes.
The [API contract](../docs/support-api-contract.md#release-policy) describes what
installations see; the [runbook](../docs/runbooks/support-operations.md#approved-releases-and-intake-enforcement)
the procedure.

- A **candidate** is recorded only from a release workflow's artifacts: the
  version and SHA-256 come from the ZIP's actual bytes, which the manifest and
  `provenance.json` must both match, and the provenance names the run and source
  commit. The Operator adds the Worker commit, contract version and schema
  migration range it was verified with, and whether the package signs its
  version (`signed`) or is a pre-#141 `unsigned-legacy` package. Once any signed
  release has been approved, production and recovery approvals refuse unsigned
  legacy packages; legacy evidence is only for bootstrapping. A candidate is
  never approved by being recorded.
- An **approval** names the approved release the Operator expects (`none` for
  the first), so a concurrent approval loses. `production` needs a version never
  approved and, after the first, the approved release's recorded dispatch. The
  Worker must serve its contract version. The previous approved release is the
  one it replaced. A `recovery` approval is made only by `release-withdraw`
  ([fleet rollout](#fleet-rollout-and-recovery)).
- A **dispatch** is recorded once for the approved release, only by
  `fleet-launch` or `release-withdraw` at the actual start of distribution, after
  the release's gates and deployment evidence check out. The previous release's
  24-hour window runs from it; before it, the previous release is still accepted.
  Nothing infers a dispatch, and no typed time or reference records one.
- Every record is one append in a single statement, carrying its actor, time and
  evidence: its own audit row, never edited. No report content, Reporter ID or
  secret is stored. Release decisions touch no key, suppression or intent, so a
  recovery never revives revoked access or erased work.
- **Enforcement** is reviewed per stage in `stageReleaseEnforcement`. `enforced`
  refuses other versions and fails closed without a well-formed approved release;
  `staged` evaluates and reports but keeps intake open, only so this Worker can
  deploy before any release is approved; an unknown stage fails closed. Both
  stages are `staged` now: production enforcement is a readiness gate, not active.
  Staff see the enforcement, approved and previous release in
  `GET /v1/operations/inventory`; only the Operator CLI records them.

```sh
pnpm operator release-status --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator release-candidate <artifact-directory> <worker-commit> <contract-version> <schema-from>-<schema-to> <signed|unsigned-legacy> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator release-approve <package-version> production <expected-current-release-id|none> <evidence-ref> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
```

`artifact-directory` holds the downloaded `gq-support.zip`,
`gq-support.manifest.json` and `provenance.json` of the release workflow run.
After a lost response, check `release-status` before retrying an approval: a
committed one makes the retry's expectation stale.

## Native updates

Installations whose reviewed Repository mapping has `deployment: "native"`
update through WordPress's own updater (#142, `src/update-access.ts`, migration
0028); the [runbook](../docs/runbooks/support-operations.md#native-wordpress-updates)
has the procedure and the [API contract](../docs/support-api-contract.md#native-updates)
the routes.

- **Update grants.** A native installation generates its own Ed25519 update key
  (`wp gq-support update-key`); the Operator grants its public key to one Slot
  until an expiry of at most 400 days. The key ID is the hex SHA-256 of the raw
  public key. The Slot's newest grant supersedes its older keys, a key is never
  granted to a second Slot, and a revocation is never lifted. Revocations go to
  the suppression ledger first (`--ledger-database-id` is required), so a restore
  of the main database cannot revive a grant. Rotation also requires the ledger
  and revokes old keys before granting the replacement; failure leaves the old
  keys revoked. Every grant and revocation is one
  audited append. The grant is independent of the Installation credential:
  `revoke <slot>`, `GQ_SUPPORT_DISABLED` and disconnecting leave it working.
- **What it authorizes.** Only `GET /v1/updates/gq-support` (the approved release
  once its dispatch is recorded, and a 15-minute download grant) and the package
  download with that grant. Signed requests use their own `gq-support-update-v1`
  scheme and replay table; no installation signature verifies there, and no
  update signature verifies anywhere else. A plugin from #144 signs metadata
  checks as `gq-support-update-v2`, which adds the digest of its installed files
  (`GQ-Update-Installed-Files`): the only native evidence that verifies an update.
  The offer names the release's `kind` and its verified `files_sha256`.
- **Package bytes.** The Worker reads the approved version's `gq-support.zip`
  from the private repository's GitHub Release with the narrow
  `UPDATE_PACKAGE_TOKEN` secret (`src/package-source.ts`): the token goes only to
  api.github.com in a header, the one storage redirect must be an HTTPS GitHub
  asset host and gets no credential, responses are bounded in time and size,
  and the bytes must match the approved SHA-256 before anything is served.
  Without the secret, native updates answer 503. The gated deploy uploads it from
  the stage Environment's `SUPPORT_UPDATE_PACKAGE_TOKEN` and removes it when unset.
- **Inventory.** A served package is `attempted` (source `native-update`); the
  installed version the next signed check reports is `observed`. Staff see each
  Slot's grant state and expiry, never a key. A signed files digest is kept per
  Slot (migration 0030), at most hourly unless it changes.

```sh
pnpm operator update-access-status <slot> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator update-access-grant <slot> <update-public-key> <expires-at> <evidence-ref> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
pnpm operator update-access-revoke <slot> <key-id|all> <evidence-ref> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
```

## Central deployment

Installations whose reviewed Repository mapping has `deployment: "central"` get
the approved release from an Operator through the hosting access GETQUICK
already holds for them (#143, `src/central-deployment.ts`, migration 0029); the
[runbook](../docs/runbooks/support-operations.md#central-deployment) has the
procedure. Nothing is installed on the site for it, so it works with report
submission disabled or the Installation credential revoked.

- **Targets.** `stageCentralTargets` lists each Slot's reviewed runner (such as
  `ssh -o BatchMode=yes <alias>`), WP-CLI with its `--path`, the installed plugin
  directory, an upload directory and its deployment `source`. Only
  `plugin-directory`, where the installed files are what persists, is applied: a
  `composer` site would reinstall its locked version on its own next deployment,
  and no reviewed adapter updates that lock, so it is refused and shows blocked. Every token must be a shell-safe literal,
  because ssh joins its arguments into a remote command. The runner
  authenticates with the Operator's own configuration and agent; no credential,
  host secret or URL belongs in the file, and none is printed or recorded. No
  stage has a target yet, so `central-apply` refuses every Slot until one is
  added by reviewed PR.
- **Bytes.** The approved version's `gq-support.zip` from its downloaded release
  workflow artifact (`gh release download v<version>` or the run artifact), used
  only when its SHA-256 is the approved one. The expected file digests come from
  that ZIP's own entries. The fleet coordinator can pass another `PackageSource`,
  such as the GitHub Release source native updates use.
- **What runs.** Each command is spawned directly, without a local shell, bounded
  in time and output, with stderr discarded: `test ! -L`, `wp plugin get` and
  `is-active`, `cp /dev/stdin` of the bytes, `sha256sum` of the upload, `wp plugin
  install <upload> --force` (which keeps the activation state), then `find` and
  `sha256sum` of every installed file, and `rm` of the upload.
- **Outcomes.** One `central_deployment` row per application, written before the
  host is contacted in a statement that rechecks the release is the approved,
  dispatched one, the Slot is not offboarded and no other application to it is
  running. Approval and offboarding are checked again just before WordPress
  installs, in the main database and the suppression ledger (`--ledger-database-id`
  is required): an offboarding a restore dropped from the main database, a
  maintenance begun or a restore recorded since the application started stops it.
  An install already asked for may still finish after an offboarding; its
  read-back outcome is recorded, never assumed. `verified` needs the approved version and exactly the approved files;
  `failed` is a read-back that confirmed otherwise; `unknown` is a lost answer after
  the install was requested; `unreachable` changed nothing; `refused` (a symlinked
  checkout, an unavailable plugin, a downgrade outside a recovery approval, or a
  superseded release) changed nothing either. A run on an already verified
  installation verifies it without reinstalling, so retry `unknown` with the same
  command.
- **Inventory.** A requested install is `attempted` (source `central-deployment`),
  and so is an unfinished record whose Operator process ended; a read-back is
  `observed`; only a confirmed failure is `failed`. Each Slot shows its latest
  central outcome. Unreachable installations stay unknown.

```sh
pnpm operator central-apply <slot> <release-id> <artifact-directory> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
pnpm operator central-status <slot> --stage <stage> --account-id <account-id> --database-id <database-id>
```

## Fleet rollout and recovery

One approved release is dispatched to every eligible Slot together, and each
Slot's outcome is tracked and verified on its own (#144, ADR 0021,
`src/fleet-rollout.ts`, `src/release-gates.ts`, migration 0030); the
[runbook](../docs/runbooks/support-operations.md#fleet-rollout-and-recovery) has
the procedure. There are no canary cohorts and no per-installation approvals.

- **Gates** (`release-verify`). From GitHub's own records, read with the
  Operator's `gh` login, never typed in: the candidate's release workflow run
  (named by its provenance) at the release commit for `package` and
  `compatibility` (installed-package cells and pre-release compatibility); CI on
  `main` at that commit for `security` (secret scan, dependency audit, PHPCS and
  PHPStan), `privacy` (the Worker suite and required validation) and
  `performance` (asset size gate); and the gated staging deployment of the
  candidate's Worker commit for `staging`. Every gate passes or nothing is
  recorded, and the refusal names each failure. The digest of the candidate's
  files is computed from its exact bytes.
- **Launch** (`fleet-launch`). Needs the recorded gates for the approved bytes;
  the gated deployment of the release's Worker commit to this stage, with its
  safe plan and apply record (`infrastructure`; the plan digest covers protected
  resource identities and planned actions at that commit, not every
  configuration value, and the recorded evidence says so); the live migration
  state from `__alchemy_migrations`, which must be a gapless run of reviewed
  migrations with their checksums inside the release's tested range; and a
  compatible recovery package: the previous approved release, unless a recorded
  rollback boundary gave it up. Destructive migrations after 0029 need such a
  boundary. Each refusal lists what is missing. The launch and then the dispatch
  are one conditional statement each; the dispatch time is the actual start.
- **Status** (`fleet-status`, and `fleet` in `GET /v1/operations/inventory`).
  Per Slot: `verified` only when the installed files are exactly the release's
  (a central read-back of every file, or a native signed files digest); `failed`
  for a confirmed mismatch; `unknown` for a lost or abandoned central outcome, a
  native version signed without its files, or a Slot silent for 24 hours;
  `attempted`, `applying`, `pending`, `unreachable`; `blocked` with why (no
  deployment method, a manual install, no update access, no or an unsupported
  central target); `offboarded` Slots are out of scope. `converged` needs every
  in-scope Slot verified. The previous release's window state is shown.
- **Central runs** (`fleet-run`). Applies the release to due central Slots, four
  at a time, through the central adapter. An `unknown` or abandoned application
  is reconciled by read-back only, never reinstalled blindly; a Slot with three
  possibly-applied attempts is left for an Operator. Once an application finishes
  with the release no longer approved, no further one starts.
- **Withdrawal** (`release-withdraw`). Approves an earlier package as `recovery`
  only if it passed its gates, was launched before, was never withdrawn, its
  contract is served and the live schema is compatible with it (no live
  destructive migration past its tested range, not below a rollback boundary);
  then launches it. From that statement on, the bad release is neither offered
  nor served. Nothing reverses a migration or restores D1: an incompatible
  rollback is refused, and recovery is forward repair.
- **Rollback boundary** (`release-boundary`). Recorded only once every in-scope
  Slot verified the dispatched release and the previous release's window ended.
- **Incidents.** `release_update_failed` groups confirmed failures of the
  dispatched release by release; `release_migration_failed` is the last
  Operator read of the live migration state not being `ok`. Unknown and
  unreachable Slots are not alerted as failures. They follow the existing
  grouping, claim and notification rules, with no reminders or escalation.

```sh
pnpm operator release-verify <package-version> <artifact-directory> <ci-run-id> <staging-deploy-run-id> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator fleet-launch <release-id> <deploy-run-id> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator fleet-status [release-id] --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator fleet-run <release-id> <artifact-directory> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id> --ledger-database-id <ledger-database-id>
pnpm operator release-withdraw <release-id> <recovery-version> <deploy-run-id> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
pnpm operator release-boundary <release-id> <schema-floor> <opaque-actor> --stage <stage> --account-id <account-id> --database-id <database-id>
```

The commands need `gh` logged in with read access to the repository's Actions,
and a clean checkout: the reviewed migrations must match `migrations/checksums.txt`.

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
  unclaimed incident. A resolved incident updates its existing notice even
  after a multi-day scheduler outage, while the incident is still retained.
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
  attempt. The cooldown persists across ticks and newly queued sources.
  Error codes are bounded: `outcome_unknown`, `rate_limited`,
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

### Staff Support request feed

`GET /v1/operations/requests` uses the same signed dashboard identity, staff
roster and replay protection as the other operations routes. It returns
`{ items, next_cursor }`, with optional `limit` (1–200, default 50) and opaque
`cursor` query parameters for stable newest-first pagination. Query parameters
are part of the signed path. Each item contains only the opaque request ID,
Slot/Client/project/environment, acceptance time, actual delivery outcome,
last-observed Support status and a trusted GitHub issue link when the reviewed
repository mapping still matches. Submitted text, Reporter identity, erased
and superseded reports, and requests outside the current reviewed mappings are
excluded. Responses are `no-store`; this is a staff operational view, not an
alternate Reporter API or incident store.
