# Support operations recovery

Design/runbook for [#20](https://github.com/Quick-Release/gq-support/issues/20),
subject to the [operations design](../support-operations-design.md) and its
production readiness gates. This document does not authorize deployment. Signal
routing rules and update adapters are planned capabilities until their implementation
evidence is recorded; do not infer a runnable command from a procedural instruction
below. Incident claim/resolve and the incident CLI are implemented (#135), as
described in the [Worker README](../../worker/README.md#operational-incidents).
Discord notifications of accepted Support requests and incidents are implemented
(#136, [Worker README](../../worker/README.md#discord-notifications)), but no
stage has approved destinations configured until the setup below is evidenced.
Routed signals and measured health are implemented (#138, [Worker README](../../worker/README.md#routed-operational-signals)):
delivery ambiguity, deadline and rejection, webhook `401`/`5xx`, status lag and
privacy/ledger failures open grouped incidents from durable records, and
`pnpm operator health` shows measured observations. No stage has recorded a
baseline or tuned threshold yet. The independent checker is implemented (#139, [below](#independent-outage-checks)),
but no stage has it enabled until its setup is evidenced.
Staging/prod deployments go through the [deployment plan gate](#deployment-plan-gate) (#140);
no credentialed production plan has been recorded yet. Production onboarding is
gated by the [production readiness check](production-readiness.md) (#148).

## Common procedure

Any authenticated GETQUICK team member can claim an incident. Recovery mutations
require separately authorized Operator credentials and an audit. Unclaimed
incidents stay visible with no automatic escalation or claim-time reminder.

1. Claim the durable incident in Banquinha, or use its audited CLI fallback
   (`pnpm operator incident-claim`). Identify affected component, stage and Slots from trusted records.
   If storage itself is unavailable, preserve minimal independent evidence and
   reconcile ownership/history when it returns; neither CLI nor dashboard can
   promise writes through a database outage.
2. Record time, opaque actor/incident IDs, bounded failure code and affected
   installation references. Never copy report text, secrets, full URLs, payloads
   or sensitive headers into Discord, an incident or the recovery evidence.
3. Separate WordPress reachability, Worker/intake, D1, GitHub, webhook/status,
   Banquinha and Discord failures. An outage of one does not prove another is down.
4. Freeze unsafe changes or dispatch when necessary through approved controls.
   A stopped caller is not proof a provider-side create stopped. Check uncertain
   work before requesting or authorizing replacement reports.
5. Recover through the relevant procedure, verify invariants and affected Slots,
   then resolve the incident with outcome and evidence. A provider recovery alone
   does not prove the backlog, privacy cleanup or status projection recovered.

Run existing Operator commands from `worker/` with explicit stage, Tipme account,
main/ledger database IDs as applicable and independent Operator credentials, as
documented in the [Worker README](../../worker/README.md). Never use an
Installation credential as Operator authority.

## GitHub outage or stalled delivery

- Check known-non-creation versus uncertain attempts and provider pacing before
  acting. Preserve accepted D1 records; let bounded known-non-creation retries
  follow the [delivery design](../support-delivery-design.md).
- Inspect due age, sweep progress, claim contention, per-Slot fairness and poisoned
  records. Isolate a malformed record so it cannot block unrelated delivery.
  Failed/unknown D1 records are the recovery backlog; there is no queue/DLQ
  prerequisite or blind redrive command in this slice.
- Alert configuration/conflict failures immediately, ambiguity at 15 minutes and
  deadline/handoff at 24 hours. Group related failures without hiding affected
  requests. Do not create new reports from a failed notification.
- Use audited existing `reconcile`/`resume` workflows only under their documented
  preconditions. `resume` must refuse uncertain, suppressed and unsafe work.
  An empty or incomplete GitHub scan never proves non-creation. There is no
  force-create command for an unknown attempt.
- Confirm scheduler recovery, safe mappings and backlog progress before resolving.

## Worker, D1 or Cloudflare outage

- Use the [independent checker](#independent-outage-checks)'s notice and run
  summaries, and available provider observations. Neither a dead Worker nor a
  failed D1 can reliably persist its own incident, and neither the CLI nor the
  dashboard can claim one until storage returns.
- Leave ordinary websites independent of the support outage. Before acceptance,
  preserve only the existing in-memory draft guarantees; do not promise eventual
  delivery or add a WordPress delivery outbox.
- Restore the affected service through existing authorized access. Use the D1
  restore procedure below only when necessary; an outage alone is not a reason
  to restore or rewind data.
- Reconcile incident/notification observations after recovery. Check accepted
  requests, delivery sweep and privacy processing before declaring recovery.
- If staff or Clients need an independent handoff, use the verified contract
  contact. No automatic fallback email or new provider is approved.

## Revoked App or installation credential

- Determine credential class, affected stage/Slot and legitimate revocation
  reason. Suspend unsafe mappings and stop new unauthorized intake/dispatch.
- Follow [App key custody](github-app-key-custody.md) for App replacement. Re-enroll
  an installation only after an Operator verifies its approved Slot and mapping.
  Do not automatically undo revocation, lift suspension or trust a copied site.
- Report disablement/key revocation does not cancel accepted work. Separate
  narrow update access or central hosting access must remain available for
  recovery unless explicitly offboarded.
- Verify unrelated Slots remain isolated, new credentials work in their intended
  scope and old credentials remain rejected, including after restore replay.

## Missed or broken webhooks

Follow [missed webhooks](missed-webhooks.md) and [webhook rotation](github-webhooks.md).
The receiver's absence of logs is not proof that no provider delivery failed.
Use the documented status-health, reconciliation and repair evidence workflow.
Webhook incidents come from GitHub's own delivery log, read each minute: a
`401` opens `webhook_rejected`, a `5xx` or missing response `webhook_failed`.
Forged requests are never counted. A `5xx` answered during a D1 outage is
counted only once D1 is back; the [independent checker](#independent-outage-checks)
covers the outage itself as a separate `component_unavailable` incident.

The staging `scripts/github-webhook-staging.py break` drill must create the routed
incident and Discord notification, then restore configuration and confirm
the projection catches up. Do not edit production webhook configuration as a drill.
It is readiness-gated: run it only after the staging Discord destinations are
set up and evidenced (below), with authorized credentials.

1. Record the start time, then run `break` and the existing transitions so GitHub
   sends deliveries that fail with `401`.
2. Within a few minutes, confirm the `webhook_rejected` incident (`pnpm operator incidents`)
   and its message in the staging incident channel.
3. Run `restore`, let a genuine delivery be acknowledged, then claim and resolve
   the incident. `recovery_not_verified` means no acknowledged delivery yet.
4. Run `pnpm operator drill-verify webhook <start>`; keep its output with the
   status-repair evidence. `passed` is evidence for sign-off, not a substitute.
   A local test pass is not staging evidence.

## D1 restore or corrupting migration

The maintenance boundary, restore recording, replay verification and resume are
implemented (#146; [Worker README](../../worker/README.md#maintenance-boundary-and-restores)).
They have been rehearsed only locally (`pnpm recovery-drill`, below); no staging
restore, Time Travel operation or credentialed drill has run. All commands take
`--stage`, `--account-id`, `--database-id` and `--ledger-database-id`.

1. **Halt.** Stop deployments and fleet changes. Begin maintenance with an opaque
   actor and the incident ID as evidence:
   `pnpm operator maintenance-begin <actor> restore <incident-id>`.
   The boundary lives in `SupportLedger`, which the restore never rewinds. From
   the next request every Worker isolate answers `503` (except the independent
   checker's probe, which reports `maintenance: active`), scheduled ticks do no
   work, no create is authorized, and guarded Operator mutations are refused.
   Revocation, erasure, offboarding and update-access revocation still apply,
   ledger first. Webhooks that would write are refused with `503`; plan a
   `status-reconcile` from the maintenance start afterwards ([missed webhooks](missed-webhooks.md)).
   Ordinary WordPress page rendering is unaffected.
2. **Drain.** Wait until `pnpm operator maintenance-status` shows `drained: true`
   (2 minutes after the start: a tick's phases end within 58 seconds, a
   request's background delivery within 25). Creates already posted may still
   succeed at GitHub later; they are found by marker in step 6.
3. **Verify inputs.** Confirm stage, account and resource IDs, the approved
   restore point and that `SupportLedger` answers. Never restore `SupportLedger`
   together with `SupportDB`; never restore any production resource as a drill.
   A ledger that cannot be read blocks every later step.
4. **Restore `SupportDB` only**, with the provider's current Time Travel
   operation, reviewed against Cloudflare's documentation at the time. Then
   record it: `pnpm operator restore-recorded <actor> time-travel-restore`.
   It is refused outside a drained restore maintenance and bumps the external
   restore epoch.
5. **Replay.** The next scheduled tick (or any request) replays the ledger into
   the restored database while maintenance still holds: suppressions, erasures,
   cleanup records, offboardings, suspensions and report/update key revocations
   come back; restored text under cleanup is purged; every request that is not
   delivered becomes `outcome-unknown`; acknowledged independent-checker
   episodes come back, reopening their `component_unavailable` incident for
   review. `maintenance-status` shows `replayed_epoch` equal to `restore_epoch`.
6. **Verify and resume.** `pnpm operator maintenance-end <actor> <generation> <incident-id>`
   refuses, listing bounded blockers, until: drained, restore recorded, replay
   complete, every ledger suppression/erasure/offboarding/suspension present,
   no ledger-revoked key usable, no erased text left, no withdrawn release
   current again and every retained episode present. For `withdrawn_release_current`,
   run `release-withdraw` again (allowed during maintenance once replayed).
   Then reconcile: restored uncertain creates are reconciled by marker on the
   normal schedule; positive evidence settles them, an empty or incomplete scan
   never proves absence, nothing is force-created and `resume` refuses them.
   Review reopened incidents and run `status-reconcile` before resolving.
7. Record the evidence below; the `maintenance_audit` and `ledger_audit` rows hold
   actors, evidence references and times.

An incident maintenance (`maintenance-begin <actor> incident <incident-id>`) uses
the same boundary without a restore, for example to stop all intake and dispatch
during a privacy exposure; it ends once drained and verified.

## Retention, erasure or private-data exposure

- Treat a confirmed suppression/cleanup failure as an incident. Preserve only
  minimal authorized remote-outcome records for unresolved erasure and never
  claim completion from a timeout, missing search result or content expiry.
- Check cleanup/ledger progress against the [privacy design](../support-privacy-design.md).
  Never-delivered text expires 12 months from acceptance; delivered closed-request
  and offboarding retention retain their existing clocks. Do not extend them by
  copying data to incidents or Discord.
- Contain exposed data: revoke inappropriate access and stop affected delivery or
  downloads. The plain-text slice has no approved attachment subsystem. If a
  private attachment is encountered, restrict access and investigate its source;
  do not copy it into recovery evidence or invent an attachment replay path.
- Use the established erasure/redaction workflow and record residual-copy
  exceptions honestly. Rotate exposed credentials through their custody procedure.
  Obtain the appropriate human privacy response for actual exposure.

## Failed plugin update or local fail-safe

- Halt distribution of the bad release and inspect every targeted installation;
  there is no canary cohort to limit impact. Restore the previous verified
  package automatically only when compatible with live data/API, with
  `release-withdraw` ([fleet rollout and recovery](#fleet-rollout-and-recovery)).
- Withdrawal approves the recovery package so automatic updates cannot loop back
  to the withdrawn version. Do not reverse migrations or restore the shared
  database as an automatic plugin rollback. Use forward repair or the separate
  restore path.
- For a broken local UI use `GQ_SUPPORT_DISABLED` or deactivate the plugin through
  existing admin/hosting access, per [outage recovery](../research/outage-draft-recovery.md)
  and #67. Implementation must be verified before relying on that constant.
- Disable new submissions on incompatibility or expiry of the previous-release
  window, preserving update/recovery access and accepted service-owned work.
  An unreachable site is unknown; enforce intake compatibility service-side too.
- Re-enable after verifying package/assets, installation identity, compatibility
  and privacy/security checks. Recover uncertain receipts/reports before any
  manual replacement. Lost browser memory is not evidence of failed acceptance.

## Approved releases and intake enforcement

Commands are in the [Worker README](../../worker/README.md#approved-releases).
Record only what reviewed artifacts and run evidence show.

1. Download the release workflow run's `gq-support.zip`, manifest and
   `provenance.json`. Record the candidate with the commit of the Worker deployed
   with it, the contract version and schema migration range its checks covered,
   and `signed` (or `unsigned-legacy` for a package before #141). After any
   signed release has been approved, unsigned legacy packages cannot receive
   production or recovery approval.
2. Record its gates with `release-verify`, then approve it as `production`,
   naming the approved release from `release-status`. Deploy the
   backward-compatible Worker and its additive migrations first.
3. Launch it with `fleet-launch`: the dispatch is recorded at that actual start.
   The previous release keeps new intake for 24 hours from that time, then gets
   426 at the service, and WordPress closes new reports itself once its cached
   policy says so. Unreachable sites stay `unknown` in the inventory.
4. For a bad release, `release-withdraw` it to the earlier verified compatible
   package, which dispatches that as `recovery`. Accepted work, revocations and
   suppressions are untouched.
5. A stage starts `staged`. Switch it to `enforced` in `stageReleaseEnforcement`
   by reviewed PR only after its first approval and dispatch are recorded and
   `release-status` and the inventory show them. Production stays not ready
   while it is `staged`.

Accepted Submission IDs and Change IDs always replay their receipt, so an
expired window never turns a retry into a false failure. If new intake answers
503 under enforcement, check `release-status` for a missing or malformed record.

## Native WordPress updates

Installations whose reviewed deployment method is `native` update themselves
through WordPress's own updater (#142); `central` ones use central deployment
tooling and the Composer package instead. Commands are in the
[Worker README](../../worker/README.md#native-updates).

1. **Durable package.** The release workflow attaches the exact tested
   `gq-support.zip`, manifest and provenance to the private repository's
   `v<version>` GitHub Release and reads the asset back against the tested
   SHA-256. Enable GitHub's immutable releases for the repository so a published
   asset cannot be replaced. The Worker serves bytes only when they match the
   Approved release's recorded SHA-256, so a replaced asset is refused, not served.
2. **Read credential.** Each stage needs `SUPPORT_UPDATE_PACKAGE_TOKEN` in its
   GitHub Environment: a token with only read-only Contents access to
   `Quick-Release/gq-support` (a fine-grained token or a separate GitHub App's
   installation), never the support GitHub App, whose permissions stay Issues and
   Metadata. The gated deploy uploads it as the Worker secret `UPDATE_PACKAGE_TOKEN`
   and removes the secret when it is unset, which closes native updates (503).
   Record its owner, expiry and rotation in `worker/src/inventory.ts`. To rotate
   it, create the new token, replace the Environment secret, deploy through the
   plan gate and revoke the old token. To revoke it, revoke the token at GitHub
   and remove the secret, then deploy; native updates stop until replaced.
3. **Provision an installation.** Set the Slot's `deployment: "native"` in its
   Repository mapping by reviewed PR. On the installation run
   `wp gq-support update-key` and send GETQUICK the printed public key, never a
   secret. Grant it with `update-access-grant` and an expiry of at most 400 days;
   then `wp gq-support update-check` must show the approved release.
4. **Rotate or renew.** Run `wp gq-support update-key --rotate` and grant the new
   key with `--ledger-database-id`: rotation first permanently revokes old keys
   in the suppression ledger, then grants the replacement. If replacement fails,
   use existing hosting access and retry; the old key stays revoked. Renew before
   expiry the same way; `update-access-status` and the inventory show each Slot's
   grant state and expiry.
5. **Revoke.** `update-access-revoke <slot> <key-id|all>` with the ledger
   database, which records the revocation first so no D1 restore revives it.
   `offboard` revokes every update key of the Slot itself. Revoking the report
   Installation credential, `GQ_SUPPORT_DISABLED` or disconnecting the site does
   not stop updates; only this does.

WordPress asks the service only in cron, WP-CLI or the Updates screen's
"Check again", at most hourly; ordinary pages never do. Core files a native offer
only after its own WordPress.org update check succeeds, and its scheduling cannot
promise prompt completion. Serving a package records `attempted`; the next signed
metadata check from the new version records `observed`. Neither alone is a
completed update. A recovery approval withdraws the bad release at once: the
service refuses its download (410) and offers only the approved package. Core
does not downgrade through its updater, so the plugin installs an approved
recovery release older than the installed one itself, from core's scheduled
update event or `wp gq-support update-recover` (#144): the exact verified bytes,
never over a symlinked checkout, at most hourly and twice per recovery release.
Metadata checks sign the installed files' digest, which is what verifies a native
update; a plugin before #144 signs only its version and stays `unknown`.

## Central deployment

Installations whose reviewed deployment method is `central` get the approved
release from an Operator over the hosting access GETQUICK already holds (#143).
Commands are in the [Worker README](../../worker/README.md#central-deployment).
No stage has a reviewed central target yet: this repository records no central
deployment host, alias or path, so `central-apply` refuses every Slot. The
existing central site deployment tooling and its credentials are outside this
repository; collect them through the implementation workflow, never guess them.

1. **Review a target.** Set the Slot's `deployment: "central"` in its Repository
   mapping and add its `stageCentralTargets` entry by reviewed PR: the runner that
   reaches the host (an ssh alias resolved by the Operator's own ssh
   configuration, for example), WP-CLI with its `--path`, the installed plugin
   directory and an upload directory. Record who owns that hosting access and
   how it is revoked in the inventory's credential custody. Never put a key,
   password, token or URL with credentials in the target.
2. **Apply.** After the release's fleet dispatch is recorded, download its tested
   package (`gh release download v<version> --repo Quick-Release/gq-support
   --pattern 'gq-support*' --pattern provenance.json --dir <dir>`) and run
   `central-apply <slot> <release-id> <dir> <opaque-actor>`. The bytes must match the
   approved SHA-256; the host checks its upload's digest; WordPress installs that
   upload; the files read back must be exactly the package's.
3. **Read the outcome.** `verified` is complete. `failed` was confirmed by a
   read-back: alert, keep the installation's current version and investigate.
   `unknown` lost its answer after the install was requested: run the same
   command again once the host answers, which verifies without reinstalling when
   the install did complete. `unreachable` and `refused` changed nothing: restore
   access, or fix the reason (a symlinked checkout, an unavailable plugin, a
   downgrade outside a recovery approval, a newer approval). `central-status`
   lists recent outcomes; an `abandoned` record may have changed the installation,
   so verify it with another run.
4. **Recovery.** `release-withdraw` the bad release to the earlier verified
   compatible package, then `fleet-run` it: only a recovery approval downgrades.
   Report-key revocation, `GQ_SUPPORT_DISABLED` and disconnecting do not affect
   this path; offboarding does, and refuses further applications.

### Composer approval record

A Composer-managed central Slot is never installed by `central-apply`: its site
deployment tooling (gq-site) changes the site's lock and installs the package
itself. What it may install comes only from this read-only Operator command,
run with the Operator's own Cloudflare and `gh` logins and the ledger:

`composer-approval <slot> <release-id> <dir> <prepare|deploy>` with `--stage`,
the database IDs and `--ledger-database-id`, where `<dir>` holds the release's
tested package as downloaded above.

It prints one `gq-support.composer-approval/v1` record (stage, Slot, phase,
release ID, `getquick/gq-support` version and approved ZIP SHA-256, the source
commit and release run, the published `v<version>` tag's commit, every file's
SHA-256, the `gq-support.files/v1` files digest and the observation time), or
refuses and prints nothing. It writes nothing. It refuses during maintenance,
before a recorded restore is replayed, for a Slot that is not central or is
offboarded (also when only the ledger still says so), for anything but the
current approved, verified, signed release, a withdrawn release, an unserved
contract or a live schema outside the release's tested range, for artifact
bytes, manifest or provenance that are not the approved ones, and when the
published tag's git tree is not exactly the approved files.

- `prepare` works before the fleet dispatch: use it to prepare the lock change.
- `deploy` needs the dispatch, and is valid only as it is read: run it again
  just before each install, and stop if it refuses or differs from the prepared
  record.
- The source commit, the tag's package commit (what `composer.lock`'s
  `source.reference` must be) and the approved ZIP bytes are three different
  identities. A registry may repack its dist ZIP: verify an install by its files
  against `files` and `files_digest`, never by registry ZIP bytes.

There is no remote endpoint, detached signature or verification key for this
record; the full contract is in `worker/src/composer-approval.ts`. Composer
central targets stay refused by `central-apply` and `fleet-run`.

## Fleet rollout and recovery

Commands are in the [Worker README](../../worker/README.md#fleet-rollout-and-recovery).
Run them from a clean, reviewed checkout with `gh` logged in; every gate and
deployment check reads GitHub's own run records, so nothing is typed in as proof.
No release has been gated, launched or withdrawn for any stage yet.

1. **Gates.** After the release workflow run, CI on `main` and the gated staging
   deployment of the candidate's Worker commit have passed, run
   `release-verify <version> <artifact-dir> <ci-run> <staging-deploy-run> <actor>`.
   A refusal lists each failed gate; fix the cause and run new checks, never edit
   records. Then approve the release.
2. **Compatible Worker first.** Deploy the release's Worker commit to the stage
   through the plan gate. Its migrations must be additive; a destructive one needs
   a recorded rollback boundary (step 6) first.
3. **Launch.** `fleet-launch <release-id> <deploy-run> <actor>` dispatches the
   release to every Slot together. It refuses, listing what is missing, without
   the gates, a safe applied deployment of that commit, a reviewed live migration
   state inside the release's range, or a compatible recovery package. The
   previous release's 24 hours run from the launch.
4. **Converge.** Native Slots update from WordPress cron; run
   `fleet-run <release-id> <artifact-dir> <actor>` for central ones, again after
   unreachable hosts return. `fleet-status` shows each Slot. Only `verified`
   counts: `unknown` (lost or abandoned outcome, version without files, silent for
   a day), `unreachable` and `blocked` need follow-up through hosting or admin
   access, never page-render checks. A `release_update_failed` incident lists
   confirmed failures; claim it, investigate and resolve once the Slots verify.
   After three possibly-applied attempts on one Slot, `fleet-run` leaves it to you.
5. **Withdraw.** For a bad release, `release-withdraw <release-id> <recovery-version>
   <deploy-run> <actor>`. Distribution of the bad release stops at once and the
   recovery package is dispatched. It refuses a package that was never verified
   and launched, was itself withdrawn, or is incompatible with the live contract
   or schema: then repair forward or use the [D1 restore procedure](#d1-restore-or-corrupting-migration);
   never reverse migrations. Inspect every Slot: all may have installed the bad
   release. Native Slots install the recovery package themselves; `fleet-run` the
   recovery release for central ones.
6. **Rollback boundary.** Before a migration removes structures, once every Slot
   verified the dispatched release and its previous release's window ended, record
   `release-boundary <release-id> <schema-floor> <actor>`. Earlier packages are then
   no longer recovery candidates.
7. **Migration failure.** A `release_migration_failed` incident means the live
   migration record was unreadable, unreviewed or differed from its checksum when
   an Operator command read it. Stop launches, compare with `migrations/checksums.txt`
   and repair forward; a later `ok` read resolves it.

Composer-managed central targets are refused and shown blocked: no reviewed
adapter updates their locked version, and a bare package install would be
reverted by the site's next deployment. Stage evidence for the staging drill:
`release-verify`, `fleet-launch`, `fleet-status` before and after convergence,
`release-withdraw` and the recovered status, with the incident IDs raised.

## Inventory and credential custody

Use the [Slot inventory](../../worker/README.md#slot-inventory) to find a Slot's
Client, repository/App mapping, resources, deployment method and team, and to
record evidence:

1. After a deployment or update maintenance, record `attempted` and then the
   `observed` version from a trusted source (central deployment output, the
   installation's admin, or its signed enrollment). Record `failed` only for a
   confirmed failure. Never record an observation you did not see.
2. Treat `unknown` (`stale` or `absent`) as unknown: check the installation
   through hosting/admin access, not by adding remote checks to page rendering.
3. Verify each Client's independent contact: take the existing contract contact
   route and the responsible responder from the Client's contract (never invent
   or guess one; no automatic fallback email), contact it from a device separate
   from the WordPress installation, and record the result with
   `inventory-contact <slot> '<route>' '<responder>' separate-device-drill …` and
   the drill's evidence reference. A written confirmation without that live
   contact is recorded as `attestation` and stays unverified. Run
   `inventory-readiness` before onboarding: it names every Slot still blocked.
   Keep the route and responder out of Discord, issues and metrics.
4. After rotating a credential, update its `rotated` date and evidence (and
   `expires`) in `worker/src/inventory.ts` by reviewed PR. Assign owners there.

## Offboarding

Use the [operations inventory/offboarding checklist](../support-operations-design.md#inventory-custody-and-offboarding).
Commands and their effects are in the [Worker README](../../worker/README.md#offboarding).
No customer offboarding is authorized by this procedure alone.

1. Confirm the Client/Slot scope and record the decision (contract notice or
   reviewed issue) as the evidence reference. Check `inventory <slot>` and
   `central-status <slot>`; never offboard a sibling Slot by mistake.
2. Run `offboard <slot> <opaque-actor> <evidence-ref>` with
   `--ledger-database-id`, then commit `worker/revocations.json`. It suppresses
   dispatch, revokes the report and native update keys (with pending download
   grants and unused enrollment codes) ledger first, and stops central
   applications before their install. Rerun it if it stopped part-way.
3. Read its result and `offboard-status <slot>`: `complete` must be true.
   `delivery.uncertain` and `central.uncertain` are work that may already have
   had its effect (an issue created, a package installed); they stay for review
   and are never re-sent, cancelled retroactively or reported as stopped.
   `native.last_served` is a package already downloaded, which revocation cannot
   retract. Follow up uncertain creates with `cleanup-reconcile` or
   `cleanup-exception` as for retention; read central ones back only if the
   Client asks, through its own access.
4. Remove the Slot's mapping, central target and any Client-specific monitoring
   by reviewed PR when appropriate. Cleanup does not depend on the mapping:
   after 30 days the Slot's content, contact routes and inventory rows are
   purged and only the suppression, revocations and review state remain.
5. Leave GitHub issues in the Client's repository and every shared stage
   resource in place.

Local disable (`GQ_SUPPORT_DISABLED`), disconnect, deactivation or uninstall is
not offboarding: updates keep working and accepted work is still delivered.

## Discord notification setup

Destinations are collected per stage through the implementation workflow, never
from this repository or a chat. Staging first; production only after staging
evidence and readiness sign-off. Do not point a stage at a Client channel or
reuse one channel for both views.

1. A GETQUICK Discord administrator creates, or names, two internal channels for
   the stage: Support requests and Operational incidents. Record the stage,
   server and channel IDs (not secret) and who approved them.
2. In each channel create a channel webhook (Integrations → Webhooks) named
   for the stage, e.g. `GQ Support staging`. Copy each webhook URL directly into
   the stage GitHub Environment secret: `SUPPORT_DISCORD_SUPPORT_REQUESTS_WEBHOOK_URL`
   and `SUPPORT_DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL`. Store the recoverable
   copy in the GQ Support project of the approved secret manager for that stage.
   Never paste a URL into an issue, log, variable or command line.
3. Run the authorized Worker deployment for that stage. The preflight refuses a
   malformed or shared webhook; the apply uploads both Worker secrets.
4. Verify with a synthetic report on a synthetic staging Slot: the Support
   requests channel shows it accepted and later delivered,
   `GET /v1/operations/notifications` shows both destinations `configured`, and
   it or `pnpm operator notifications` shows a recent `last_sent_at` with no problems. Use the suspension
   drill (#57) for an incident message, then claim and resolve it and confirm the
   same message is edited.
5. Drill an outage: rotate (delete) one staging webhook, observe
   `destination_rejected` retries and the incident still visible through the
   operations API/CLI, restore a new webhook through steps 2–3, run
   `notification-retry` if it reached `failed`, and confirm a single incident.

Record the evidence: stage, Worker version, channel IDs, webhook names (never
URLs), secret locations and owner, rotation procedure (delete the webhook in
Discord, then replace the secret and redeploy), timestamps, opaque incident and
request IDs, observed messages, and human sign-off. A configured secret is not
evidence that a channel is connected until step 4 is observed.

## Independent outage checks

The `Independent service check` workflow runs the checker on GitHub-hosted
runners, outside Cloudflare (see the [Worker README](../../worker/README.md#independent-outage-checks)
for what it observes, its notices and reconciliation). It shares GitHub's
failure domain: while GitHub Actions is down nothing runs, and the service's
measured health shows the last observations going `stale`, never healthy.

1. A GETQUICK Operator generates the stage's checker Ed25519 key pair on a
   trusted workstation, e.g. `openssl genpkey -algorithm ed25519 -out checker.pem`;
   the PKCS#8 DER, base64 without line breaks, is the private key and the raw
   32-byte public key, base64, is the public key. Keep the private key out of
   chats, issues, logs and command lines.
2. Store the private key as the stage GitHub Environment secret
   `SUPPORT_INDEPENDENT_CHECK_PRIVATE_KEY`, with its recoverable copy in the GQ
   Support project of the approved secret manager, and delete the local file.
   Set the stage variables `SUPPORT_INDEPENDENT_CHECK_KEY_ID` (e.g. `checker-staging`)
   and `SUPPORT_OPERATIONS_CHECKER_KEYS` (`{"<key-id>":"<public-key>"}`), and
   `SUPPORT_INDEPENDENT_CHECK_SERVICE_URL` to the stage Worker's origin from its
   Alchemy outputs. Only `https://<name>.tipme.workers.dev` origins are accepted;
   a custom domain needs a reviewed change first. Record the key's owner, stage,
   location and rotation in the credential inventory by reviewed PR.
3. The checker reuses the stage's existing `SUPPORT_DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL`
   secret, so complete the [Discord setup](#discord-notification-setup) first.
   Leave `SUPPORT_INDEPENDENT_CHECK_DASHBOARD_URL` unset until Banquinha's
   endpoint is established and added to `APPROVED_DASHBOARD_ORIGINS` by reviewed PR.
4. Run the authorized Worker deployment so it registers the public key, then
   dispatch the workflow for the stage. If the stage Environment has required
   reviewers or wait timers, a scheduled check would wait on them: decide its
   protection deliberately before enabling the schedule. Then set the repository
   variable `SUPPORT_INDEPENDENT_CHECK_STAGES` (e.g. `["staging"]`) to enable the
   schedule.
5. Verify: the run's summary shows every component `healthy` except `dashboard`
   and `installation`; `GET /v1/operations/health` (or `pnpm operator health`)
   shows `independent` components `current`; nothing was posted to Discord.

Drill in staging only, never against production configuration, and only once
the steps above are evidenced:

- **Worker or D1 unavailable**: the workflow has no fault-injection input, and
  no staging fault method is agreed yet. Review one before the drill; never
  point it at production configuration. Then confirm one checker notice in
  the staging incident channel, a failed run if Discord is also unavailable,
  ordinary websites unaffected, and on recovery one `component_unavailable`
  incident, the notice edited to recovered, and a claim and resolve.
- **Discord outage**: rotate (delete) the staging incident webhook. Confirm the
  checker posts nothing, the service holds a `discord` incident visible through
  the API/CLI, and after restoring the webhook (Discord setup steps 2–3) no
  second incident exists.
- **Dashboard outage**: only once an endpoint is approved.

Record the evidence: stage, Worker version, workflow run URLs, key ID (never the
key), timestamps, observed component states, opaque incident IDs, Discord message
observations and human sign-off. A local test pass is not this evidence.

Not yet done for any stage: no checker key is generated or registered, no
service URL or stage list is set, the schedule is not enabled, no run has
executed against a real Worker, Discord destinations are not configured, no
dashboard endpoint is approved and no drill has run.

## Deployment plan gate

**Deploy Support Worker** (`.github/workflows/deploy-worker.yml`) is the only
staging/prod deployment path; the webhook spike's `retire` redeploy uses the same
gate. Run it on **main** with `operation: plan` to record a plan without applying
it, or `operation: deploy` to plan and then apply. Both jobs bind the stage's GitHub
Environment and share the stage's deploy lock. A run cannot apply another stage's,
commit's or run's plan.

Prod needs a reviewed plan. The prod Environment has only a branch policy, no
required reviewers, so the gate enforces review itself: run `operation: plan` for
the commit, have a reviewer check its summary and `plan.json` and record sign-off,
then run `operation: deploy` with `reviewed_plan_digest` set to that plan's digest.
The deploy run applies nothing unless its own plan has the same digest, which holds
only for the same commit, stage, resources, actions and protected identities.

1. The plan job runs typecheck and tests, verifies the App and runs
   `pnpm deploy-gate plan --stage <stage> --out deploy-plan`. This is Alchemy's
   own deploy planning (`alchemy/Alchemist` `Stack.plan`, which `alchemy plan`
   and `deploy --dry-run` also use), run without `--adopt`, `--force`, a resource
   selection or a state-store upgrade. It reads the stage's state and the
   provider; in CI, Alchemy refuses rather than bootstrap or upgrade its state
   store, and the gate stops if either starts. Like `alchemy deploy`, reading
   the state-store token briefly opens a Workers edge-preview session.
   The plan applies no resource.
2. The gate refuses, and records why, if any resource would be replaced,
   deleted or orphaned; the plan is not for `GQSupportWorker`, the stage or the
   Tipme account; it is a destroy plan; `SupportDB`, `SupportLedger` or `Worker`
   is missing or duplicated; or a protected identity differs from the stage's pins
   in `worker/deploy/protected-resources.json`. A stage with no pins may only
   create all three protected resources (its first deployment); once they exist,
   an unpinned stage is refused. Both staging and prod are pinned. Unrecognized
   actions or identity values are refused.
3. `worker/deploy-plan/plan.json` holds the verdict, reasons, commit, stage,
   account, run URL, plan time, each resource's name/type/action, the protected
   resources' D1 database ID/name/jurisdiction/account and Worker ID/name, and a
   digest of the planned changes. No other state attribute, property, binding or
   provider message is retained. It is secret-scanned and kept for 90 days with
   `summary.md`, refused plans included.
4. The deploy job downloads that artifact and runs
   `pnpm deploy-gate apply --stage <stage> --evidence deploy-plan`. It applies
   nothing if the plan is missing, unparseable, refused, edited (digest), for
   another stage, commit, run, account or schema, or planned more than 6 hours
   earlier. It then plans again, refuses unsafe or differing plans, and applies
   that same plan object, not a third plan. `applied.json` records the outcome,
   plan digest, time, run and public stack outputs; it is retained the same way.
   Each run attempt plans afresh: re-running only a failed deploy job cannot find
   its attempt's plan and applies nothing, so re-run all jobs.

Pin identities only from reviewed credentialed evidence: the observed
`databaseId` and `databaseName` of `SupportDB` and `SupportLedger` and the
`workerName` of `Worker`, from a retained `plan.json` (a refused plan records them)
or from the stack outputs of the stage's gated or historical deployment,
cross-checked against a read-only provider listing. Record them in
`worker/deploy/protected-resources.json` under the stage, in a reviewed commit:

```json
{ "staging": { "SupportDB": { "databaseId": "…", "databaseName": "…" }, "SupportLedger": { "databaseId": "…", "databaseName": "…" }, "Worker": { "workerName": "…" } } }
```

**Migration order.** `SupportDB` and `SupportLedger` apply their pending
migrations when Alchemy updates them. The Worker binds each database by its
stable `databaseId`, which Alchemy resolves from prior state, so on its own the
script upload (and with it the new cron) started alongside the migrations: in the
0e6bfc92 deployments, `[Worker] updating` was logged before `[SupportDB] updated`.
The Worker now also binds `SUPPORT_MIGRATED_SCHEMA` (`src/migration-order.ts`), a
plain-text value Alchemy can resolve only after both databases finish their
update in the same apply. Alchemy therefore uploads the Worker only after both
migrate. If either migration fails, Alchemy never uploads the Worker, and the
previous script and cron keep serving.
`worker/test/migration-order.test.ts` proves this against the pinned Alchemy plan
and apply engine and the real Worker declaration. Migrations must stay additive:
the previous Worker runs on the migrated schema until the upload.

The plan job runs the full Worker suite, so it uses the runner CI's `worker` job
is sized for (`blacksmith-4vcpu-ubuntu-2404`). On 2-vCPU `ubuntu-latest`, six
integration tests timed out and neither stage could be planned (runs 41187455102
and 41187494530). `scripts/ci/workflow-policy.mjs` keeps the two runners equal.

Replacing or removing a protected resource has no CI path. That needs a separate
reviewed migration and recovery plan (ADR 0013/0016/0017), never a relaxed gate.
`scripts/ci/workflow-policy.mjs` rejects any workflow that runs `alchemy` other than
`--help`, a `pnpm deploy`/`deploy:worker` script, `wrangler delete` or
`wrangler d1 delete`, or `deploy-gate apply` without an earlier plan and retained
upload. Destroy only personal stages, with `pnpm run destroy --stage <stage>`,
whose guard refuses staging and prod.

Evidence status (2026-10-31): both stages are deployed, and their protected
resources are pinned.

| Stage | Worker | SupportDB | SupportLedger |
| --- | --- | --- | --- |
| staging | `gqsupportworker-worker-staging-fzos3ewkrboeduj2` | `8e8e563c-6633-415a-b435-0a36c0debafe` (`GQSupportWorker-SupportDB-staging-zseqfzenppnbdd7a`) | `d9e31902-5d44-43ed-bdeb-c88b1a6c63af` (`GQSupportWorker-SupportLedger-staging-6ave2x67vemtxlzx`) |
| prod | `gqsupportworker-worker-prod-mrw4r56wpb43gda6` | `c52c2ec5-f954-4d93-9099-82bcd058d34f` (`GQSupportWorker-SupportDB-prod-3smccmmkkz7shujt`) | `4e0aa172-c5f2-4341-8286-c69a6316b6c3` (`GQSupportWorker-SupportLedger-prod-ltiyaa5pdxa73biz`) |

Prod was first deployed by run
[39634753079](https://github.com/Quick-Release/gq-support/actions/runs/39634753079)
(2026-10-21; its databases were created then). It was last deployed by
[39963084422](https://github.com/Quick-Release/gq-support/actions/runs/39963084422)
at `0e6bfc92` (2026-10-23), and staging by
[39962559038](https://github.com/Quick-Release/gq-support/actions/runs/39962559038)
at the same commit. Both runs predate the plan gate and applied Alchemy directly.
The pins come from those runs' stack outputs and agree with a read-only Cloudflare
D1 listing taken 2026-10-31. A prod plan that would create a protected resource is
refused, never treated as a first deployment. Both stages' latest applied
migrations are main `0019` and ledger `0002`: main `0020`–`0031` and ledger
`0003`/`0004` are pending and apply with the next gated deploy.

No credentialed plan has passed the gate yet. The first plan-only runs at
`54564e0` (staging 41187455102, prod 41187494530) stopped in the test step before
planning, and they predate the staging operations variables set on 2026-10-31.
Plan again after this change merges. Production readiness also needs a
credentialed prod plan-only run, its retained `plan.json` with a `safe` verdict
whose identities equal the pins, and the reviewer's sign-off.

## Drill and evidence checklist

Run in staging with synthetic reports and approved credentials before production
onboarding and after changes affecting the relevant recovery path. Evidence must
include the incident ID, opaque actor, timestamps, stage/versions, fault, observed
signal/notification, recovery action, invariant checks, result and human sign-off.

`pnpm recovery-drill [--out <report.json>]` (from `worker/`) runs the synthetic
local rehearsals of the recovery drills (Worker HTTP, scheduled and Operator
entries over local D1 with fake GitHub/Discord and a controlled clock) and prints
an evidence report: each drill's local result, and its staging rehearsal as
`not_run` with the real inputs it needs. A local pass is not staging evidence and
not a sign-off; the report says so (`staging_evidence: false`, `signed_off: false`).
`--stage staging` runs nothing and exits 2: no staging fault injection, Time
Travel restore or live provider change is authorized or configured from it.
`pnpm readiness --drill-report <report.json>` reports that local result
separately and requires each drill below, plus the broken-webhook, Worker/D1,
bad-update, release-window, local fail-safe, Discord and Banquinha drills, as
staging evidence at the same commit ([production readiness](production-readiness.md#gates-and-evidence-catalog)).

| Drill | Required proof |
|---|---|
| GitHub outage and poisoned outbox item | Known-non-creation retries bounded; unrelated Slots progress; unknown outcomes never reposted. Local only: no staging GitHub fault method is agreed |
| Ambiguous create and late GitHub success | 15-minute incident, 24-hour handoff, positive reconciliation and no duplicate create |
| Credential replacement/revocation | Correct stage/Slot only, old key refused, independent update recovery still available |
| Broken staging webhook | 401/5xx reaches incident store and Discord; `drill-verify webhook` passes; configuration restored; status repair evidence complete. Not yet run: staging Discord destinations are not configured |
| Worker/D1 outage | Independent detection works; website requests remain independent; accepted work and incident state reconcile into one `component_unavailable` incident. Not yet run: the [independent checker](#independent-outage-checks) is not set up for any stage |
| Maintenance boundary | Every isolate refuses intake/writes; ticks dispatch nothing; probe shows `maintenance: active`; guarded Operator mutations refused; audit complete. Local only (`pnpm recovery-drill`) |
| D1 restore | Suppressions/revocations survive; erased text not served; stale delivered work never blindly replayed; unsafe resume refused; withdrawn release not current; checker episodes reopened. Local only: no staging restore point, provider restore command or credentialed run is recorded |
| Bad plugin and migration | Whole-fleet result tracked; approved compatible rollback works; unsafe schema rollback refused. Exercised locally only (`worker/test/fleet-rollout.test.ts`, `package.sh native` and `central` on the disposable test site): no gate, launch, central target or native grant exists for any stage, so the staging drill has not run |
| Release window | Previous release accepted until exactly 24 hours after recorded dispatch, then 426 at the service; WordPress closes new reports from its cached policy; accepted retries replay; production `enforced` |
| Discord/Banquinha outage | Incidents survive; CLI works when storage is healthy; notifications recover without duplicate incidents |
| Local fail-safe and Client contact | Disable/re-enable through hosting/admin access; separate-device independent contact verified. Local only: `package.sh native` rehearses disable, re-enable and refused update access on the installed release; `inventory-readiness` blocks every Slot until a real separate-device drill is recorded, and none has been |
| Offboarding | Dispatch suppressed; report and update keys, download grants and enrollment codes revoked ledger first; central applications stopped before install; denial survives restore and refuses re-enrollment/regrant; uncertain work kept, not reported as stopped; content and inventory purged after 30 days without the mapping; other Clients and shared records untouched. Local only (`pnpm recovery-drill`); no Client or staging Slot has been offboarded |
| Retention/privacy failure | Failed cleanup detected, expiry enforced, unresolved erasure remains explicitly incomplete |

Queue replay drills are deferred with Queues. Exercise D1 review/resume safety now;
require separate retention/redrive/suppression gates before adopting Queues later.
