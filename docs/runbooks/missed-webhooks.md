# Missed GitHub webhooks

Runbook for [#57](https://github.com/Quick-Release/gq-support/issues/57), part
of [#50](https://github.com/Quick-Release/gq-support/issues/50). Design:
[research note](../research/github-webhook-sync.md#missed-deliveries-redelivery-and-reconciliation).

Webhooks only make Support status fresher. The sweep is the source of
correctness: every 15 minutes it lists each Project repository's App-created
issues changed since its last sweep and verifies the repository first. So a
missed delivery delays a status change to the sweep bound of about 17 minutes.
It does not lose the change. You need this runbook when deliveries keep
failing, or when the sweep itself fell behind.

Throughout: never print, copy or paste the webhook secret. Never paste delivery
payloads, issue text or Reporter content into tickets or the audit. Redelivering
specific deliveries in GitHub's UI is optional and for debugging only. Every
handler is idempotent, but status repair does not depend on redelivery.

Operator commands run from `worker/` with your own Cloudflare credentials, as in
the [Worker README](../../worker/README.md#operator-commands). Add
`--stage <staging|prod> --account-id <account-id> --database-id <database-id>` for the intended stage
to every `pnpm operator` command below. Use an opaque actor ID, not an email
address.

## 1. Detect

Each of these is a structured Worker log event (Workers Logs). Alert routing
belongs to [#20](https://github.com/Quick-Release/gq-support/issues/20); until
it lands, query the logs directly.

These are not yet alerts: nothing pages an Operator until #20 routes them.

| Signal | Event | Likely cause |
|---|---|---|
| Webhook `401` | `GitHub webhook rejected` with `reason: signature`, counter `github_webhook_rejections_total` | Secret mismatch, often right after a rotation |
| Webhook `401`, other reason | Same event with `reason: target`, `headers`, `content_type` or `configuration` | Another stage's App pointed here, wrong content type, missing Worker binding |
| Webhook `5xx` | Worker `503`s on `POST /v1/github/webhooks`, `Support webhook status refresh failed` | D1 unavailable; GitHub records the failures and the sweep repairs them |
| Refresh backlog | `Support status refresh is behind` (`support.status.refresh.oldest_due_age_ms` over one hour) | Refreshes failing, or GitHub rate limits |
| Sweep lag | `Support status sweep is behind` (`support.status.sweep.lag_ms` over one hour) | Sweeps failing for a repository, or Cron not running |
| No deliveries | GitHub App **Advanced** tab shows failed or no recent deliveries; receiver logs nothing | Wrong URL, App webhook inactive, TLS problem |

A wrong URL produces no receiver log at all. It shows only in GitHub's delivery
log and, indirectly, as status updates arriving at sweep pace.

## 2. Check the webhook configuration

For staging, run from the repo root:

```sh
python3 scripts/github-webhook-staging.py config --state <progress-file>
```

It prints only `url` (or `unexpected`), `contentType`, `tlsVerified` and
`secretConfigured`. GitHub returns the secret masked, and the runner reports
only whether one is set. For production, open the production App's **General**
settings and check that **Active** is on, the webhook URL is the production
Worker plus `/v1/github/webhooks`, and SSL verification is enabled. Do not
reveal or edit the secret field there, and do not log it anywhere.

Expected: the stage's Worker URL, `json`, TLS verified, a secret set and
**Active** on.

## 3. Fix

- **Wrong URL, content type or TLS setting:** for staging, run
  `python3 scripts/github-webhook-staging.py restore --state <progress-file>`. It
  reapplies the configuration from CI, checks it again and probes the receiver.
  For production, correct the field in the App settings.
- **`401` with `reason: signature`:** the App's secret and the Worker's
  binding disagree. Follow the rotation steps in the
  [webhook runbook](github-webhooks.md#rotation). Never copy a secret out of
  GitHub or the Worker to compare them.
- **`401` with `reason: target`:** another stage's App points at this Worker.
  Fix that App's URL. Never accept its deliveries here.
- **`5xx`:** restore D1 or Worker health first. GitHub keeps the failed
  deliveries in its log, but the sweep repairs status without them.
- **Inactive:** enable **Active** in the App's General settings.

Note the time the outage started (from the first failed delivery or alert) and
the time it was fixed. These form the audit window.

## 4. Repair

Append the intended `--stage`, Tipme `--account-id`, `--database-id` and independent
`--ledger-database-id` to every Operator command below (see the Worker README).
The CLI now admits ordinary commands through the independent ledger; they are
blocked during [restore containment](restore-containment.md). Complete exclusive
replay and explicit release before scheduling ordinary status repair.

If the sweep kept running during the outage (no `Support status sweep is
behind` alerts, and `status-health` shows each repository's `lastSweptAt`
advancing), do nothing: the next sweeps repair every status. Wait one sweep
interval (15 minutes) after the fix.

Otherwise, after a long outage, a restore, or sweep lag alerts, run the full
reconciliation from the outage start:

```sh
pnpm operator status-reconcile 2026-10-18T09:40:00Z operator-7
```

This writes a write-ahead audit entry, then makes each mapped or tracked
repository's next sweep list from the outage start minus the usual
five-minute skew. The sweep verifies each repository first, so it also
suspends any repository that became public, archived or unreachable. A
sweep already in progress from an earlier point keeps that point. The command
never calls GitHub itself. The minute Cron does the work within the sweep's
normal per-tick budget, so a large fleet can take several ticks. Deleted or
transferred issues do not appear in listings, so the command also restarts the
open-request pass at once instead of at its daily time. That pass queues every
open, tracked request for a conditional re-read, which closes a deleted or
transferred one and alerts. The re-reads use the refresh's per-tick budget.
A request already shown as closed is not re-read: if its issue was reopened
and then deleted during the outage, it correctly stays closed, but raises no
tracking-lost alert.

## 5. Confirm

```sh
pnpm operator status-health
```

It prints counts and times only. Recovery is confirmed when:

- `dueRefreshes` is `0`: the due backlog is drained.
- Every entry in `repositories` that is not `suspended` has
  `withinInterval: true`: its last completed sweep is within one interval
  (15 minutes, plus two for the Cron minute and fetch) and none is still in
  progress. A suspended repository's status is frozen, and while it stays
  unsafe its sweep cannot complete. The suspension list accounts for it.
- `openRequestPass.inProgress` is `false`: every open request has been
  queued for a re-read, and with `dueRefreshes` at `0`, re-read.
- Every entry in `suspensions` is one you have handled.

`healthy` is `true` only when, in addition, every suspension is
`acknowledged`. A new suspension stays unacknowledged until the repair record
in step 6 names it. So before recording, handle each one: contact the Client,
and lift it with `pnpm operator unsuspend` only after a later passing sweep,
as described in the
[Worker README](../../worker/README.md#suspended-mappings). If the backlog or
an unsuspended repository's sweep does not recover within a few intervals, go
back to step 1. The sweep or refresh path itself is failing.

## 6. Record

```sh
pnpm operator status-repair 2026-10-18T09:40:00Z 2026-10-18T10:25:00Z operator-7
```

The window is the outage start and the fix time. The command refuses until the
backlog is drained, the open-request pass is complete and every unsuspended
repository is within one interval. It then stores
an audit row in `status_audit` with the actor, the time, the window, the
repository count, the due count and the IDs of the repositories suspended at
that time. Recording those IDs is the Operator's acknowledgement of those
suspensions. The row holds no payload, delivery ID, issue text or Reporter
content.

## Staging drill

The [research note](../research/github-webhook-sync.md#staging-verification-57)
describes the staging rehearsal of this runbook with a broken webhook, and the
measured freshness.
