# Support lifecycle verification

Issue #29 verifies the current lifecycle, including the shipped close/reopen
controls from #28 and ADR 0020. The implementation scope was confirmed on
2026-10-26; the original ticket's assertion that those controls are absent is
superseded. GitHub comments remain internal. Support status and mutation delivery
outcomes remain separate.

## Reproduce locally

Use this repository's disposable DDEV installation, not a Client installation or
the neighbouring shared playground. Docker, DDEV, Node and pnpm are required.
The controlled adapters need no GitHub or Cloudflare credentials and create no
real issues. The PHP fixture supplies GETQUICK Design for this test installation;
it does not verify the real Design integration (CI has a separate pinned cell).

From a fresh checkout with no `.test-site`, run:

```sh
pnpm install --frozen-lockfile
pnpm build:app
pnpm exec playwright install chromium
bash plugin/tests/integration/run.sh
bash scripts/pre-push-browser.sh plugin/tests/browser/requests.spec.ts plugin/tests/browser/status-change.spec.ts plugin/tests/browser/launcher.spec.ts plugin/tests/browser/submission.spec.ts plugin/tests/browser/recovery.spec.ts plugin/tests/browser/session.spec.ts plugin/tests/browser/fail-safe.spec.ts plugin/tests/browser/report-context.spec.ts plugin/tests/browser/performance.spec.ts
pnpm --filter gq-support-worker typecheck
pnpm --filter gq-support-worker test
```

`run.sh` creates and configures the disposable WordPress installation and runs
real REST authorization, shared PHP contract, privacy and local fail-safe tests.
It changes test users, capabilities, connection state and plugin activation.
The browser wrapper serializes access to the shared test installation, rebuilds
assets, and selects the named specs. Do not run a second WordPress test process
against that installation while it owns the lock.

The browser suite runs the real WordPress launcher, session checks and React app,
with controlled REST responses. The Worker suite runs independently through signed
installation HTTP requests, migrated workerd-backed D1, and the controlled GitHub
HTTP adapter. These are complementary seams, not a browser connected to a live
GitHub repository. The new integrated checks are:

- `requests.spec.ts`: submit plain text, receive pending acceptance, read the same
  Submitted text, explicitly refresh delivery, close, and reopen. A pending
  mutation does not prematurely change Support status.
- `worker/test/lifecycle.test.ts`: duplicate HTTP submission, one provider issue
  despite an ambiguous create response and repeated wake-ups, reconciliation,
  readable projection, correlated logs/spans, status receipt semantics, and denial
  of provider credentials as installation authority.

