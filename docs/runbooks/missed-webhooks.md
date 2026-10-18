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
`--account-id <account-id> --database-id <database-id>` for the intended stage
to every `pnpm operator` command below. Use an opaque actor ID, not an email
address.

## 1. Detect

Each of these is a structured Worker log event (Workers Logs). Alert routing
belongs to [#20](https://github.com/Quick-Release/gq-support/issues/20); until
it lands, query the logs directly.

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
transferred issues do not appear in listings; the daily open-request pass
closes them within 24 hours.

## 5. Confirm

```sh
pnpm operator status-health
```

It prints counts and times only. Recovery is confirmed when `healthy` is
`true`:

- `dueRefreshes` is `0`: the due backlog is drained.
- Every entry in `repositories` has `withinInterval: true`: its last completed
  sweep is within one interval (15 minutes, plus two for the Cron minute and
  fetch) and none is still in progress.
- Every entry in `suspensions` has `acknowledged: true`.

A new suspension is unacknowledged until a repair record (step 6) names it.
Before recording, handle each one: contact the Client, and lift it with
`pnpm operator unsuspend` only after a later passing sweep, as described in the
[Worker README](../../worker/README.md#suspended-mappings). If `healthy` stays
`false` for several intervals, go back to step 1. The sweep or refresh path
itself is failing.

## 6. Record

```sh
pnpm operator status-repair 2026-10-18T09:40:00Z 2026-10-18T10:25:00Z operator-7
```

The window is the outage start and the fix time. The command refuses until the
backlog is drained and every repository is within one interval. It then stores
an audit row in `status_audit` with the actor, the time, the window, the
repository count, the due count and the IDs of the repositories suspended at
that time. Recording those IDs is the Operator's acknowledgement of those
suspensions. The row holds no payload, delivery ID, issue text or Reporter
content.

## Staging drill

The [research note](../research/github-webhook-sync.md#staging-verification-57)
describes the staging rehearsal of this runbook with a broken webhook, and the
measured freshness.
