# Operational readiness evidence for #20

Assessment dated 2026-10-27 against `main` commit
`6e2a792fe74f95a1be3e367bab97909443039ea2` (merged lifecycle PR #103).
[Issue #20](https://github.com/Quick-Release/gq-support/issues/20), including its
comments, is a decision ticket. **Readiness is not established.** This document
inventories evidence and prepares review; it authorizes no deployment, incident
notification, settings change or destructive drill. Recommendations below are
**proposed/unapproved**. Missing live evidence is **not verified**.

## Settled boundaries

- The account is **Tipme**, `8f38791a8c37b182239af2a385ab3c31`
  ([AGENTS.md](../../AGENTS.md), [credential instructions](../../worker/README.md#cloudflare-credentials)).
  The older #20 comment suggesting an account decision is superseded.
- One shared Worker, SupportDB and independent SupportLedger per stage;
  EU-jurisdiction D1, stage-pinned Apps and reviewed Slot mappings. Production
  mappings are empty; staging contains only the synthetic sandbox. See
  [ADR 0013](../adr/0013-shared-cloudflare-resources-per-stage.md),
  [ADR 0017](../adr/0017-d1-in-the-eu-jurisdiction.md),
  [stack](../../worker/alchemy.run.ts),
  [database configuration](../../worker/src/support-db-config.ts) and
  [mapping registry](../../worker/src/repository-mappings.ts).
- D1 is the accepted-report outbox. Best-effort background work is recovered by
  a minute tick. Failed/unknown D1 records are the recovery backlog; Queues,
  DLQ and a local WordPress report outbox are deferred. See the confirmed inputs
  in #20 and [delivery implementation](../../worker/src/delivery.ts).
- Reporter close/reopen shipped under ADR 0020. #29's original assertion that
  those controls are absent is stale. GitHub comments remain internal.
  [Lifecycle verification](../support-lifecycle-verification.md) records the
  scope reconciliation and leaves #20's operational gate open.
- The independent help route is each Client's existing contract contact, verified
  outside WordPress; no new provider or automatic email fallback is approved.
  Drafts are memory-only before acceptance. Local disable does not cancel
  accepted work, revoke a key or offboard a Slot. See
  [outage decision](outage-draft-recovery.md) and #17's resolution.

## Evidence levels and inspection

**Implemented** below means source/configuration and named tests exist. It does
not mean this assessment reran them or deployed that revision. **Recorded live**
means a dated repository evidence record exists, limited to its recorded stage,
revision and scenario. It does not establish today's production state.

Read-only first-party inspection in this assessment:

```sh
gh issue view 20 --comments --json number,title,body,labels,comments
gh issue view 29 --comments --json number,title,body,comments
gh api repos/Quick-Release/gq-support --jq '{private,visibility}'
gh api repos/Quick-Release/gq-support/environments \
  --jq '.environments[] | {name,protection_rules,deployment_branch_policy}'
gh api repos/Quick-Release/gq-support/environments/prod/deployment-branch-policies \
  --jq '.branch_policies | map({name,type})'
gh api repos/Quick-Release/gq-support/environments/staging/deployment-branch-policies \
  --jq '.branch_policies | map({name,type})'
```

Observed: repository is public; `prod` and `staging` each allow only the `main`
branch and report only a `branch_policy` protection rule, **no required reviewer
rule**. This is GitHub configuration evidence, not a decision to add reviewers.
No secret values, Cloudflare state, report rows or other repositories were read.
No Cloudflare plan, remote drill or current CI check polling was performed.

## Per-acceptance-criterion assessment

| #20 acceptance criterion | Already implemented / evidence | Remaining implementation or decision | Missing live evidence |
| --- | --- | --- | --- |
| Release/update compatibility matrix; staged deployment/rollback | [API contract](../support-api-contract.md#wordpress--worker-transport) specifies additive `/v1` and parallel `/v2` for breaking changes. [Runtime matrix](../../.github/runtime-matrix.json) and [release workflow](../../.github/workflows/release-plugin.yml) verify installed ZIPs, upgrades and exact digest promotion into Composer publication. [Deploy workflow](../../.github/workflows/deploy-worker.yml) serializes stage applies on main and verifies App custody. | No approved fleet version/overlap window or concrete plugin/Worker/schema compatibility release record. Plugin sends version header and maps 426; no Worker version-header enforcement found. No native WordPress updater/package authorization handler found. Choose distribution scope; rehearse staged upgrade and schema-compatible code rollback. | Current fleet/version census, staging/canary release and rollback, production SupportDB/SupportLedger no-replacement plan, and human authorization: **not verified**. |
| Resource inventory, secret ownership, offboarding | Stage topology and public stack outputs exist. [Key custody runbook](../runbooks/github-app-key-custody.md) and [Worker README](../../worker/README.md) identify sources/custodians. `offboard`, `revoke`, ledger replay and grace-period purge exist in [cleanup operator](../../worker/src/cleanup-operator.ts), [operator](../../worker/src/operator.ts), [cleanup](../../worker/src/cleanup.ts), [ledger](../../worker/src/ledger.ts). | Maintain private per-Slot inventory and named accountable people/deputies. Document CI prevention of direct destructive commands and approve recovery access. | Production resource IDs/versions/bindings/plan, access review, independent Operator recovery access, live offboarding/restore suppression and Client handoff: **not verified**. |
| Minimal metrics/log schema, retention/access/per-Client attribution | [Lifecycle correlation](../support-lifecycle-verification.md#correlate-without-report-content), [webhook receiver](../../worker/src/github-webhooks.ts), status/cleanup logs; Worker enables logs and traces. [Privacy design](../support-privacy-design.md#data-inventory-and-retention) selects Workers Logs default retention and no Logpush. | Verify effective retention, sampling, access and trace settings. Request/intent IDs can join to Slot through restricted records; no complete per-Client usage/latency dashboard or metric exporter demonstrated. Add missing aggregate measurements at existing seams, not a second telemetry system. | Retention/access enforcement, exporter/dashboard visibility, latency distributions, volume/fairness/usage and missing-tick detection: **not verified**. Default selection is not evidence of effective account settings. |
| Alerts/runbooks: delivery, webhook, credentials, retention, migration failures | Structured alert signals and guarded CLI recovery exist. [Missed-webhook runbook](../runbooks/missed-webhooks.md) and key/webhook custody runbooks exist. Cleanup emits review/failure events; deployment fails on preflight/apply/audit failure. | No notification routing/deduplication configuration found. Approve existing incident route/responder; wire signals and recovery notices. Complete containment and migration-failure procedures below; credential failures need classification rather than paging every invalid signature. | Alert receipt/acknowledgment/escalation, retention backlog detection, failed deployment response, and loss-of-telemetry detection: **not verified**. A log with `alert: true` sends no notification. |
| Staging broken webhook fires `5xx`/`401` alert | [#57 staging record](github-webhook-sync.md#staging-verification-57): three `401` deliveries and rejection logs, sweep recovery measured, status repair audited. `scripts/github-webhook-staging.py break` intentionally changes the staging App secret. | Route receiver rejection and webhook failure signals to approved destination; define window/deduplication. Script exercises `401`, not `5xx`; a `5xx` path needs a separately reviewed fault procedure. | Actual alert delivery/acknowledgment during `break` and restoration: **not verified**. #57 expressly moved this gate to #20. |
| Recovery drill: unknown outcomes, D1 restore, queue replay, bad plugin update | [Delivery tests](../../worker/test/delivery.test.ts), [provider tests](../../worker/test/support-issues.test.ts), [cleanup tests](../../worker/test/cleanup.test.ts), [ledger tests](../../worker/test/ledger.test.ts), lifecycle/browser/package tests cover controlled failures. `resume` refuses uncertain/suppressed work; `reconcile` schedules bounded read-only work. | Use D1 backlog recovery for obsolete “queue replay” wording. Finish exclusive restore containment, recovery-point selection and rollback matrix; approve synthetic scenarios and abort conditions. | Credentialed unknown/late-success/restore/ledger/offboarding and bad-update drills on intended staging revision: **not verified**. Local automated tests are not those drills. |
| Production checklist links security/privacy/performance with human sign-off | Existing [security regression](../security-regression-tests.md), [privacy](../support-privacy-design.md), [lifecycle](../support-lifecycle-verification.md), [performance budgets](idle-performance-budgets.md), required CI and tested-package promotion provide the gates. | Fill checklist below with immutable candidate evidence, decision record and human sign-off. Keep #20 and #29 open until their remaining gates are met. | Human sign-off and operational evidence: **not verified**. Closed engineering tickets alone do not authorize onboarding. |

## Inventory and custody to complete privately

Use an existing restricted operational record, not this public repository, for
Client contacts, installation origins, access grants and sensitive topology.
Record the reference to that record and a sanitized pass/fail result here.
Neither a default Developer nor a GitHub committer is automatically an incident
responder or secret owner.

| Item | Source of truth already present | Private evidence still needed |
| --- | --- | --- |
| Client / project / Slot / environment / repository / App installation | Reviewed stage mappings; signed installation binding and `operator status` | Actual enrolled inventory, installed plugin/runtime version, last explicit health check, accountable Operator/deputy, contract contact and verified external handoff |
| Worker / SupportDB / SupportLedger / Alchemy state | Stack outputs (names/IDs/URL); `Cloudflare.state()`; durable-stage retain policies for both databases | Deployed commit/schema checksums, IDs belonging to intended stage/account, delivery gate state, Cron health, restore access/history and state recovery reference |
| Stage App private key | GitHub Environment encrypted secret → Worker `secret_text`; apply-only provider, registration preflight, post-deploy custody audit | People authorized to rotate/recover; access review and dated stage fingerprint; no PEM in inventory |
| Webhook HMAC | Stage Environment → Worker secret; recovery-copy details in [webhook runbook](../runbooks/github-webhooks.md) and Worker README | Current/previous retirement state and authorized custodians; no HMAC values |
| Cloudflare deployment credential | Tipme child token/profile; source and expiry recorded in Worker README | Credential expiry response, named rotation owner/deputy, independent Operator D1 access; inspect presence/metadata only |
| WordPress signing key | Installation-held Ed25519 secret; Worker verifies public key, [ADR 0012](../adr/0012-installation-signing-with-site-held-ed25519-keys.md) | Approved enrollment/revocation process and hosting/admin recovery access; no private key backup in this document |
| Composer distribution and registry dispatch | Existing registry/proxy path and revocable registry login; dispatch credential stays CI-side ([README](../../README.md#registry-rebuilds-and-token-rotation)) | Who installs/pins/releases each Client; entitlement/access revocation and package recovery evidence without inspecting another repository |

**Recorded live evidence to reuse:** staging App-key deployment/custody/rotation
on 2026-10-17 and gateway scope/spike on 2026-10-18 are in the
[key custody record](../runbooks/github-app-key-custody.md#live-evidence--2026-10-17).
Webhook current/previous-key verification and retirement are in
[webhook evidence](../runbooks/github-webhooks.md). #57 recorded webhook-working
p95 freshness of 12.5 s over 20 transitions and broken-webhook observations of
7 m 03 s, 53 s and 12 m 38 s. These synthetic sandbox measurements are useful
baselines, not fleet service objectives or current production guarantees.
Older introductory paragraphs in README/key runbooks describe earlier scaffold
or pre-deployment states; use their later dated evidence and current source.

## Telemetry and response preparation

Keep the privacy design's existing Workers Logs/no-Logpush boundary. The following
is a proposed/unapproved operational view, not a newly deployed schema or service:

| Signal | Existing fields / observation | Gap and response |
| --- | --- | --- |
| Acceptance and delivery | `support.receipt`: request, operation, delivery. Delivery log/span: request, intent, generation, attempt after claim, outcome, alert | Receipt does not prove GitHub creation. Measure intake latency separately from acceptance-to-confirmed-delivery; do not subtract unrelated trace timestamps blindly. |
| Backlog, unknown, provider pace | Delivery outcome/review events; D1 accepted/attempt/deadline state; persisted provider cooldown and claim records | Add counts/oldest age by state, tick completion, claim contention/fairness and provider pacing through existing scheduler. No DLQ depth metric. |
| Webhook/status | `github_webhook_rejections_total`; `GitHub webhook rejected` reason; `support.status.refresh.oldest_due_age_ms`, `support.status.sweep.lag_ms`; `status-health` | Effect counter declaration alone does not prove a live metric exporter. Observe endpoint status and receiver logs; wrong URL has no receiver event. |
| Credentials/configuration | Provider tagged failure/status, repository suspension alerts, App preflight/custody failures | Separate provider credential/configuration incidents from invalid installation requests; rate aggregate auth failures without retaining raw IPs, signatures or headers. |
| Privacy and migrations | Cleanup outcome/review/step-failure events; restore replay pending; deploy failure | Need cleanup oldest unresolved age, mirror/replay success and failed migration response; missing minute ticks cannot emit their own failure log. |
| Client attribution/resources | Restricted request → Slot → Client mapping; repository IDs where present; local load test covers pacing/fairness | Aggregate counts per approved opaque Client/Slot reference, avoid Reporter dimensions; measure shared resource usage without pretending per-Client Cloudflare billing exists. |

Use only timestamps, stage/release, opaque request/intent/attempt, bounded
operation/outcome/reason classes, durations/counts and approved opaque attribution.
Join to Client only in restricted Operator tooling. Never add Submitted text,
Report context, subjects/hashes, Submission/Change IDs, auth nonce, cookies,
secrets, raw upstream responses, unrestricted URLs, screenshots or headers.
Reuse lifecycle/security canaries and scanned CI artifacts for leakage checks.
Audit log/trace field exposure, actual retention and access before enabling a new
field. Public evidence contains only sanitized counts/times and outcome classes.

Confirmed thresholds from #20/delivery: immediate configuration/permission and
duplicate/conflict review, unresolved ambiguity at 15 minutes, and the 24-hour
known-non-creation retry deadline/handoff. Current status code alerts at oldest
due age/sweep lag over one hour and refresh attempt five. These are separate
signals from #57's freshness targets. Proposed/unapproved routing keys are stage
+ event class + intent (delivery), repository (status), or deployment revision
(migration); suppress repeats during one incident, preserve first/last occurrence
and count, and send recovery/acknowledgment through the approved existing route.
The user must approve routing, escalation and deduplication policy before wiring.
No alert destination or service objective is assigned here.

Measure accepted-report durability, GitHub delivery delay and Support status
freshness independently; there is no client-visible reply stream in the MVP.
Provider health, Worker health and WordPress reachability require separate
observations. Use explicit support/settings interactions for site checks; never
add network checks to ordinary page rendering. Measurements must precede new
latency objectives and rollout thresholds.

## Candidate compatibility and rollout worksheet

This is a proposed/unapproved procedure to review, not an executable deployment
approval. Fill every unknown with candidate-specific evidence.

| Combination | Present evidence | Gate before rollout |
| --- | --- | --- |
| Runtime floor/current/intermediate and nightly variants | `.github/runtime-matrix.json`, Required validation, compatibility and release installed-package cells | Exact candidate run URLs/runtime artifacts, dependency/secret scans and real Design cell; see README CI section |
| Previous published plugin → candidate ZIP | Release package lane preserves identity, key, Reporter subjects/capability choices; digest-bound artifact | Identify actual previous tag and candidate digest; a legacy fixture is not a real fleet downgrade/upgrade rehearsal |
| Oldest installed supported plugin + candidate Worker/schema | Shared contracts describe additive v1 | Fleet version census, actual pair test, supported-version window and retirement decision; Worker 426 enforcement is not implemented |
| Candidate plugin + previous Worker/schema | Not verified by a fleet matrix | Test new features against previous service; stage server support first or keep dependent feature locally disabled |
| Previous Worker + expanded candidate schema | Migrations/checksums present; older research selects forward-only expand/contract | Verify backward query/write compatibility, no DB replacement, and migrate SupportLedger separately; code rollback is not schema rollback |
| Breaking API or destructive schema change | Contract requires parallel API paths | Separate approved migration; retain old path/schema until fleet migration verified; never silently drop v1 |

1. Record immutable source SHA, plugin version/digest, Worker revision, both
   migration checksum sets, previous compatible revision and exact runtime cell
   results. Reuse Required validation, security/privacy and performance gates.
2. Choose distribution scope. Existing Composer/controlled ZIP installation can
   support a managed pilot without a native updater. Public source/artifacts are
   not private package access. A native updater, if required, needs a separate
   reviewed authentication/entitlement/cache/download design; never place a broad
   GitHub token on WordPress installations. No distribution service is created here.
3. Inspect an authenticated stage plan with stage credentials injected by the
   existing custody process. From `worker/`, the #35/#20 gate is
   `pnpm exec alchemy plan --stage prod` (add `--profile gq-support` only on the
   configured workstation, with required App inputs also injected). Check **both**
   databases for replacement/deletion and verify account, names, jurisdiction and
   checksum drift. Do not save raw state/plan if it could contain secrets.
   This command was **not run** here; record sanitized result and immutable run.
4. Review deploy policy before a candidate apply. Current CI calls `alchemy deploy`
   directly, never destroy; `pnpm run destroy --stage <stage>` refuses prod/staging.
   Retain and guard tests exist, but no explicit deploy-workflow rejection of
   future direct destroy commands or credentialed no-replacement plan gate is
   demonstrated. Do not claim #35 Test F passed. Add protections in existing CI.
5. After scoped staging authorization, use **Deploy Support Worker** on main and
   the intended GitHub Environment; never partial deploy/alternate upload. Verify
   migrations, App fingerprint/custody, ledger, Cron, signed synthetic receipt,
   delivery/status/erasure recovery and absence of sensitive logs. Script upload
   can temporarily remove App secrets before reconciliation; zero downtime is
   not established by serialization.
6. Install the exact tested ZIP or pin the approved Composer version in a
   Client-approved canary. Verify explicit settings checks, submit/refresh and
   close/reopen, local disable/re-enable and independent contact. Record
   observations and stop/rollback criteria before expanding the fleet.
7. On failure, disable the local UI where necessary; service-owned accepted work
   remains tracked. Restore the previous approved package through existing
   hosting/Composer access and a compatible Worker revision through the normal
   full deployment workflow. Prove local state/schema compatibility first; the
   upgrade tests do not prove downgrade safety. Prefer a forward fix when the
   previous code cannot read the expanded schema. Do not restore D1 merely to
   roll back a plugin. No destructive down-migration is approved.

## Recovery procedures and drill evidence contracts

All commands below are **procedure templates only**. Live mutations need reviewed
scope/authorization. Use synthetic staging data, an opaque actor and actual stage
output IDs. No example identifies a real Client. Commands run from `worker/`;
append these flags to every Operator invocation (and a ledger ID when required):

```text
--stage <staging|prod> --account-id 8f38791a8c37b182239af2a385ab3c31 --database-id <SupportDB ID>
--ledger-database-id <independent SupportLedger ID>
```

Before execution confirm the IDs belong to that stage, independent Operator
credentials work, approved responder/abort/containment steps exist, and no real
Client data enters evidence. Preserve only revision, time window, opaque IDs,
counts, commands without secrets, audit references, observed outcome and reviewer.
A failed step stops the drill; containment remains until reviewed recovery.

| Scenario | Procedure using current interfaces | Required evidence / abort condition |
| --- | --- | --- |
| GitHub outage / stalled outbox / expired or poisoned job | Read counts/oldest ages and logs; `operator status <slot>` and `status-health`. Compare delivery gate, mappings, minute ticks and provider cooldown. Fix actual dependency/configuration through approved process. For failed confirmed non-created work only: `operator resume <slot> <intent> <future-ISO-deadline> <actor> provider-recovered` (or supported configuration/permission reason). | Respect Retry-After; no write retry for unknown creates. Record audit and eventual outcome, pacing and no duplicate. Expiry after 24 hours requires review; there is no queue/DLQ replay command. |
| Unknown create / late success | Preserve original intent and attempt window; observe bounded read-only marker reconciliation. After automatic window, `operator reconcile <slot> <intent> <actor> positive-evidence` only on positive evidence. For privacy cleanup use `cleanup-reconcile <request> <actor> positive-evidence`. | One created issue despite lost response/late success; no force-create on empty scan; suppressed/uncertain resume refused. Unresolved erasure stays incomplete. Controlled provider tests cover injection; live fault injection method is not yet approved. |
| Revoked App/site credential | Use `status` to classify key/repository state; follow key custody runbook for App replacement, or approved re-enrollment for installation key. For suspension, restore repository safety then `unsuspend` with cause-specific evidence after a later passing sweep. | No broadening App grants, automatic unsuspend or changing repository identity. Record fresh authentication/custody and scoped access without tokens. Disabling UI alone does not revoke a key. |
| Missed webhook / stale status | Follow [missed-webhook runbook](../runbooks/missed-webhooks.md): configuration check, fix, `status-reconcile <outage-start> <actor>` if needed, `status-health`, then `status-repair <start> <end> <actor>`. | Drained due backlog, completed open pass, current sweeps, handled/acknowledged suspensions and sanitized audit. Broken webhook is not lost delivery acceptance. |
| Retention / erasure failure | Inspect cleanup review/step-failure and ledger health; use `erasure-status <erasure>`, approved cleanup reconciliation, and residual-copy review under privacy runbook/design. | Verify 12-month closed/never-delivered text expiry, reopen reset, unknown minimal records, redaction/residual reporting, 45-day resolved tombstone policy. Do not close unresolved erasure as complete or use `cleanup-exception` without Client instruction/Operator evidence. |
| Database restore | Use the exclusive containment plan below; restore SupportDB only, retain ledger and revocation log, then `restore-recorded <actor> time-travel-restore`. Verify replay before admitting requests or dispatch, then read-only reconciliation and status repair. | No revived erased text/credentials/suspensions, no duplicate creates, unchanged ledger, replay epoch and suppressed/unknown resume refusal. A real Time Travel round-trip and its containment are **not verified**. |
| Bad plugin update / WordPress down | Use independent hosting/admin access to set `GQ_SUPPORT_DISABLED` true or deactivate plugin. Restore reviewed prior package only if state-compatible. Remove disable flag after explicit healthy support/settings test. Follow external contract contact on separate device. | Ordinary public/admin navigation and disabled support UI make zero support calls; explicit privacy export/erasure remains allowed by the adapter. Memory loss/uncertain receipt disclosed; accepted work remains owned by service. Prior package reinstall and separate-device contact drill **not verified**. |
| Private attachment exposure | Attachments/R2 are deferred; no attachment store exists in the MVP inventory. If sensitive data appears in issue text/logs, contain the actual affected surface and use current privacy/security incident review. | Do not invent R2 ACL or URL-revocation commands. Attachment incident runbook is an enablement gate if that feature ships; current production data incident ownership still needs approval. |

### Restore containment gap requiring review

`delivery_control.enabled = 0` stops new delivery dispatch, but is **not** an
all-traffic or all-sweep kill switch. [restoreGate](../../worker/src/ledger.ts)
caches success for one minute and tolerates a failed epoch check with a verdict
up to ten minutes old. `restore-recorded` increments the separate ledger epoch;
it does not instantly fence existing isolates or stop an in-flight provider
side effect. A restored database can also restore an older enabled delivery bit.

Therefore do not execute restore → record → resume against active traffic as a
complete runbook. **Proposed/unapproved prerequisite:** define and rehearse an
exclusive maintenance boundary that blocks support ingress and scheduled/background
execution across the restore, drains authorized execution (the delivery dispatch
window and 60-second permit drain do not bound remote GitHub completion), and
keeps it blocked until the new epoch has replayed. No tested remote command for
that full boundary is established here. Choose the smallest tested maintenance
mechanism before authorizing any restore; do not improvise Worker deletion,
credential revocation or restore of both databases. Then verify ledger mirroring
is caught up, preserve the append-only revocation file, select a reviewed restore
point, restore main only, record the epoch immediately, replay/verify under
containment, and reconcile restored non-delivered intents as unknown. The restored
schema must be compatible with the recovery Worker. Stop if replay, ledger access,
comparison of revocations and suppression or that schema compatibility cannot be proved.

### Scoped webhook alert drill, after routing approval

Reuse a private local state/progress file from the existing staging runner; it
may contain sensitive workflow state. Keep it outside the checkout with restricted
permissions. Do not attach it to a PR.

```sh
python3 scripts/github-webhook-staging.py config --state <private-progress-file>
# Only after explicit authorization to disrupt the synthetic staging App:
python3 scripts/github-webhook-staging.py break --state <private-progress-file>
# Trigger an approved synthetic issue status event through the existing #57 probe.
# Capture rejection time, alert arrival/acknowledgment, deduplication and sweep recovery.
# Restore even if the alert fails; the responder must own restoration:
python3 scripts/github-webhook-staging.py restore --state <private-progress-file>
```

`break` replaces the App's secret with a discarded random value, producing `401`
at the valid receiver; it does not produce `5xx` or test a wrong URL. Verify
restored current-key acceptance, status-health and repair audit per runbook,
and record alert recovery. Reuse #57's probe only with reviewed staging credentials
and synthetic content. This assessment ran none of these commands. Notification
receipt is a separate pass criterion from a Worker rejection log.

### Offboarding checklist, after Client instruction

1. Verify Client authority, exact Slot(s)/environment and agreed handoff; export
   or Reporter erasure requests are separate workflows. Multi-Slot Clients need
   every intended Slot listed explicitly.
2. `operator offboard <slot> <actor>` with both DB IDs writes suppression to
   ledger first and starts the existing 30-day grace period. Then
   `operator revoke <slot>`; commit/coordinate append-only `worker/revocations.json`.
   Keep the mapping until commands that need it have completed; removing mapping
   first can block those commands.
3. Verify credential denial, suppression before dispatch and drained active work;
   uncertain remote outcomes retain minimal review records. Do not claim the
   suppression cancels a GitHub side effect already in flight.
4. Disable/remove local UI and separately remove entitlement through the existing
   approved distribution process if applicable. Uninstall sends no remote call.
   GitHub issues remain in the Client's repository; do not delete them.
5. After grace, verify purge and ledger state with counts-only evidence; unresolved
   remote review is not complete erasure. Remove obsolete mappings by reviewed
   change after operational checks; preserve revocations/suppression needed for
   restore safety. Record responsible reviewer and private contact handoff.

## Smallest independent user decision frontier

These questions follow repository facts, not missing research. All recommendations
are **proposed/unapproved**; no names or destinations are assumed.

1. **Pilot/update scope:** accept a managed Composer/tested-ZIP pilot with deliberate
   per-installation upgrades, or require native WordPress automatic updates before
   any pilot? Recommend managed upgrades using the existing digest-tested pipeline;
   this avoids introducing an unreviewed updater into the readiness gate. If native
   updates are required, entitlement/secure download design becomes the next branch.
2. **Operational authority and incident route:** which authorized person/deputy,
   existing restricted operational record and existing incident destination should
   own alert acknowledgment, migrations/recovery and Client handoffs? Recommend an
   explicitly named primary/deputy and the existing incident route, with contacts
   kept privately; do not infer them from code authors. Ask for verified contract
   contact evidence per Client only when a Client is selected for onboarding.
3. **Release authority and compatibility commitment:** who signs off a release,
   and is a managed pilot allowed to retain every enrolled v1 plugin version until
   its upgrade is verified? Recommend that no current enrolled version is retired
   during the pilot, additive v1/expand-only migrations, and recorded human approval
   for every production rollout. Decide whether to enforce this with required GitHub
   Environment reviewers (currently absent) or an explicitly recorded approval
   process. This is not an approval to configure or deploy now.

After those decisions: choose pilot Client/canary/observation and stop criteria,
alert deduplication/escalation details, effective telemetry retention/access sign-off,
and approve bounded staging drills with their exact revision, targets, change,
duration, restoration owner and abort procedure. Set service objectives only after
measurements; choosing numbers now would invent guarantees. Restore containment
needs a technical implementation proposal before a destructive drill approval.

## Actionable production gate

Every unchecked item blocks the relevant live rollout. Link immutable evidence;
public records use sanitized outcome plus private-record reference, never contacts.

- [ ] User decisions recorded for distribution, authority/incident routing and
  fleet compatibility/release approval; no accidental retirement of enrolled v1.
- [ ] Candidate SHA, ZIP/tag/digest, Worker/schema revisions and rollback pair
  recorded; [Required validation](../../.github/workflows/ci.yml), release installed
  package/compatibility cells, [security](../security-regression-tests.md),
  [privacy](../support-privacy-design.md) and [performance](idle-performance-budgets.md)
  gates pass for that candidate. Reuse promoted T1–T3 gates and report-only T4;
  do not reset #47/#49 to research or substitute a live latency SLO.
- [ ] Production no-replacement/deletion plan for SupportDB **and** SupportLedger;
  reviewed migrations/checksums, destroy guard policy and stage/account verified.
- [ ] Private inventory complete: actual resource IDs/versions, enrolled Slots,
  ownership/deputies, custody/access/expiry and independent Operator recovery.
- [ ] Logs/traces/metrics inspected with synthetic data; effective retention,
  sampling/access policy, per-Client aggregate attribution and missing-tick
  detection verified. No private content in evidence or uploaded artifacts.
- [ ] Existing delivery/unknown/deadline/status/credential/cleanup/deploy signals
  routed, deduplicated and acknowledged; webhook `break` alert drill passes and
  restores safely. No log-only event counted as a sent alert.
- [ ] Staging candidate proves unknown/late-success handling, restore containment
  and main-only restore/ledger replay, erasure/retention/offboarding and no blind
  backlog replay; all results distinguish local tests from live drills.
- [ ] Per-Client existing independent contact/responder, external handoff and
  separate-device outage drill privately verified; local disable/re-enable and
  bad-package recovery verified through independent hosting/admin access.
- [ ] Canary pairing, measurement/abort criteria, expansion plan, human sign-off
  and residual risks recorded with approver and timestamp. **Not signed off.**

## Proposed next slices

1. Add the fleet/release record and approved policy to the existing release/deploy
   workflow, including no-replacement plan review and destructive-command policy.
   No separate CI system or more CI work is started by this assessment.
2. Extend existing structured telemetry only where measurements are missing;
   connect approved alerts and missing-tick detection with tested privacy-safe
   aggregation/deduplication. Prove a routed staging webhook alert.
3. Specify/test exclusive restore containment around current replay interfaces;
   then rehearse synthetic recovery and package rollback under scoped approval.
4. Complete private inventory and per-Client independent-contact handoff, and
   obtain release sign-off. A native updater is a separate slice only if required.

Known orchestration follow-ups #104 (footer), #105 (Vitest reservation), #106
(WP-CLI stderr, containing #105) remain separate. Their stated status is task
handoff context, not freshly verified evidence here; none was modified, merged,
deployed or monitored. Merge #105 before #106 if authorized later; #104 is
independent. This document closes neither #20 nor #29.
