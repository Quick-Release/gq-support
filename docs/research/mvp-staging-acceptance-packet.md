# MVP staging acceptance packet — #20 / #29

Prepared 2026-10-27. **Preparation only; no staging acceptance or action approval.**
This is the single execution-review packet for the prepared candidate below.
[Operational readiness](operational-readiness.md) retains the criterion history;
[integration readiness](mvp-integration-readiness.md) retains implementation history.
Use current source and this packet where historical paragraphs describe older guards.
No issue boxes are changed. #20 has seven unchecked criteria; #29 remains open.

## Public candidate and evidence

- Main baseline: `6e2a792fe74f95a1be3e367bab97909443039ea2`, unchanged/unmerged
  in the supplied evidence. Prepared source: [PR #132](https://github.com/Quick-Release/gq-support/pull/132),
  `t3/planner-startup-diagnostic`, **`ffb7d57b5bc912ea9a35dc2c22ff0edcbb6cb85f`**.
  This includes complete prepared histories #118 and #119–#131. This docs PR
  preserves that history; it does not approve, merge or deploy it.
- [Integrated CI 40575937013](https://github.com/Quick-Release/gq-support/actions/runs/40575937013/attempts/2)
  at that source succeeded, attempt 2. Supplied execution evidence: all four
  startup stages; 1,335 Worker tests / 55 files plus two configured-runtime cases;
  all nine WordPress/PHP cells; PHPCS/PHPStan, JS lint, size/package, dependency
  audit, secrets and Required validation/PHP result/Worker result passed.
  Simulated-failure and benchmark skips were intentional. Attempt 1's stable-counters
  cell cancelled at 45 minutes during Playwright apt-mirror download, before
  DDEV/tests; the single-cell retry and downstream checks passed. Missing
  `/usr/bin/bwrap` was fixed by installation. Parent #119 CI tests passed.
- Supplied fresh two-axis review: `cd1345e..ffb7d57`, commits `19e5c4f`,
  `6c3de98`, `ffb7d57`: Standards 0, Spec 0. Five diagnostic tests reran;
  cancellation was source-reviewed. Earlier stack reviews have varying scopes;
  this is **not whole-candidate approval**. No new review was commissioned here.
- This preparation made one bounded read-only hosted snapshot: run ID/head/attempt/
  conclusion, its artifact metadata, and #132 head/base. It confirmed the CI identity
  above. No artifacts were downloaded or byte-verified, no checks watched or rerun.
  Test counts/review results above are supplied evidence, not reruns by this packet.

### Release pair to freeze before a drill

The public source identities below are known. They are not a published release.

| Component | Pinned identity / SHA-256 | Remaining evidence |
| --- | --- | --- |
| Plugin source | Header version `0.1.10`, source SHA above | Exact release version/tag, previous fleet package and installed ZIP digest |
| pnpm lock | `a4a0caf12a6d5d41937064c0742ecdebbfc72f5da64949e28870020be7b37e66` | Match release provenance |
| Composer lock | `d57066bbb968f0f26d6a04b1f85c5cf792335cc556786f1a6e85e38df4d81474` | Match release provenance |
| SupportDB schema | `worker/migrations/0001`–`0019`; checksum-list file digest `a8377afc4c9d5d74025bc36420ae8ef3c75d3b7c28f2bdf1e0c07d03a776c507` | Compare every SQL byte/hash with applied native history and pending set |
| SupportLedger schema | `worker/ledger-migrations/0001`–`0005`; checksum-list file digest `0f4195111deaabd5542e8928c43639181df828adb0e72f7d6167eb4a24c2657d` | Same comparison, independently; never restore/down-migrate ledger |
| Worker | Source SHA above; Alchemy `2.0.0-beta.83` | Retained build digest, final candidate digest, actual Worker version/deployment IDs, bindings and post-custody readback |

Checksum-list digests were computed from tracked bytes in this preparation;
they are not the planner's aggregate migration digest. Compare SQL itself too.
[Release workflow](../../.github/workflows/release-plugin.yml) builds `release-candidate`
with `gq-support.zip`, `gq-support.zip.sha256`, `gq-support.manifest.json` and
`provenance.json`. Bind artifact ID, producing run/attempt/head, archive digest,
inner ZIP digest, version, lockfiles, installed-package cells and compatibility
results. After downloading that exact artifact, existing
`node scripts/ci/release-package.mjs verify <download-directory>` verifies its
ZIP/manifest; separately compare provenance to authenticated run metadata and
trusted job-output digest. Do not trust a self-consistent replacement manifest.
Publication promotes tested bytes; it is a separate approved action on main.

The CI size job packs/verifies a ZIP but does not upload it. The snapshot's
14 report artifacts contain **no `release-candidate`**. Examples of exact report
identities (GitHub archive digests, not inner package digests):

| Artifact ID / name | Archive SHA-256 |
| --- | --- |
| `12770697635` / `runtime-stable-counters` | `4c13b85965db3c2f409ac4d36410393b014bec950a7af340b0a269773371ea2f` |
| `12770613895` / `resolved-runtime-matrix` | `7b32287c294664f3a6f0a30bb3a807c877214b1761dcf02458c3e84038919945` |
| `12770542490` / `resolved-runtime-matrix` | `0262ee3f82aa9b9c6a7dff4978c975cb47f2c2107a199cd88217c9e1e7b1a83e` |

Two same-named matrix artifacts exist across the run; select by ID and producing
job/attempt, never name alone. All listed were unexpired at snapshot (30-day
retention). Contents/attempt attribution remain unverified. The older #118 ZIP
`a833637e…` is historical evidence only. A release artifact, complete provenance
and previous compatible plugin/Worker/schema pair are still missing. No Worker
build/deployment digest can be inferred from CI success. Changes to reviewed
source configuration or a later main integration require a **new immutable head,
digests and applicable validation**, not relabeling this run as that head.

## Evidence custody and human authority

Use an existing restricted operational record; do not create a new journal or
monitoring service. The following are **field requirements, not attestations**.
Unfilled/unknown fields fail the relevant gate. Even non-secret private manifests
stay private: never commit real origins, contact URLs, endpoint/binding manifests,
access grants, inventory or raw state to this public repository or chat.
Public results contain only opaque record IDs, sanitized counts/times/outcomes,
approved release digests and scoped approval references.

| Class / record identifier | Required fields |
| --- | --- |
| RESTRICTED `R-target` | Owner/reviewer/date; account/stage/stack; exact `ReviewedEndpoint` fields: origin, `/state`, protocol 7, script/main module/bundle digest/strong ETag/version/deployment; binding names/types and DO/Secrets Store identities; graph FQN/type/kind/instance/provider version/required decoded paths; output paths; both distinct DB IDs/names/instances, EU/retain and primary-only bindings; authoritative native State and remote migration histories |
| RESTRICTED `R-release` | Final head and lock/SQL hashes, artifact/run/attempt IDs, downloaded-byte verification result, retained bundle and final candidate digests, release ZIP/version, deployed identities, previous compatible pair, enrolled-v1 census/overlap, supported pair-test results, canary and reversal criteria |
| RESTRICTED `R-custody` | Per-action principal, permission scope, expiry, delivery source/custodian/recovery access and proof; numeric vvaz/gmarques IDs, repository ID, actual protected branch/environment policy and run review; independent D1 Operator access; App registration/permissions/pins/fingerprint; remote RPC permission/result proof; runner trust/kernel/bwrap/namespace/dependency proof |
| RESTRICTED `R-window` | Owner vvaz OR gmarques, target, window ID/start/end/duty; every external writer and endpoint deployer excluded from acquisition through apply **and incident reconciliation**, including local operators, other repos/workflows/schedulers, credential holders, old runners and recovery scripts; lost-runner handoff and unresolved-marker custody |
| RESTRICTED `R-operations` | Actual Client/project/Slot/environment/fleet/resource inventory, owners/deputies, independent contract contact/responder and separate-device verification; effective logs/Discord retention, sampling/access/exporters; measured per-Client intake/delivery/status/backlog/usage/fairness with opaque attribution; incident destination access, acknowledgment/escalation/dedup and failed-route coverage decision |
| RESTRICTED `R-drill` | One row per step below: immutable pair, actor, fixture/isolation, approval/action scope, start/deadline/end, before/after counts/times, evidence references, expected/actual outcome, abort/recovery actions, outstanding uncertainty, vvaz OR gmarques review/signature/time |

SECRET delivery is **parent-only, via `request_secret` when execution is ready**.
No private inputs are requested by this child. [Entry source](../../worker/deploy/planning-entry.ts)
consumes owner-created, single-link mode `0400` files in owner-only mode `0700`
`/dev/shm/gq-protected`, unlinks them on read, and rejects symlinks/ambient overrides.
These are reserved delivery names only; supplying paths does not grant authority:

| Environment file pointer | Reserved filename under `/dev/shm/gq-protected/` |
| --- | --- |
| `ALCHEMY_STATE_BEARER_FILE` | `alchemy-state-bearer` |
| `GITHUB_APPROVAL_READ_TOKEN_FILE` | `github-approval-read-token` |
| `CLOUDFLARE_PLANNING_READ_TOKEN_FILE` | `cloudflare-planning-read-token` |
| `CLOUDFLARE_APPLY_TOKEN_FILE` | `cloudflare-apply-token` |
| `GITHUB_APP_PRIVATE_KEY_FILE` | `github-app-private-key` |
| `GITHUB_WEBHOOK_SECRET_FILE` | `github-webhook-secret` |
| `GITHUB_WEBHOOK_PREVIOUS_SECRET_FILE` (rotation only) | `github-webhook-previous-secret` |
| `DISCORD_ALERT_WEBHOOK_URL_FILE` (enabled only, exact path required) | `discord-alert-webhook-url` |
| `SUPPORT_OBSERVER_READ_TOKEN_FILE` (only if separately approved/enabled) | `observer-read-token` |

The broad existing Alchemy state bearer under protected job custody is approved
policy. Its service-side write/cross-stack scope remains broad; code confinement
and owner exclusion are required. That policy is not candidate approval. No new
observer activation is required/authorized by this packet. Keep optional observer
mode disabled unless separately reviewed; do not manufacture coverage evidence.
Independent Operator and webhook-runner credentials use existing custody processes,
not these deployment file pointers by assumption.

Human boundaries are separate: source/configuration and settings approval;
authenticated read/Test F scope; staging apply; each disruptive drill/notification;
restore and recovery release; delivery re-enable; package publication/installation;
canary rollout and production release. vvaz OR gmarques may act, with no invented
primary/backup order. Parent obtains each concrete approval; none is supplied here.
Post-plan `approve-plan` is an existing human-created command on #20 bound to the
live run/attempt/head/candidate/nonce. This task posts no comment or review.

## Current entry prerequisites — source controls

Read [planner implementation](protected-native-planner-implementation.md#authenticated-retained-process-continuation-follow-up-to-pr114)
with [entry](../../worker/deploy/planning-entry.ts),
[approval verifier](../../worker/deploy/github-candidate-approval.ts),
[native policy](../../worker/deploy/native-plan-policy.ts) and
[migration profile](../../worker/deploy/d1-migration-profile.ts).

1. `reviewedPlannerConfig` is **undefined**. The endpoint contract exports are
   also unset; the actual entry consumes `reviewedPlannerConfig.endpoint`, not an
   environment manifest. There is no private-manifest CLI loader. A reviewed
   configuration change and safe private delivery mechanism are still needed;
   do not publish restricted values merely to fill the source object.
2. Protected profiles are `staging` / `getquick-support-staging` and `prod` /
   `getquick-support`, stack `GQSupportWorker`, Tipme account. They are not local
   Alchemy login profiles. Personal-stage behavior does not prove either profile.
   Entry requires clean exact HEAD, `refs/heads/main`, repository/run/attempt and
   matching stage. The prepared unmerged branch cannot be applied as-is.
3. Actual verifier requires protected main (admin enforcement, approving PR review,
   no force pushes/deletions); protected-branches environment mode without custom
   branch policy; exactly both named numeric user reviewers, prevent-self-review,
   an actual run environment approval, current collaborator permissions and a fresh
   post-plan command from either authorized person. Attempt must be **1**: deploy
   rerun is refused; CI attempt 2 above is a different workflow and valid evidence.
   Historical metadata showed missing reviewers/custom branch policy. Current
   enforcement is not attested and configuration changes require separate approval.
4. Independently attest real endpoint deployment/version/100% traffic, ETag and
   module-byte digest, exact bindings/graph/output decoding, no unsettled/history/
   replacement rows. Both existing D1s must retain identity, EU jurisdiction and
   `retain`; no bootstrap/adopt/replacement. Obtain native `__alchemy_migrations`
   column/history agreement with State hashes and exact source bytes in **both** DBs.
   Pending additions are at most four per DB and must pass the narrow SQL grammar.
   Pending ledger `0002_revocations.sql` has INSERT-SELECT/DROP/RENAME: **this candidate
   cannot apply that history**. Already-applied matching 0002 is preserved, not
   rerun. Disagreement/legacy history requires separately reviewed reconciliation;
   never rewrite hashes, mark applied, restore ledger or bypass policy. Arbitrary
   unsupported SQL/imports/replication/resource changes are non-MVP, but an actual
   target with unsupported pending history is a concrete deployment blocker.
5. Prove the protected Linux runner can run `/usr/bin/bwrap`, unshared namespace,
   Node, tracked-source loader/guard/dependencies. Existing command from `worker/`:
   `node scripts/planning-startup-diagnostic.mjs`. CI startup success is useful;
   it does not attest a different protected runner. No command is run here.
6. Prove deployment credential permits installed Wrangler's remote service binding
   RPC and `checkGitHubAppKey` on the owning Worker, not merely HTTP metadata.
   [RPC implementation](../../worker/deploy/check-deployed-github-app.ts) uses
   `getPlatformProxy` with remote bindings and checks identity/fingerprint. Local
   fake RPC is not remote permission proof. There is no separate documented
   protected read-only RPC CLI; scope this verification before executing it.
7. Reviewed source/migrations/target/state/window, cached bundle and migration
   summaries must bind the final candidate; retain the native plan/context through
   approval and one-shot apply. Entry command from `worker/` is
   `node --import ./deploy/planning-loader.mjs deploy/planning-entry.ts` in the
   protected workflow. **No second `alchemy plan/deploy` handoff**. Ordinary CLI
   staging/prod paths refuse; stale readiness examples are not an execution path.
8. Keep all writers excluded. Local lock/identical hashes/concurrency are not
   remote CAS or ABA proof. Failure, cancellation, expiry or unknown write retains
   `/dev/shm/gq-support-<stage>-writer.lock`; no force-clear/expiry recovery exists.
   Runner loss does not end external exclusion. Establish remote D1/State/Worker
   outcomes and in-flight completion, then separately review reconciliation before
   any marker removal/new candidate. Reboot/new runner is not a workaround.

## Criterion coverage and exact remaining verification

Every row remains open until its evidence and human review are recorded.

| Gate | Existing evidence | Bounded remaining verification below |
| --- | --- | --- |
| #20.1 compatibility/staged rollback | CI/runtime matrix, digest promotion workflow, additive v1 contract | P0/P1 freeze actual ZIP/Worker/schema and fleet pairs; D5/D6 upgrade/recovery/canary; no native updater MVP requirement |
| #20.2 inventory/custody/offboard | Stage topology, App custody runbook, offboard/revoke/ledger code | P0 restricted actual inventory/permissions; D3/D4 suppression, revocations, purge and Client handoff |
| #20.3 metrics/privacy/retention/access/Client | Lifecycle sanitized correlation tests and privacy design | P0 effective logs/traces/Discord retention/access; D1–D6 measured intake, confirmed delivery and status separately, backlog/pace/usage by opaque Client; no dashboard/exporter or billed attribution claim without readback |
| #20.4 delivery/webhook/credential/retention/migration alerts | Discord allowlist and existing runbooks; CI/preflight refusal | D1 receipt/ack/dedup; D2 ambiguity; D4 retention; P0 failed-deploy/route/missing-Cron coverage; credential-class evidence. No arbitrary auth rejection treated as provider incident |
| #20.5 broken webhook alert | #57 historical 401 rejection/sweep evidence; candidate routing code | D1 current signed rejection → actual Discord receipt/ack → restore; 401 does not prove external/platform 5xx |
| #20.6 recovery plan | Delivery/ledger/privacy/containment/package automated proofs | This finite plan plus D2–D6 actual scoped outcomes; D1 backlog replaces obsolete queue/DLQ replay requirement |
| #20.7 production checklist/sign-off | Security/privacy/performance gates and operational checklist | P0 immutable evidence; all applicable drills, restricted attestations, canary and final vvaz OR gmarques signature; separate prod Test F/release approval |
| #29.1 lifecycle | CI browser requests/status-change specs, signed Worker/provider lifecycle | Preserve Submitted text, open/closed projection, internal comments; close/reopen **included** by ADR 0020, original “absent” wording stale; D6 intended pair |
| #29.2 launcher/accessibility | Nine CI cells, launcher/session specs, keyboard/focus/names/status/responsive/reduced-motion checks | Bind resolved cell/runtime reports to head; D5/D6 actual package/disable smoke; no runtime rerun for this docs change |
| #29.3 provider/recovery | 1,335 Worker tests, local D1/provider failure seams | D2/D3 unknown/late success/order/rate/duplicate fences on intended staging; no Queues/DLQ |
| #29.4 scopes | Own/manager/cross-Client and membership-denial tests | Bind CI/source evidence; D6 synthetic two-Slot denial sample, no real Client data |
| #29.5 CI | PHPCS/PHPStan/Plugin Check/build/typecheck and behavioral cells in run above | Download/verify selected report provenance and release installed-ZIP cells; simulated/benchmark skips explicit |
| #29.6 correlation/privacy | Lifecycle leak tests; enabled Discord Logs-on/traces-off custody | P0/D1 effective readback/access/retention and sanitized live correlation. Traces return only after disabled credential-removal verification |
| #29.7 reproducibility | Fresh CI installations and controlled provider adapter; configured-runtime cases | Bind reproducible commands in lifecycle verification to actual runtime reports and exact ZIP; controlled adapter does not prove live provider/RPC |
| #29 dependencies #25/#26/#17/#19/#20 and #67 | Delivery/projection, outage decision, CI and fail-safe implementations plus lifecycle verification | #25/#26 suite provenance; #17 independent contact + outage handoff; #19 exact package/runtime evidence; #67 D5 full outage matrix; **#20 remains blocking**. #27/#28 are not MVP prerequisites |

## Finite sequential staging drill card

**Proposed bounds, not SLOs or approval.** One vvaz OR gmarques is named execution/
restoration owner for each session, with a named staffed observer/acknowledger
(the same authorized person may fill both if explicitly accepted). Private target
is the existing isolated synthetic staging Slot/repository/WordPress installation;
verify no production mappings, live Client data or shared-site test contention.
Each session has a prebooked start/end and handoff. No unattended coverage waiver
is implied. Stop new stimuli at its deadline; restoration/containment custody
persists through positive settlement or explicit incident handoff. Never force
remote completion to fit a timebox. No repeated drill/automatic retry on failure.
Record `R-drill` before moving to the next step.

### P0 — preflight (45 minutes, no mutation)

Owner: named vvaz OR gmarques. Review R-target/release/custody/window/operations
and the source prerequisites above. Verify both independent recovery access and
actual inventory/contact/retention/access; capture counts-only baseline and
measure intake latency, acceptance-to-confirmed-delivery, status freshness,
pending age, per-Client counts/usage and fairness separately in later sessions.
No invented latency objective: approver sets measured comparison/abort thresholds
before canary. Verify [security](../security-regression-tests.md),
[privacy](../support-privacy-design.md), [performance](idle-performance-budgets.md)
and [lifecycle gates](../support-lifecycle-verification.md#behavioral-gates).

Approval boundary: explicitly scope authenticated endpoint/state/history/RPC/Test F
reads; a logical read may use D1 query POST, not a blanket write grant. Artifact
download verification remains outstanding. Abort before secrets/apply if any field,
runner capability, safe history, rollback pair or permission cannot be established.
No currently documented CLI fills private config, injects a remote fault, executes
Time Travel safely or provides a generic live acceptance suite. Those are gaps
requiring reviewed procedures, not options to invent here.

**Pending policy blocker:** choose explicitly staffed finite manual GitHub
failed-run visibility, or an independent existing destination, for deploy/route/
missing-Cron/failed-Discord observations. Discord cannot report its own complete
failure. No answer exists; do not assume manual coverage or unattended waiver.
This blocks dependent fault/coverage acceptance and unattended rollout; it does
not block public artifact/provenance or restricted inventory preparation. Use
existing runbooks and evidence, no new observer framework/vendor/scheduler.

### P1 — staging plan and apply (one owner window, at most 20 minutes)

Owner: R-window owner. Target: verified existing staging four-resource graph.
Only after configuration/delivery/policy gaps are resolved, new exact source is
validated/on main, and separate Test F/staging apply approval, use the protected
entry command above. Review sanitized ready summary, both D1 no-replacement/
no-deletion proof, pending migration counts/digests, cached bundle and binding.
Human approves the **exact emitted** `approve-plan` command; no copied nonce or
hand-built candidate. Test F for prod/both D1s remains a separate scoped gate.

Evidence: run/attempt/head/final candidate, one-shot retained application, both
DB identities/history after apply, Worker version/deployment/bindings/App RPC
identity/fingerprint, final custody and Logs/traces. Logs on; traces off only
with Discord enabled; disabled mode verifies credential removal before traces on.
No successful remote RPC is promised. Abort on any drift/unsupported history/
readback/permission failure. Preserve marker and all-writer exclusion on uncertain
outcome; incident reconciliation, not rerun or standalone deploy, is recovery.

### D1 — webhook rejection, receipt and restore (30 minutes)

Owner: named operational/restoration owner, Discord destination acknowledger.
Target: synthetic staging App only; approved notification destination and private
runner progress file outside checkout. Reuse
[missed webhook drill](../runbooks/missed-webhooks.md#staging-drill),
[webhook procedure](../runbooks/github-webhooks.md#automated-staging-procedure) and
[Discord drill](../runbooks/discord-alerts.md#private-provisioning-and-scoped-drill--parent-only-after-review).
From repo root, existing command sequence is:
`python3 scripts/github-webhook-staging.py config --state <private-progress-file>`,
then separately approved `break --state <private-progress-file>` using the same
script, one approved synthetic status event, and `restore --state <private-progress-file>`
**even if no alert arrives**. No generic fake webhook request is substituted.

Evidence: receiver 401/time/class; one actual allowlisted Discord receipt and
human acknowledgment/time; duplicate suppression counts; restored current-key
acceptance and projection/sweep health. Preserve sanitized correlations only.
Use `status-health`, and only when needed `status-reconcile`/`status-repair` per
[repair](../runbooks/missed-webhooks.md#4-repair), with both DB IDs. Global-refresh
recovery is asserted only from actual healthy global-refresh observation; webhook
silence alone is no recovery message. Abort on exposure/unexpected destination,
unknown notification, containment or intake regression; restore App first and
use separately approved route disable/revocation under Discord runbook. 5xx,
wrong URL, absent Cron and failed deploy need separately scoped observation with
P0 fallback decision; there is no reviewed fault-injection command for them.

### D2 — unknown outcome / late success / no duplicate (30 minutes)

Owner: operational owner with independent Operator/provider read access. Target:
one synthetic create plus distinct synthetic status intents, no production issue.
Reuse [delivery decision](../support-delivery-design.md) and
[recovery procedures](operational-readiness.md#recovery-procedures-and-drill-evidence-contracts).
Arrange a separately reviewed bounded staging provider fault: accepted GitHub side
effect then lost response, drained local execution, eventual late success. **Gap:**
no supported operator command injects that fault; automated provider fixtures are
local evidence only. Do not edit live D1/provider behavior ad hoc to manufacture it.

Evidence: one accepted intent, pinned attempt/generation/window, unknown outcome,
15-minute ambiguity notification/ack, positive marker match to exactly one issue,
late-success readback and no duplicate across repeated same-intent requests;
ordered close/reopen must not overtake creates. Existing Operator grammar:
`pnpm operator reconcile <slot> <intent> <opaque-actor> positive-evidence` schedules
bounded read-only provider reconciliation (it writes audit/bookkeeping).
`resume <slot> <intent> <ISO-deadline-within-24h> <opaque-actor> <configuration-fixed|permissions-restored|provider-recovered>`
is only for known failed creates and must refuse unknown/suppressed work.
Use full flags below. It also requires delivery enabled; do not enable delivery
just to run reconciliation during D3. Empty searches do not prove non-creation.
Abort on multiple matches, unpinned attempt or lost execution; preserve unknown/
admission records and investigate. No force-create. A 24-hour deadline/handoff
requires separately authorized aged-fixture evidence, not a 24-hour unattended run.

### D3 — main-only restore / ledger preservation (90 minutes)

Owner: named recovery authority with independent D1 access; approved synthetic
restore point compatible with recovery Worker. Separate destructive restore
approval is mandatory. Follow [exclusive containment](../runbooks/restore-containment.md#preconditions-and-stop-conditions)
exactly, without duplicating its safety protocol here. Confirm all serving/old
versions, Cron/background/CLI/direct writers participate or are retired. Run
`maintenance-enter <opaque-actor>` then `maintenance-status`; prove an active
registration blocks recovery and subsequent ingress is 503. Positively settle
all work, then `maintenance-mirror <opaque-actor>` before restoring **SupportDB
only** using the separately reviewed provider procedure. **Gap:** this repo
supplies no approved Time Travel command; do not improvise one.

After confirmed restore: `restore-recorded <opaque-actor> time-travel-restore`,
`maintenance-replay <opaque-actor>`, independent verification, then separately
approved `maintenance-release <opaque-actor> <generation>` (all prefixed
`pnpm operator`, full flags). Evidence: ledger identity and current monotonic
records preserved, epoch equality, zero outstanding operations, erased text absent,
Operator/runtime revocations denied, suppressions/suspensions retained, every
undelivered intent unknown/pinned; resume refusal and no duplicate provider issue.
Do not require ledger bytes to be identical: maintenance/audit legitimately append.
Release keeps delivery disabled. Inspect provider outcomes independently; ordinary
reconciliation eligibility requires later, separately approved delivery enablement.
Unknown creates still never resume as pending. No down-migration or ledger restore.

Abort on uncertain main restore, failed mirror/replay, lost owner, old execution,
unknown schema or unresolved remote write. Stay contained; do not delete admission
rows or age out a marker. Timeout/late-success obstruction is a **separate refusal
scenario**, never bypassed to finish a successful restore. Review settled evidence
before any recovery/re-enable action; retain custody beyond the 90-minute session.

### D4 — privacy / offboard / cleanup (45 minutes per prepared fixture)

Owner: operational owner, with synthetic Client instruction and privacy reviewer.
Use distinct staging fixtures for export/erasure, offboard and retention so the
main lifecycle canary survives. Follow [privacy contract](../support-privacy-design.md#worker-contract),
[offboarding checklist](operational-readiness.md#offboarding-checklist-after-client-instruction)
and [Worker suppression commands](../../worker/README.md#suppression-ledger-and-restores).
Exercise WP export/erasure via existing privacy tools; Operator syntax is
`pnpm operator erase <slot> <opaque-actor> <reporter-reference>`,
`erasure-status <erasure>`, `offboard <slot> <opaque-actor>` then `revoke <slot>`.
Coordinate append-only revocations before mapping removal; keep GitHub issues.

Evidence: denial of old credentials/new dispatch, ledger-first suppression,
App-authored text redaction and residual-copy exception, no false complete erasure,
restore-replay denial from D3; local uninstall/disable not mistaken for offboarding.
Verify effective closed/never-delivered 12-month expiry, reopen reset, minimal
unknown records, resolved tombstone 45-day policy and 30-day offboard grace using
**pre-approved already-aged synthetic fixtures** and readback counts. No supported
CLI advances remote time or accelerates grace. If fixtures do not exist, record
retention execution as blocked; do not claim waiting periods passed. Fixture
creation/data changes need a reviewed scoped procedure. `cleanup-reconcile
<request> <opaque-actor> positive-evidence` and `cleanup-exception <request>
<opaque-actor> <client-instructed|operator-verified>` are restricted recovery,
not shortcuts to completion. Abort on unexpected scope or unknown side effect;
keep suppression/review and escalate residuals. No bulk purge to clean a drill.

### D5 — bad ZIP upgrade, local disable and recovery (45 minutes)

Owner: managed-installation operator plus operational authority. Isolated staging
WordPress fixture with independent hosting/admin recovery, prior tested ZIP and
state-compatible backup. Separate install/fault approval; never corrupt a shared
or Client installation. Reuse [package workflow](../../.github/workflows/release-plugin.yml),
[package harness](../../plugin/tests/integration/package.sh) and
[outage matrix](outage-draft-recovery.md#failure-matrix). Existing harness is for
fresh disposable tests, **not a live upgrade command**. No generic bad-ZIP
injection/restore CLI is provided: review the exact package failure and hosting
restore procedure before scheduling this step.

Record artifact/ZIP hashes before install, preserve installation identity/key/
Reporter subjects/scopes across previous→candidate upgrade. Rehearse failed
upgrade, set `GQ_SUPPORT_DISABLED` or deactivate through independent access,
restore the compatible previous package, then separately approve re-enable and
explicit support/settings use. Evidence: ordinary navigation unaffected; disabled
UI/navigation zero support calls (privacy operations remain separate); accepted
work remains service-owned; memory-only draft loss/receipt ambiguity disclosed.
Verify #67's same-key frozen payload, 409 after uncertainty, manual Retry-After,
session/BFCache closure, loader deadline/late completion and separate-device
independent contact handoff using actual approved private contact. CI controlled
responses cover the detailed matrix; live handoff is separate evidence. Abort
if prior state/package compatibility or recovery access is uncertain; leave UI
disabled and use the existing contract route. Never promise a native updater.

### D6 — compatible canary and code rollback (45 minutes)

Owner: vvaz OR gmarques release authority and managed-installation operator.
Approval identifies one isolated synthetic staging canary, exact old/new plugin,
Worker and expanded schema pairs, measured thresholds and stop criteria. Test
oldest enrolled supported v1 plugin against new Worker/schema, new plugin against
previous compatible Worker where claimed, and previous protocol-compatible
Worker against expanded schema. Exercise submit/read/refresh/status controls and
two-Slot scope denial. Observe measured baselines and zero accepted-work loss,
duplicate creates or revived suppressed data. Rollback restores **code/package
only**, preserves both databases/expanded histories, App custody and maintenance
protocol. A previous Worker without containment is not a valid recovery rollback.

Use protected retained continuation for any Worker update, with its own fresh
20-minute window/candidate approval; no redeploy/replan bypass. Observe canary
inside the staffed session, stop expansion on regression, preserve evidence and
use the pre-reviewed compatible pair or disable local UI. Missing compatible
rollback identity blocks this step. Production canary/expansion and prod both-D1
Test F remain separate explicit approvals, never inferred from staging success.

All Operator commands above run from `worker/` and append
`--stage staging --account-id 8f38791a8c37b182239af2a385ab3c31 --database-id <SupportDB-ID> --ledger-database-id <SupportLedger-ID>`.
Placeholders resolve only in restricted execution context. Commands can expose
private operational metadata; retain raw output privately and publish sanitized
outcomes only. No command in this packet was executed remotely.

## Exit record and smallest parent frontier

Do not mark “MVP ready”, “all reviewed” or “shipped”. Completion requires each
criterion's immutable source/CI/artifact evidence, R-target/release/custody/window/
operations attestations, actual Client contact/retention/access/measurements,
all applicable drill pass/abort-and-resolution records, and unresolved gaps listed
explicitly. Final vvaz OR gmarques sign-off must name the final head, ZIP/bundle/
schema/candidate digests, compatibility window, residual risks and timestamp
**after concrete review**. Sign-off is currently **absent**. Production-data
collection, rollout and issue closure are not authorized by this packet.

Parent can now obtain private non-secret R-target/history/R-custody and actual
inventory/release/rollback metadata through the existing restricted record.
First resolve target applicability (especially ledger 0002), private configuration
integration and protected-runner/delivery/policy gaps. Then freeze a final reviewed
candidate and obtain action-specific approvals; only execution-ready parent asks
`request_secret` for required one-shot files. The only pending operational policy
exception is staffed finite failed-run coverage versus independent existing
fallback; do not silently grant it. Missing fault/Time Travel/package recovery
procedures are concrete execution gaps to review, not permission to add telemetry.

Residual risks: broad bearer scope, non-CAS State/ABA, writer exclusion surviving
runner loss, partial remote SQL/unknown writes and non-expiring admissions, best-
effort notification persistence, Discord self-failure invisibility, no proven
live per-Client measurements/retention, artifact expiry, and unverified fleet/
rollback compatibility. None is discharged by passing CI or historical drills.
