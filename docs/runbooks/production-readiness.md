# Production readiness

The readiness check and evidence catalog for
[#148](https://github.com/Quick-Release/gq-support/issues/148), part of
[#134](https://github.com/Quick-Release/gq-support/issues/134). It applies the
[operations design](../support-operations-design.md#production-readiness-evidence)
and the [operations recovery runbook](support-operations.md), and is the gate
before **any** Client is onboarded to production.

This document and the check do not authorize deployment, a production plan, a
drill, data collection or onboarding. Passing tests and this catalog are not
evidence. The check reads; it never deploys, triggers a workflow, contacts a
Worker, D1, Discord or Client, or writes anywhere but its `--out` file.

## Run the check

From `worker/`, in a clean checkout of the commit to be onboarded:

```sh
pnpm recovery-drill --out drills.json
pnpm readiness --stage prod --evidence evidence.json --drill-report drills.json [--trusted] [--out report.json]
```

| Mode | Reads | Authoritative | Can be `ready` |
|---|---|---|---|
| offline (default) | This checkout's reviewed configuration and the named files | No | Never |
| `--trusted` | The same, plus GitHub's own workflow runs, retained deploy-plan artifacts, issue #29 and the sign-off comment, read-only with the Operator's `gh` login | Yes | Only if every gate passes |

Exit status: `0` ready, `2` not ready, `1` usage or unreadable file. The report
(`gq-support-production-readiness`) lists every gate with its state
(`passed`, `blocked`, or `unverified` when only a trusted read is missing), each
blocker's code and action, the separate synthetic local drill result, the open
review risks, and the evidence digest a sign-off must quote. It never echoes a
secret, contact route or responder. The source is `worker/src/readiness.ts`;
tests are `worker/test/readiness.test.ts` (synthetic fixtures only).

### Evidence authorities

- **repository**: reviewed configuration in this checkout, changed only by PR:
  prod release enforcement (`src/release-policy.ts`), protected-resource pins
  (`deploy/protected-resources.json`), prod Slot mappings
  (`src/repository-mappings.ts`), central targets (`src/central-deployment.ts`),
  credential custody (`src/inventory.ts`) and the sign-off reviewers
  (`SIGN_OFF_REVIEWERS` in `src/readiness.ts`).
- **trusted**: GitHub's records, read in `--trusted` mode. Offline they are
  `unverified`, never passed.
- **captured**: sanitized Operator CLI or provider-console output recorded in the
  evidence file. The check validates shape, pinning to stage/account/commit and
  freshness only; the human sign-off attests to its content. Where a live read
  exists (for example `pnpm operator inventory-readiness`), it is the authority
  and the capture must match it.
- **external**: another repository's evidence (Banquinha), captured the same way.

A local or synthetic result is never live evidence: `environment: "local"` is
refused as `local_evidence_not_live`, and `pnpm recovery-drill` output is reported
only under `local_tests`.

## Evidence file

`evidence.json` has exactly these top-level fields; any other field, including a
typed `ready` or `passed`, is malformed and nothing in it counts.

```json
{ "schema": "gq-support.readiness-evidence/v1", "stage": "prod", "account_id": "<Tipme account ID>",
  "commit": "<the 40-hex commit being onboarded>", "captured_at": "<ISO UTC>", "captured_by": "<opaque Operator actor>",
  "release": {}, "production": {}, "staging": {}, "validation": {}, "access": {}, "notifications": {}, "monitor": {},
  "retention": {}, "thresholds": {}, "slots": [], "drills": {}, "banquinha": {}, "sign_off": {} }
```

Rules for every section: each field has an exact format; every time is ISO UTC
and not in the future; a `reference` is a `https://github.com/Quick-Release/…` or
`https://dash.cloudflare.com/…` URL without a query string, or `sha256:<hex>` of a
restricted record kept at the Operator boundary. Secrets, webhook URLs, email
addresses and contact routes are refused (`secret_like_value`); record restricted
details only through the Operator CLI and cite them by digest. The file is ignored
(`wrong_stage`, `wrong_account`, `wrong_commit`, `checkout_dirty`, `stale`) unless
it is for prod, the Tipme account and the checked-out clean commit, captured
within 14 days.

## Gates and evidence catalog

| Gate | Authority | Evidence section and how to collect it | Freshness |
|---|---|---|---|
| `release_provenance` | captured, trusted | `release`: `release_run`, `release_commit`, `ci_run`, `staging_run` (the runs `release-verify` used), `package_version`, `package_sha256`, `signing` (`signed` only), `approved_release_id` from `pnpm operator release-status`. Trusted mode re-checks every release gate at those exact commits, with this checkout as the Worker commit. | 30 days |
| `release_enforcement` | repository | prod `enforced` in `stageReleaseEnforcement`, set by reviewed PR after the approved release is dispatched | — |
| `production_deployment` | repository, trusted, captured | prod pins for `SupportDB`, `SupportLedger`, `Worker`; `production`: `deploy_run` of **Deploy Support Worker** (prod, deploy) at this commit, and `migrations` (every checkout migration of both databases with `applied_at`, from `wrangler d1 migrations list`). Trusted mode verifies the safe retained plan and apply record, that the plan's protected identities equal the pins, that it is prod's latest successful deploy, and that ledger `0003`/`0004` and main `0031` were applied before that deploy. | 30 days, and latest |
| `staging_deployment` | trusted, captured | `staging`: the same for staging, plus `fleet` from `pnpm operator fleet-status` for the approved release (`converged`, `verified` > 0, `not_verified` 0). The release `staging` gate proves only a Worker deployment, so staging fleet convergence is checked here. | 30 days, and latest |
| `ci_validation` | trusted | `validation.ci_run`: a CI push run on `main` at this commit whose Worker suite, required validation, secret scan, PHP standards and size gate passed. Targeted or local suites do not count. | 30 days |
| `lifecycle_gate` | trusted | none: issue [#29](https://github.com/Quick-Release/gq-support/issues/29) must be closed as completed. It is linked, not duplicated or changed. | current |
| `access_audit` | captured | `access` (prod): counts of rostered staff (`SUPPORT_OPERATIONS_STAFF`), dashboard keys (`SUPPORT_OPERATIONS_API_KEYS`) and Operator credential holders, `operator_separate_from_staff`, and an audited incident claim ID | 30 days |
| `notifications` | captured | `notifications` (prod): both destinations configured, from `pnpm operator notifications`; durability is drilled under `recovery_drills` | 30 days |
| `independent_monitor` | trusted | `monitor.run`: a scheduled **Independent service check** run on `main` whose `Check prod` job passed. The newest scheduled run must have succeeded within 2 hours. GitHub Actions shares GitHub's failure domain and its state artifact lasts 7 days: record that limitation in the sign-off. | 1 day |
| `retention_logs` | captured | `retention` (prod): the actually configured Workers Logs retention in days and `logs_access: restricted`, with the Cloudflare dashboard reference. Never an assumed duration. | 90 days |
| `thresholds` | captured | `thresholds`: a measurement window of at least 7 days and a threshold with its basis for each of `ledger_mirror_lag`, `delivery_delay`, `oldest_pending`, `status_freshness`, `auth_rejection_rate`, `intake_failure_rate`, `scheduler_lag` (from `pnpm operator health`). Until `ledger_mirror_lag` is measured the 15-minute ledger alert stays provisional. No human-response SLA is implied. | window end 30 days |
| `custody` | repository | every prod credential in `stageInventories.prod` has a reviewed owner, a known expiry (or `never`) more than 30 days away, and recorded rotation or creation evidence | — |
| `slots` | repository, captured | at least one prod mapping; each with its App installation, responsible team and `central` (reviewed `plugin-directory` target; Composer is refused until a lock adapter is reviewed) or `native` deployment; `slots[]`: per Slot `contact_method: separate-device-drill`, `contact_verified_at`, `contact_evidence` (digest of the restricted record from `pnpm operator inventory-contact`) and `update_access` (`granted` for native) | contact 90 days |
| `recovery_drills` | captured | `--drill-report` from `pnpm recovery-drill` at this clean commit with `local_passed: true`, plus `drills.<id>` for every drill below, rehearsed on **staging** at this commit: `observed_at`, `environment`, `commit`, `operator`, `incident`, `result`, `reference` | 90 days |
| `banquinha_consumer` | external | `banquinha`: Banquinha commit, its CI reference, a signed-in browser E2E reference and a live staging smoke against this service | 30 days |
| `sign_off` | repository, trusted | see below | 14 days, after all evidence |

Required staging drills: the ten in `pnpm recovery-drill` (`maintenance_boundary`,
`provider_outage`, `credential_revocation`, `unknown_late_create`,
`d1_restore_suppression_replay`, `poisoned_outbox`, `privacy_exposure`,
`independent_outage_evidence`, `offboarding`, `independent_contact`) and
`broken_webhook` (`pnpm operator drill-verify webhook` passed), `worker_d1_outage`,
`bad_plugin_update` (rollback to the approved compatible package),
`release_window` (24-hour window, then `426`), `local_failsafe`
(disable/re-enable outside WordPress), `discord_outage` and `banquinha_outage`
(incidents survive, CLI fallback works, notifications recover without
duplicates). Each drill's required proof is in the
[drill checklist](support-operations.md#drill-and-evidence-checklist).

## Human sign-off

A sign-off is a human's own statement that they reviewed this exact evidence.
It is never a typed field, a plan digest or an agent's record.

1. Name the reviewers by reviewed PR in `SIGN_OFF_REVIEWERS` (GitHub logins).
   None is named today, so no sign-off can count.
2. Run the check in `--trusted` mode with the complete evidence and no
   `sign_off`; review every gate and the report's `evidence_digest`.
3. The reviewer comments, from their own GitHub account and not through an App,
   on a `Quick-Release/gq-support` issue, quoting the digest. Agents must not
   write, post or record this comment or the `sign_off` section for a human.
4. Add `sign_off`: `reviewer` (their login), `signed_at` (the comment's creation
   time), `comment` (its numeric ID) and `evidence_digest`. Trusted mode checks the
   comment exists in this repository, its author is that reviewer and a `User`,
   it quotes the digest, its time matches, and it follows all evidence. Any later
   change to the evidence changes the digest and voids the sign-off.

## Review risks held open

The report lists these until the guarding gate passes:

- The release `staging` gate proves a staging Worker deployment, not staging fleet
  convergence (`staging_deployment`).
- A gated deployment run alone does not prove it is the stage's latest deployment
  (`production_deployment`, `not_latest_deployment`).
- The prod `reviewed_plan_digest` names no reviewer (`sign_off`).
- Unsigned-legacy packages cannot be told apart by version (`legacy_unsigned_package`).
- The 15-minute ledger-mirror alert is unmeasured (`threshold_unmeasured:ledger_mirror_lag`).
- No actual Workers Logs retention or access is recorded (`retention_missing`).
- No reviewed central target or Composer lock adapter exists (`central_target_missing`).
- The full Worker suite has an unresolved parallel-load timeout; only a passing CI
  run at the commit counts (`ci_validation`).

The plan digest covers protected-resource identities and planned actions, not
every configuration value or secret; the checker independently trusts a scheduled
GitHub Actions runner; captured sections are attested, not independently read.

## Current state

Recorded 2026-10-31 on branch `feat/support-operations-134` (base `2840fb1`), by
running `pnpm readiness --stage prod --drill-report drills.json` with no evidence
file, plus `--trusted` for the read-only GitHub reads: **not ready**. No evidence
file exists because none of its evidence exists yet:

- Prod release enforcement is `staged`; no release candidate is approved,
  dispatched or launched for any stage.
- Prod and staging protected resources are pinned (deployed since 2026-10-21 and
  2026-10-17, last at `0e6bfc92`; see the
  [plan gate](support-operations.md#deployment-plan-gate)). No credentialed plan
  has passed the gate and no gated deployment exists for either stage. Main
  migrations `0020`–`0031` and ledger `0003`/`0004` are pending on both.
- No prod Slot mapping, central target or native grant; no Client contact verified.
- Every prod credential lacks a reviewed owner; most lack expiry and rotation evidence.
- No Discord destination, staff roster, dashboard key, independent checker
  schedule, Workers Logs retention record or measured threshold for prod.
- Only the ten synthetic local drills have run (`staging_evidence: false`,
  `signed_off: false`); no staging drill has.
- Banquinha's consumer is implemented in its own repository (tested there) but has
  no live key, roster, configuration, smoke or signed-in browser E2E.
- #29 is open, and no sign-off reviewer is named.
