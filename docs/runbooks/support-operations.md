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
baseline or tuned threshold yet.

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

- Use independently executed checks and available provider observations. Neither
  a dead Worker nor a failed D1 can reliably persist its own incident.
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
counted only once D1 is back; the independent checker (#139) must cover the outage.

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

1. Halt deployment and dispatch; establish a maintenance boundary that blocks
   intake/writes and scheduled execution before restore. Record in-flight work
   and account for late provider success. A dispatch flag alone is not a complete
   traffic/write barrier.
2. Verify stage/resource IDs, approved restore point and a usable independent
   suppression ledger/revocation log. Never restore `SupportLedger` together with
   `SupportDB`. Preserve the external restore epoch required by ADR 0016.
3. Perform the authorized restore using current provider operations. Before
   resuming traffic, run the existing `restore-recorded` workflow from the Worker
   README and replay suppressions, erasures, suspensions and revocations. Strip
   restored erased text before it can be served or dispatched. A missing or
   failing ledger blocks service resumption.
4. Every restored non-delivered request becomes outcome-unknown, even if the
   restored row says pending/failed. Reconcile positive GitHub evidence; never
   blindly replay the old outbox or infer absence from a search.
5. Verify suppression replay, drained execution/late success handling, privacy
   cleanup and read-only status reconciliation with audited evidence. Resume
   authorized intake/dispatch only after all checks pass.

Provider restore commands and the exact maintenance barrier must be implemented
and rehearsed before this procedure is considered executable production recovery.

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
  package automatically only when compatible with live data/API.
- Mark the recovery package approved so automatic updates cannot loop back to the
  withdrawn version. Do not reverse migrations or restore the shared database as
  an automatic plugin rollback. Use forward repair or the separate restore path.
- For a broken local UI use `GQ_SUPPORT_DISABLED` or deactivate the plugin through
  existing admin/hosting access, per [outage recovery](../research/outage-draft-recovery.md)
  and #67. Implementation must be verified before relying on that constant.
- Disable new submissions on incompatibility or expiry of the previous-release
  window, preserving update/recovery access and accepted service-owned work.
  An unreachable site is unknown; enforce intake compatibility service-side too.
- Re-enable after verifying package/assets, installation identity, compatibility
  and privacy/security checks. Recover uncertain receipts/reports before any
  manual replacement. Lost browser memory is not evidence of failed acceptance.

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
3. Verify each Client's independent contact from a separate device, then record
   it with `inventory-contact`; keep the route out of Discord, issues and metrics.
4. After rotating a credential, update its `rotated` date and evidence (and
   `expires`) in `worker/src/inventory.ts` by reviewed PR. Assign owners there.

## Offboarding

Use the [operations inventory/offboarding checklist](../support-operations-design.md#inventory-custody-and-offboarding)
and existing Operator revoke/offboard workflows. Verify dispatch suppression,
credential/update access revocation, stopped central deployments, privacy purge
scheduling and preservation of uncertain remote-outcome review state. Never
destroy shared stage resources to remove a Client. Local disable/uninstall is not
offboarding and must not silently delete accepted work.

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

## Drill and evidence checklist

Run in staging with synthetic reports and approved credentials before production
onboarding and after changes affecting the relevant recovery path. Evidence must
include the incident ID, opaque actor, timestamps, stage/versions, fault, observed
signal/notification, recovery action, invariant checks, result and human sign-off.

| Drill | Required proof |
|---|---|
| GitHub outage and poisoned outbox item | Known-non-creation retries bounded; unrelated Slots progress; unknown outcomes never reposted |
| Ambiguous create and late GitHub success | 15-minute incident, 24-hour handoff, positive reconciliation and no duplicate create |
| Credential replacement/revocation | Correct stage/Slot only, old key refused, independent update recovery still available |
| Broken staging webhook | 401/5xx reaches incident store and Discord; `drill-verify webhook` passes; configuration restored; status repair evidence complete. Not yet run: staging Discord destinations are not configured |
| Worker/D1 outage | Independent detection works; website requests remain independent; accepted work and incident state reconcile |
| D1 restore | Suppressions/revocations survive; erased text not served; stale delivered work never blindly replayed; unsafe resume refused |
| Bad plugin and migration | Whole-fleet result tracked; approved compatible rollback works; unsafe schema rollback refused |
| Discord/Banquinha outage | Incidents survive; CLI works when storage is healthy; notifications recover without duplicate incidents |
| Local fail-safe and Client contact | Disable/re-enable through hosting/admin access; separate-device independent contact verified |
| Retention/privacy failure | Failed cleanup detected, expiry enforced, unresolved erasure remains explicitly incomplete |

Queue replay drills are deferred with Queues. Exercise D1 review/resume safety now;
require separate retention/redrive/suppression gates before adopting Queues later.