For a CI-equivalent runtime cell on a fresh installation, use
`scripts/ci/run-cell.sh minimum` or `scripts/ci/run-cell.sh stable`. The runtime
matrix pins the WordPress/PHP/database versions; use its documented environment
overrides when creating the site. An existing installation cannot establish a
different WordPress/database matrix cell merely by rerunning a command. See the
[CI and runtime documentation](../README.md#continuous-integration).

## Behavioral gates

| Requirement | Executable evidence |
| --- | --- |
| Submission, pending receipt, Submitted text, manual refresh and current open/closed status | `plugin/tests/browser/requests.spec.ts`, `status-change.spec.ts`; `worker/test/lifecycle.test.ts`, `status-changes.test.ts`, `status-refresh.test.ts` |
| Comments stay internal and unrelated engineering issues stay out of the projection | `worker/test/support-requests.test.ts` (no comment routes), `status-refresh.test.ts` (internal edits/comments stay out), `status-sweep.test.ts`; `plugin/tests/browser/requests.spec.ts` (no comment composer) |
| No launcher/assets for anonymous, unauthorized or unsupported contexts | `plugin/tests/browser/launcher.spec.ts`, `performance.spec.ts`; `plugin/tests/integration/run.sh` |
| Accessible names, focus restoration, keyboard tabs, status announcements, responsive positioning and reduced motion | `plugin/tests/browser/launcher.spec.ts`, `requests.spec.ts`, `status-change.spec.ts` |
| Duplicate creates, repeated wake-ups, transient/rate/permission/configuration failures and unknown reconciliation | `worker/test/lifecycle.test.ts`, `support-requests.test.ts`, `delivery.test.ts`, `support-issues.test.ts`, `github-gateway.test.ts` |
| Timeout after provider side effect, late response cancellation and positive reconciliation without another create | `worker/test/support-issues.test.ts` (timed-out response arrives late) |
| Per-request mutation order, concurrent actions, uncertain PATCH read-back, later GitHub changes winning | `worker/test/status-changes.test.ts`; `plugin/tests/browser/status-change.spec.ts` |
| Own Reporter access, explicit Support manager grant, denied other Slot/Client, provider credentials confer no scope | `plugin/tests/integration/access.php`, `plugin/tests/contract/SupportContractTest.php`; `worker/test/support-requests.test.ts`, `status-changes.test.ts`, `lifecycle.test.ts` |
| Memory-only drafts and loss disclosure, copy fallback, frozen payload/replacement, single-flight, same-key checks and rejected uncertain checks | `plugin/tests/browser/recovery.spec.ts`, `submission.spec.ts`, `performance.spec.ts` |
| Valid pending/unknown receipts end intake checks; malformed delivered receipts cannot claim delivery; manual Retry-After | `plugin/tests/browser/recovery.spec.ts` |
| Same-session nonce expiry, changed sessions, closed-panel BFCache and bounded late asset loading | `plugin/tests/browser/recovery.spec.ts`, `session.spec.ts`, `launcher.spec.ts` |
| Independent contact, local disable, no support outbound calls, ordinary page availability | `plugin/tests/browser/fail-safe.spec.ts`, `recovery.spec.ts`; `plugin/tests/integration/fail-safe.php`, `connection.php` |

CI discovers the browser specs through `playwright.config.ts` and all Worker
`test/**/*.test.ts` files through Vitest. `.github/workflows/ci.yml` already joins
Worker typecheck/tests, PHPCS, PHPStan, app build and the reusable WordPress
lanes (REST/contract integration, browser acceptance and Plugin Check) into
`Required validation`. No second, optional workflow is needed for these tests.

## Correlate without report content

Successful create/status HTTP receipts emit `support.receipt` with `request`
(the service-issued `req_…` resource identity), `operation` and `delivery`. A
same-key replay emits another receipt for the same resource; it is not evidence
of another acceptance or provider write. A status receipt reports the status
intent's delivery separately from its already-delivered create.

Delivery outcome logs carry `request`, `intent` (`int_…`), `generation`, `outcome`
and `alert`, plus `attempt` (the service-generated claim owner) after a claim.
Expiry before dispatch has no attempt. `support.delivery` spans carry the same
request/intent and, once claimed, generation/attempt. `support.receipt` spans
carry the receipt fields. Provider failure logs inherit request/intent context.
Join separate intake and background traces by resource ID, then follow each
intent and generation; these are separate invocations, not one continuous trace.

Do not search or annotate using a browser Submission/Change ID, Reporter subject,
authentication Request ID/nonce, WordPress cookie, credential, URL, Summary or
Description. The lifecycle test captures logs and span attributes and rejects
report text, subject, submission key, credentials and cookies. A receipt proves
durable acceptance only; delivery requires a confirmed resource outcome.

## Operational handoff

Passing these deterministic gates does not close the operational prerequisite
[issue #20](https://github.com/Quick-Release/gq-support/issues/20). Before production
onboarding, its owner must record the verified independent Client contact and
responder, the out-of-WordPress handoff and separate-device outage drill, alert
routing/deduplication, telemetry access/retention and rollout/rollback sign-off.
Never substitute a fixture contact or invented service objective for that evidence.

The local fail-safe drill uses `GQ_SUPPORT_DISABLED` and the bounded
`GQ_SUPPORT_HELP_URL`/`GQ_SUPPORT_HELP_LABEL` configuration documented in the
[outage decision](research/outage-draft-recovery.md). Verify ordinary
navigation and zero support service calls while disabled, then remove the local
disable flag and verify explicit support use again. Disabling or deactivating the
plugin does not cancel accepted work, revoke credentials or offboard a Client.
D1 recovery/reconciliation is the current backlog seam; Queues/DLQ and a local
WordPress outbox are not prerequisites for this drill.
