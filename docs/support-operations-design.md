# Support operations design

Decisions being developed in [#20](https://github.com/Quick-Release/gq-support/issues/20).
This document records the accepted interview decisions, synthesized into
[implementation spec #134](https://github.com/Quick-Release/gq-support/issues/134)
with user-confirmed testing boundaries. It does not authorize deployment or
claim that the operational mechanisms have been implemented.

## Confirmed operating policy

- All GETQUICK team members can see incidents and claim responsibility for them.
  The team works on a 24-hour schedule, with no business-hours restriction.
  An incident stays unassigned until the first person who sees it claims it;
  there is no designated responder, claim timeout or automatic escalation.
  This does not establish a guaranteed human response time. Notifications go
  to Discord, with a dashboard page to be built in Banquinha. Both Support
  requests and operational incidents appear in separate views/channels.
  Notifications contain minimal metadata and a link, never report text.
  Support requests remain linked to their existing Project repository issues.
  Banquinha implementation is separate cross-repository work.
- GETQUICK may update client installations automatically. Per-update Client
  approval is not required. Production rollout targets every installation at
  once, rather than production canary cohorts. Pre-production checks and
  first-onboarding human readiness sign-off still apply. Require package,
  security, privacy, compatibility and staging checks, a production infrastructure
  plan proving no protected-resource deletion/replacement, and a verified
  rollback path. Failed gates block deployment. Database migrations are additive
  first; remove old structures only after the fleet is confirmed updated.
- Only the latest plugin version is supported. GETQUICK intends to keep every
  installed plugin current; there is no ongoing old-version support commitment.
  Temporary compatibility is allowed during rollout and recovery, without an
  ongoing old-version support commitment. If an update cannot complete safely,
  disable new submissions locally, preserve recovery information and alert the
  team. Preserve compatibility with the previous approved release for up to
  24 hours during updates. Alert immediately on a confirmed update failure;
  disable new submissions on detected incompatibility or window expiry while
  leaving update and recovery controls usable. Already accepted work remains
  service-owned. Detection/control mechanisms remain to be specified.
- Use existing central site deployment tooling for installations it manages,
  consuming the published Composer package. Provide a private native WordPress
  updater only for installations that need it. Neither path is established as
  implemented by this policy, and broad GitHub credentials must not be placed
  on client installations.
- A bad plugin release may automatically roll back to the previous verified
  package when its data remains compatible. That package becomes the temporary
  approved recovery version; halt rollout and ship a corrected release.
  Database changes require a separate recovery procedure before automatic
  rollback is allowed. Fleet-wide updates cannot guarantee that rollout stops
  before every installation has received the bad package.
- Use the existing Tipme Cloudflare account and resources. Account ownership
  will not change and a dedicated replacement account is not planned. This
  resolves the account-separation question carried forward from #9 and rejects
  the earlier research recommendation to move production to a dedicated account.
  Existing per-stage isolation and resource-protection requirements still apply.

## Incident grouping and operational evidence

- The support service durably owns incident assignment and resolution state;
  Banquinha displays and manages it, and Discord provides notifications. An
  audited Operator CLI provides inspection and claiming if Banquinha is down.
  A failed Discord notification must not lose the incident. These are planned
  capabilities, not claims about existing tooling.
- Group a shared failure into one incident listing affected installations.
  Update its impact and resolve it when recovery checks pass. Unrelated
  installation failures remain separate incidents.
- Keep Workers Logs without adding Logpush. Operational events use opaque
  Client/Slot identifiers, operation identifiers, versions, timings, outcomes and
  bounded error codes. Do not log report text, Reporter identities, secrets,
  full URLs or sensitive headers. Incident records contain only the minimum
  operational evidence required for recovery. The existing privacy design's
  Workers Logs retention policy still applies. Incident records are retained
  until resolved, then for 90 days; aggregate
  metrics are retained for 12 months. These periods do not extend Support request,
  privacy-ledger or recovery-audit retention. Dashboard projections and caches
  must follow the same incident expiry, not create an indefinite second store.
- Every authenticated GETQUICK team member may view, claim and resolve incidents.
  Recovery actions require separate Operator permissions. Banquinha enforces
  authorization server-side and audits changes; Discord membership alone grants
  no recovery authority. Claiming is atomic so concurrent viewers cannot both
  silently become the owner.
- An independently running health check on existing infrastructure detects
  support-service outages without depending on the Worker or Banquinha. Persist
  notification failures and retry Discord delivery without duplicating incidents.
  Distinguish service, dashboard and notification failures. This adds no reminder
  or automatic escalation for an unclaimed incident.

## Objectives, inventory and readiness

- Measure staging and initial production behavior before committing to numerical
  delivery/freshness objectives. Track acceptance failures, delivery delay,
  oldest pending work, sweep health, status freshness, authentication failures
  and per-Client usage. Preserve immediate configuration/conflict/suppression
  alerts, 15-minute unresolved-ambiguity alerts and 24-hour delivery handoff/deadline
  alerts from the delivery design. Further thresholds follow measurement.
- Banquinha shows Client, Slot/environment, deployed and desired versions,
  last verified health with observation time, update outcome, resource references
  and responsible team. Show secret ownership and rotation dates, never secret
  values. Stale observations are labelled stale. Ordinary WordPress requests
  must not perform remote health checks.
- Require successful recovery drills before production onboarding and after
  changes to the affected recovery paths: provider outage, credential revocation,
  broken webhooks, uncertain GitHub outcomes, D1 restore with suppression replay,
  failed updates and local disable/re-enable. Keep privacy-safe evidence and
  human sign-off. Verify each Client's independent emergency contact route.

## Release and compatibility procedure

"Latest" means the approved production release, including a temporarily approved
recovery package. A published candidate is not approved merely by existing.
Fleet-wide rollout means dispatch to all eligible installations together and
track each result; it does not promise simultaneous completion. Scheduled or
manual update maintenance is permitted separately from support connection checks.
No remote update/health check belongs in ordinary page rendering.

| Installation/package | Worker/data compatibility | Operational action |
|---|---|---|
| Approved current release | Current contract and schema | Normal operation |
| Previous approved release during rollout | Previous contract preserved for at most 24 hours from fleet release dispatch | Attempt update; record actual completion and alert confirmed failures |
| Incompatible package or previous release past window | New intake disallowed | Disable new submissions locally; preserve update/recovery controls and accepted work |
| Approved rollback package | Verified compatible contract and data required | Temporarily designate as approved production version and converge fleet |
| Worker rollback | Must understand live schema and all accepted records | Refuse unsafe rollback; recover forward or use rehearsed restore procedure |

The fleet release record contains immutable release ID, package version/hash,
Worker commit, API contract version, schema migration range, previous approved
package, dispatch time and compatibility expiry. The updater records desired,
attempted and observed versions separately. A missing observation is stale or
unknown, never a successful update. An unreachable installation cannot be
remotely disabled with certainty: enforce version/expiry at service intake as
well, then apply the local restriction when the installation next runs. Do not
discard an accepted request when restricting new intake.

1. Build and verify the exact package with the existing release workflow.
   Record provenance and an immutable artifact reference; never repack between
   verification and delivery. Stage the matching Worker, supported API contracts
   and additive schema migrations. Run the relevant installed-package, security,
   privacy, performance and recovery checks.
2. Require a credentialed production Alchemy plan proving no replacement or
   deletion of protected databases/resources, including `SupportDB` and the
   suppression ledger. Preserve the plan with release evidence. Deploy CI must
   use the guarded destroy wrapper and reject direct destructive commands.
   Tests of the local wrapper alone do not prove the production plan is safe.
3. Deploy backward-compatible Worker/schema changes before distributing the new
   plugin. Preserve the prior contract for the agreed transition. If staging or
   migration checks fail, stop before fleet dispatch. Flags and the approved
   release pointer are versioned configuration; evaluate service flags at intake
   and cache local UI controls, without page-render service calls.
4. Dispatch the approved release to the entire eligible fleet together through
   existing central deployment tooling or the private native updater. No
   production canary cohort or per-installation approval is required. Track each
   result, alert confirmed failures and enforce the 24-hour transition policy.
5. On package failure stop further distribution, mark the bad release withdrawn
   and restore the verified compatible package automatically where safe. Prevent
   an updater from immediately reinstalling the withdrawn release. All sites may
   already have received it; inspect the whole fleet. Do not automatically undo
   database migrations or restore D1 as a package rollback step.
6. Remove obsolete API/schema structures only when the fleet is confirmed updated
   and the approved recovery path no longer requires them. Unreachable/stale sites
   do not count as confirmed. Record the new rollback boundary before cleanup.

## Private package access

Use central deployment credentials centrally. Native WordPress updates require
a non-WordPress.org `Update URI`, bounded/cached metadata and plugin-specific
download handling. WordPress provides an [update metadata hook](https://developer.wordpress.org/reference/hooks/update_plugins_hostname/)
and a [download hook](https://developer.wordpress.org/reference/hooks/upgrader_pre_download/);
they do not implement this project's entitlement or package verification policy.
Core's [scheduled checks](https://developer.wordpress.org/reference/functions/wp_schedule_update_checks/)
cannot establish simultaneous fleet completion.

Keep broad GitHub credentials off installations. Serve only approved, immutable
package bytes over an allowlisted HTTPS origin using narrow update authorization
in headers, with integrity checked against authenticated approved metadata.
Never put durable secrets in package URLs or log download authorization. Bound
timeouts, redirects and response handling, and refresh expired download access
through the update path rather than accepting an arbitrary URL.

Report-submission disablement or Installation credential revocation must not
remove the recovery path: retain separate narrow update authorization or existing
central hosting access. Explicit offboarding revokes update authorization and
stops central automatic deployment. An update entitlement is never Operator
authority or permission to submit/read another installation's reports.

## Operational event and metric contract

These are logical fields and measurements, not a committed database migration.
Identifiers are opaque; low-cardinality metric dimensions are stage, operation,
outcome and bounded error class. Client/Slot attribution may use restricted
records or bounded aggregation rather than putting every request ID into metric
labels. Treat opaque IDs as restricted operational data, not inherently anonymous.

| Record | Minimum fields |
|---|---|
| Event | Time, stage, component, event code, opaque operation correlation, outcome, duration where applicable; Client/Slot only when verified and relevant |
| Incident | Stable ID, grouping key, category, first/last observation, affected Slot references, open/resolved state, claimant, resolution code/time, runbook reference |
| Incident audit | Incident ID, authenticated opaque actor, action, timestamp, previous/new state; no free-form report content |
| Notification | Event/incident ID, destination reference, delivery state, next attempt, attempt count and bounded error code; never Discord credentials |
| Inventory observation | Slot/environment, desired/observed versions, observed-at, component health, update outcome and inventory/resource references |

Discord and Banquinha must not become additional copies of Submitted text.
Support-request notifications reference the trusted accepted/delivered record and
its actual delivery outcome; do not imply GitHub creation before confirmation.
Deduplicate notifications by source event, destination and transition. A lost
Discord response may leave delivery uncertain; retry should update an existing
message where its identity is known and must never create a new incident.
Exactly-once Discord message delivery is not promised.

| Measurement | Meaning |
|---|---|
| Intake latency/failures | Service acceptance timing and outcome, separate from browser or GitHub timing |
| Accepted durability | Accepted records surviving tested recovery without loss or duplicate dispatch |
| Delivery latency | Acceptance to confirmed GitHub creation; pending/failed/unknown are counted separately, not dropped from reporting |
| Backlog | Pending/failed/unknown counts and oldest due/unknown age by verified Slot |
| Scheduler | Last successful sweep, due age, poisoned-record isolation, claim contention, fairness and provider pacing |
| Status freshness | Last successful observation, refresh backlog, sweep lag and webhook rejection/failure; no client-visible comment/reply SLA |
| Authentication | Bounded rejection reasons and rates; no submitted identifiers or sensitive headers |
| Resource usage | Measured request/storage/work attribution per Client, with shared costs labelled shared/estimated |
| Privacy and release | Cleanup/ledger progress, expiry failures, migration outcome, update convergence and observation age |

Workers Logs retain the configured provider retention under the existing privacy
design, without Logpush. Record the actual configured retention and access policy
as readiness evidence; do not assume a new duration. Restrict raw logs and audits
to authorized operational access; the whole team gets the minimal incident view.
Aggregate metrics must not retain request-level data after its own expiry.

## Alert rules and availability boundaries

Existing delivery thresholds remain policy; other numerical service thresholds
are established from staging and early production measurements before promises
are made. The absence of traffic or webhooks is not by itself an outage.

| Signal | Rule and routing |
|---|---|
| Configuration/permission rejection, duplicate/conflicting create evidence, suppression failure | Immediate grouped incident and Discord notification |
| Unknown create | Incident/notification at 15 minutes unresolved; update same incident at 24-hour Operator handoff; no force-create |
| Known-non-created report | Alert at 24-hour automatic retry deadline; preserve report under existing retention |
| Confirmed update failure, incompatible installation, migration failure | Immediate incident; halt unsafe release actions and enforce intake policy |
| Webhook 401/5xx | Route existing failure signals; verify staging `break` drill reaches Discord and the incident record; group sustained failures |
| Refresh backlog/sweep lag | Preserve existing one-hour log signals; tune earlier operational thresholds from measured behavior |
| Intake, scheduler, resource contention, auth rejection rates | Measure baseline and set bounded evaluated rules; never page for each untrusted bad signature |
| Retention/erasure/suppression processing failure | Incident on a confirmed failed safety operation; show unresolved state honestly |
| Worker, dashboard, Discord, provider or installation reachability | Separate components/observations; independent checker detects missing service; stale installation data stays unknown |

The monitoring runner must not depend exclusively on the Worker, D1, Banquinha or
their ability to report their own failure. If D1 is unavailable, its incident store
and CLI cannot be assumed usable; the independent check must still surface the
failure through the available notification path and reconcile the incident when
storage returns. Discord outage prevents Discord delivery; retain/reconcile
notification state and use the existing independent contract contact when needed.
No new notification provider or automatic fallback email is authorized.

## Inventory, custody and offboarding

The approved inventory maps Client and Slot/environment to repository/App
installation, resource IDs/stage/account, desired/observed versions and observation
times, deployment method, responsible team, independent emergency contact route
and verification evidence. Store contact details only in the restricted inventory,
not metric labels or Discord. Record credential purpose, owner, stage, location
reference, expiry/rotation evidence and revocation procedure, never its value.
Follow the existing [App-key custody runbook](runbooks/github-app-key-custody.md).
The [Slot inventory](../worker/README.md#slot-inventory) (#137) implements this
record. Its observations display as stale/unknown 24 hours after observation, the
previous-release compatibility window; that is a display rule, not an objective.

Offboarding is an explicit Operator action: verify Client/Slot scope, suppress new
dispatch, revoke the Slot using the existing Operator workflow, revoke narrow
update authorization and stop central deployments. Preserve the suppression and
unknown-outcome review state; uninstall or local disablement is insufficient.
Follow the existing 30-day content-purge grace and privacy retention/erasure rules;
GitHub issues remain in the Client repository. Remove Client-specific monitoring
and access when appropriate, without deleting shared stage resources used by other
Clients. Verify effects and retain only the audit permitted by existing policy.

## Production readiness evidence

Every row requires a linked implementation/check result, date and human sign-off;
this design and closed planning tickets are not evidence of implementation.

- Release matrix, verified package provenance, fleet delivery/rollback and
  24-hour compatibility enforcement; no direct destructive CI command.
- Credentialed production plan proving protected databases are retained.
- [Security](support-security-design.md), [security regression](security-regression-tests.md),
  [privacy](support-privacy-design.md), [delivery](support-delivery-design.md),
  [context](support-context-design.md) and [performance](research/idle-performance-budgets.md)
  gates, including erasure/export, retention and suppression replay.
- Server-side team/Operator authorization, audited incident claims and CLI fallback.
- Actual Discord destinations, Banquinha integration, independent monitor execution
  location and credentials, incident/notification persistence and failure tests.
- Recorded log retention/access, incident/metric expiry, measured initial thresholds,
  complete inventory and secret ownership/expiry/rotation evidence.
- All drills in the [operations runbook](runbooks/support-operations.md), including
  the broken-webhook notification and independent contact drill for each Client.

Banquinha is a separate repository integration and requires a dedicated session
and worktree before work there. Exact channel IDs, hosting/deployment adapters,
independent runner location and credentials are implementation inputs to collect
before onboarding, not values established by this interview.

## Established constraints

- Shared Worker and D1 resources per stage follow ADR 0013; D1 jurisdiction
  follows ADR 0017.
- Recovery follows ADRs 0016 and 0019: restore suppression and revocations before
  service resumes, and never blindly recreate uncertain GitHub outcomes.
- Delivery recovery uses the D1 outbox; Queues and DLQ are deferred.
- Website rendering must remain independent of support-service availability.
- Existing release CI verifies packaged bytes and installed upgrades, but does
  not establish automatic delivery to client installations. Worker deploy CI
  plans through the [deployment plan gate](runbooks/support-operations.md#deployment-plan-gate)
  (#140), which refuses protected-resource replacement/deletion and applies only
  a retained, identical plan. No credentialed production plan has been recorded.
- Existing webhook runbooks describe log signals. #138 routes the delivery,
  webhook, status-lag and privacy signals above as grouped incidents and reports
  measured health ([Worker README](../worker/README.md#routed-operational-signals)).
  Webhook outcomes come from GitHub's authenticated delivery log, never from
  untrusted requests. No baseline, objective or additional threshold has been
  recorded, and the staging broken-webhook drill has not run: its Discord
  destinations are not configured.
- Independent outage detection (#139) runs on GitHub Actions, outside Cloudflare,
  and reconciles what it saw into `component_unavailable` incidents once storage
  returns ([Worker README](../worker/README.md#independent-outage-checks)). Its
  state is a 7-day workflow artifact, not an incident authority. It is not set up
  or rehearsed for any stage yet.
