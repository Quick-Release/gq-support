# MVP integration candidate — 2026-10-27

Draft aggregation of unmerged work, targeting `origin/main`, not deployment or
candidate approval. No source PR is superseded or closed. #20 and #29 stay open.

## Inputs and ancestry

Fetched main: `6e2a792fe74f95a1be3e367bab97909443039ea2` (also the stack base).
Merge commits preserve the pinned source histories on `t3/mvp-integration-candidate`.

| Input | Pinned head | Included history |
|---|---|---|
| #117, `t3/additive-d1-migrations` | `15cbabb57aa5cc88cb6835d44e801b5b2f464992` | Entire #109/#111–#117 deployment stack |
| #110, `t3/discord-alert-delivery` | `4f2f43505376664da86b97593f2f971be0dbe0b1` | #108 `e6bb85217c96827bb51ec1759d771730649152bf`, `t3/restore-containment-fencing`, is an ancestor |
| #107, `t3/issue-20-readiness-evidence` | `be6d0b1476af0d6d4f02c0223f02d89fb75416bb` | Approved MVP upgrade/authority/Discord decisions |
| #104, `t3/compatibility-failures` | `f88543d94328f10b4d251c56c25652884287b33d` | Responsive footer fix and regression |
| #106, `t3/php85-cli-harness` | `e4fbccc59e81f1cc7da65638aa8272129163e687` | #105 CPU limit `95dfd51eb5365922faf29b8cbae3f4cffa6b2c02` is an ancestor |

Each history enters once; source branches/heads were not rewritten. No merge to
main, environment settings, state/credential/profile reads, Cloudflare operations,
live notification, restore drill, or hosted CI polling/watch was performed.

## Resolved seams and limits

- Workflow conflict: keep #117's sole protected planning entry. Do not reintroduce
  `alchemy deploy`, environment-injected Discord secrets, or ambient state auth.
- Stack conflict: keep the shared declaration and protected deployment guard;
  restore Discord config validation in the ordinary deployment preflight.
- Provider conflict: the ordinary App provider still executes key → webhook →
  Discord custody → deployed-key check. The follow-up makes Discord a required
  explicit operation in injected protected custody as well. Failed Discord
  custody cannot report success.
- Restore admission/runtime containment, fresh independent ledger/provider checks,
  epoch matching, and uncertain notification isolation are retained unchanged.
- Latest #117's `exclusiveLocalWindow.runApply` still encloses the complete
  continuation. Any failed continuation retains its local marker, even before
  dispatch; only verified success releases it. No expiry, new window ID or
  force-clear releases unresolved ownership. External exclusion must survive
  runner loss through incident reconciliation.

### Protected Discord custody follow-up

The focused follow-up stacked on PR118 `a15e32c3e86752716bbaa656d21ec1b7b7263ddc`
implements Discord custody inside the existing GitHubAppSecret apply owner. The
four resources remain SupportDB, SupportLedger, Worker and GitHubAppSecret.
`AppSecretCustody.provisionDiscord` is required after webhook provisioning and
before the deployed App check. Ordinary and protected providers both call it;
a missing operation fails custody rather than silently completing.

The child can request only `app-discord` with the reviewed Worker name. It cannot
supply a URL, secret name/value, mode, revision, settings patch or generic secret
HTTP request. Trusted custody snapshots the private configuration and consumes a
fixed sequence before each authentication await. Every nested HTTP dispatch has
an asynchronous authorization check followed by the final synchronous abort,
expiry and owner-window guard. Any failure poisons the App/broker continuation;
there is no replay, force-clear or compensation path.

Reviewed source chooses the boolean mode. The release is the authenticated
candidate head. A fresh random session commitment identifies the private
configuration held in the trusted closure; it is not an unsalted URL/token hash.
All three public values enter the final candidate digest and published evidence.
Enabled delivery reserves `/dev/shm/gq-protected/discord-alert-webhook-url`, using
`DISCORD_ALERT_WEBHOOK_URL_FILE` and the existing one-shot private-file checks.
The parent supplies that file only during separately authorized live work.
Disabled mode refuses a URL delivery file. Ambient Discord values are refused.
No credential or profile was requested or read for this implementation.

Every Worker upload is checked for explicit Logs-on/traces-off metadata, before
an old retained credential can be fetched. Custody disables alerts first, verifies
Logs-on/traces-off, installs the strict production Discord URL and candidate head,
enables last, and verifies secret binding names/types and observability. Disabled
custody disables alerts, removes URL/release, verifies absence, preserves Logs
and other supported observability settings while restoring traces, then verifies
again. No successful candidate can retain the temporary disabled-trace exception.
The API cannot reveal secret_text values: proof combines exact acknowledged
writes with binding-name/type and settings readback, not a Discord request.

The unconditional integration gate is replaced by checked reviewed-mode,
head/private-session binding, upload, operation-order and final-custody
prerequisites. Native retained happy paths run all four stage/mode combinations
through the real shared graph, installed Worker/provider, trusted App/Discord
custody, broker and verified State/output completion, using synthetic private
configuration and fake first-party HTTP. Only the remote App RPC process is
synthetic; these fixtures do **not** establish live Cloudflare settings, remote
RPC or permission behavior. The default production entry remains blocked by the
unset reviewed live endpoint/configuration manifests. No bypass was added.

Follow-up validation: **1,233 Worker tests / 48 files passed** on Node 26.12.1
with `--maxWorkers=1` (686.57 seconds); Worker typecheck/lint, root/app JS lint,
three lint controls, 114 CI-script tests, workflow/runtime policies and
Worker/docs and candidate-history (200 commits) secret scans passed. Detailed RED/final evidence is recorded in the
appended bounded-custody section of
`protected-native-planner-implementation.md`. The earlier evidence below belongs
to PR118 and is not new evidence for this follow-up. Hosted checks/reviews remain
uninspected; no CI polling/watch was used. The first push unexpectedly triggered
the optional shared-DDEV browser hook (7 passed, eighth interrupted, 112 not run).
Its cleanup restored the plugin link/reloaded PHP; browser fixture state may have
changed. This is not browser readiness evidence. The publication-hook incident
is recorded in the implementation report; the retry skips that optional hook.

### Graph, runtime and migration audit

The runtime uses Alchemy's WorkerEnvironment for Discord's optional secret values;
no duplicated ambient Env was added. Worker outputs remain the same six public
keys accepted by the broker. D1 bindings and whole-resource migration dependencies
remain intact. Worker upload keeps traces off during credential transitions;
the ordinary disabled custody helper preserves Logs settings, removes URL/release,
verifies absence **before** restoring traces, and verifies the result. Enabled
custody refuses active/unknown traces. Protected entry now requires verified
custody completion in both modes; the temporary upload exception cannot become a
successful disabled candidate.

Actual ledger migrations 0003/0004 match the #117 pinned fixtures byte-for-byte.
The previous fixture inferred all checkout migrations were committed; after
integration that made additive grants undefined (79 failing policy assertions).
Tests now explicitly select synthetic history through ledger 0002 for the
0003/0004 transition, or the full current ledger for main-only updates. Native
SQLite cases preserve original rows, IDs, checksums and one-shot uncertainty
controls; they do not establish applicability to any deployed database.

Pending ledger 0002 copies rows, drops a table and renames another. The additive
profile **must refuse it**. Its committed checksum remains unchanged when already
applied. Actual database history is unknown; no remote migration applicability is
claimed. Unsupported destructive SQL, history conversion, imports/clones,
replacement/adoption, identity/replication changes and arbitrary actions remain
intentionally unsupported non-MVP paths, not features to unblock here.

## PR118 validation (inherited by the custody follow-up)

All Node checks used Node 26.12.1. Every Worker/native run used `--maxWorkers=1`.

- Frozen pnpm install; Worker typecheck and lint; root/app JS lint and three lint
  negative controls passed.
- `pnpm test:ci`: 114 passed; runtime-matrix and workflow policies passed.
- Reporter app production build and size gate passed; 29 performance-script tests
  passed. Gzip bytes: launcher JS 1410/1536, CSS 797/1024, app JS 8742/10240.
- Package assembly, installable ZIP verification and secret scan passed:
  version 0.1.10, 29 files, SHA-256
  `a833637ef53aa43ffcff0179511a1ffb2797f2726ebd356e62a0c6c6a80f466e`.
- Composer install, PHPCS and PHPStan passed; modified shell scripts parse.
- Provider seam red evidence: 1 failed / 4 passed before restoring Discord custody;
  final provider/broker/gate plus stage tests: 15 passed.
- Discord/restore/marker/stage/provider focused run: 72 passed (before the final
  two real-helper/broker refusal cases, covered in the 15-test run above).
- Additive policy/native transition run: 124 passed / 2 failed. The failures were
  main-only fixtures still leaving ledger additions pending after integration;
  the fixture now selects current ledger history for that case; both targeted
  native main-only cases then passed. A hypothetical DiscordAlertSecret snapshot
  also refuses in the offline graph test.
- The first full run started before seam edits: 1,148 passed / 2 failed, with the
  stage-gate assertions observing a cached pre-edit entry module. Fresh targeted
  stage/provider/gate tests passed. A second full run uses committed, unchanged
  Worker source at `56c0561`: **1,159 tests / 46 files passed** in 612 seconds.
  The final follow-up only removes inherited EOF blank lines in
  `maintenance-operator.ts` and `support-stack.ts` and completes this evidence.
  Whole-candidate whitespace checks then pass; no additional full run is needed
  for those whitespace-only edits.
- Current Worker/docs/ZIP secret scans and candidate-reachable history scan
  (`--log-opts=HEAD`, 198 commits) passed. The default all-local-refs scan reported
  a generic-key match in `operational-readiness.md` at unreachable checkpoint
  `60e6b2e79a0f5c2b9e89a6c57d19141d089efbbc`, outside candidate ancestry and all
  branches. Only redacted finding metadata was inspected; no exception or
  source-history rewrite was introduced.

DDEV refused this checkout because the named running project belongs to another
checkout; it was left untouched. Direct PHP contract execution without WordPress
bootstrap failed all 237 cases (`GQ_Support_State` unavailable); an unconfigured
PHPUnit invocation only printed usage. Neither is application evidence. Full
WordPress/plugin-check/browser/runtime matrices were not rerun here. Inherited
source evidence: #104 reports nightly Chromium, Firefox and counter passes; #106
reports PHP 8.5 and PHP 8.1 contract/runtime/browser/counter passes. Those results
belong to their pinned source heads, not this integrated candidate.

## Bounded outer runtime observation follow-up (CODE only)

Based on PR119 `674a5994cf8a43e2a80c19c43d659cab0cf02ad3`, stacked on
`t3/bounded-discord-custody`. No migration, provider, secret, deployment setting
or live operation is introduced. This remains a draft integration candidate;
#20 and #29 remain open and are not MVP accepted.

Boundary inventory before the change:

- Prompt delivery resolved environment/credentials and raw bindings, then ran
  `recordAlerts(contained(sweepDelivery))`. Its 25s `timeoutOption` and failure
  catch enclosed that collector, so outer failure logs escaped collection and
  timeout `None` was silently discarded.
- Tick resolved raw bindings and derived its title key before `recordAlerts`;
  its outer catch was outside collection. Scheduled phases individually caught
  failures inside collection, but all four timeout results were discarded.
  Persistence preceded the separately caught alert drain.
- Fetch resolved request/environment/execution context, receiver, services, key
  and bindings before its request collector. It registered persistence only
  after successful contained handling. Escaped failure/cancellation bypassed
  registration. Separately started webhook refresh already caught failures
  inside its own collector; that catch is preserved.

Newly wired CODE: one invocation collector encompasses failure logging and exit
finalization once usable bindings exist. Tick key setup and delivery/request
handler failures are observed without changing original errors or response
codes. Existing cooperative deadlines (25/5/11/16s scheduled, 25s delivery wake,
12s webhook refresh) now produce fixed existing failure classes; support work is
never restarted. Delivery's synchronous binding acquisition precedes its bounded
actual work; missing bindings remain logs-only. No new request-handler deadline
is invented. The installation API's existing unexpected-exception 503 catch
marks a data-free internal flag; only that catch emits the new
`request_handler_failed` class. Validation/client errors and intentional
containment 503s remain unalerted. There are now 25 finite classes, with unchanged
privacy, incident keys, recovery and deduplication rules.

Request finalization registers independent persistence through the existing
execution context without awaiting I/O, including on failure/cancellation.
Registration failure cannot change an accepted response. Background/Cron exit
persistence has a separate two-second cooperative bound and stops starting
further event observations on cancellation. An already-started observation
(at most two D1 statements) may finish only against finite alert state. These local writes no longer acquire a support
runtime admission or read SupportDB: an alert-store failure cannot strand a
support recovery obstruction. Support work, uncertain provider ownership and
Discord transport retain their original containment/admission checks. Phase
ordering and persistence-before-drain ordering remain intact. Nominal phase
bounds total 57s, plus at most the cooperative 2s persistence and 2s transport
bounds; this does not promise completion before the next tick or cancel
non-cooperative support cleanup.

Unknown pre-binding failures cannot persist without bindings; fixed fallback
logs and external observation are required, without a reacquisition loop.
Alert-drain/store outages remain nonrecursive fixed logs. A failed/uncertain
Discord route remains latched locally and cannot report its own outage through
that route. External monitoring still needs to integrate platform 5xx, missing
Cron, workflow/deployment failures outside the Worker, total-route/pre-binding
failures and route health; operator receipt remains separate from HTTP 200.
No external monitor, live routing, acknowledgment or escalation ownership is
implemented or claimed by this slice.

### Runtime follow-up validation

New execution evidence on Node **26.12.1** (not inherited PR119 results):

- RED: temporarily restore only `worker/src/worker.ts` from pinned PR119, run
  `pnpm --filter gq-support-worker test --maxWorkers=1 test/worker-runtime-alerts.test.ts`:
  **3 failed**, each missing the expected outer tick/delivery/request alert row.
  Restore the implementation before further checks. The tests use the actual
  Worker registration/handlers with registration/setup doubles, real collectors,
  local workerd D1 and fake transport; they do not provision or invoke live services.
- Focused final command:
  `pnpm --filter gq-support-worker test --maxWorkers=1 test/runtime-alerts.test.ts test/worker-runtime-alerts.test.ts test/scheduled-alerts.test.ts test/discord-alerts.test.ts test/maintenance.test.ts test/github-webhooks.test.ts test/lifecycle-webhooks.test.ts test/status-webhooks.test.ts`:
  **173 tests / 8 files passed**. Includes cooperative timeout finalization,
  original cause/response preservation, the unexpected application 503 boundary,
  disabled mode, absence of private payload values, duplicate prevention,
  maintenance denial, retained support ownership, hung persistence and absent raw
  bindings. The real four scheduled deadlines are exercised with Effect TestClock;
  support work/finalizer order is asserted, not inferred from timeout log strings.
- `pnpm --filter gq-support-worker test --maxWorkers=1 test/retained-provider-continuation.test.ts -t 'applies enabled='`:
  **4 passed / 40 excluded**, after staging the new tracked source.
- Final complete run on committed, unchanged Worker source `2f08d19`:
  `pnpm --filter gq-support-worker test --maxWorkers=1`:
  **1,263 tests / 51 files passed**, **693.30 seconds**. This full run is justified
  by the shared persistence, HTTP adapter and scheduled deadline changes.
- `pnpm --filter gq-support-worker typecheck`,
  `pnpm --filter gq-support-worker lint`, `pnpm lint:js` and `pnpm test:lint`
  passed (the latter: **3** lint controls).
- `pnpm test:ci`: **114 passed**;
  `node scripts/ci/workflow-policy.mjs` and
  `node scripts/ci/runtime-matrix.mjs policy` passed.
- `scripts/ci/gitleaks.sh dir worker`, `scripts/ci/gitleaks.sh dir docs`,
  `scripts/ci/gitleaks.sh git . --log-opts=HEAD`, and whole-slice
  `git diff 674a5994cf8a43e2a80c19c43d659cab0cf02ad3..HEAD --check` passed.
  Final documentation-only evidence is scanned again before publication.

An initial full run was interrupted for the absent-binding correction. Before
interruption it reported **18** native fixture failures: the newly imported
helper was untracked and excluded from the fixture's tracked-source manifest.
Staging/committing the final source resolved the four retained native happy paths;
the complete final run above passes all native cases. The interrupted run is not
passing evidence. No browser/PHP/DDEV, deployment, credential/profile access,
notification, hosted CI polling/watch or merge was performed. Publication uses
`GQ_SUPPORT_SKIP_PRE_PUSH=1` to skip the optional shared-DDEV hook.

Rollback caveat: older code does not recognize the newly persisted
`request_handler_failed` class and can latch the existing notification route
closed on encountering it. Alert state needs review under existing controls;
this is not permission to release support/provider ownership or reopen a route.
Inherited PR119 evidence above is not new proof for these runtime changes.

## External observer design and offline protocol follow-up

[External incident observation](external-incident-observer.md) specifies bounded
Actions observations, source/permission limits, separate Cron start/terminal
heartbeat requirements, durable sender ownership and the remaining receipt policy
frontier. It is based on PR120's pinned `6f57bf1381d80fb42c7d30b76eef2f7f0321310d`;
actual head branch is `t3/outer-runtime-failures`, not `t3/outer-runtime-alerts`.
The [offline protocol/evaluator](../../worker/tools/observer/README.md) now has
77 passing isolated tests and five detected broken variants (Node 26.12.1, one
Vitest worker). It adds strict proposed contracts, finite verdicts and bounded
in-memory failure carry only. Snapshot/heartbeat/readiness remain proposed until
the next producer slice implements controller-minute start, settled phase/drain
results, maintenance/activation/coverage and scoped read-only endpoints. No running
observer, workflow, scheduler, heartbeat producer, HTTP transport or live
configuration is implemented or enabled. Wire identity/scope/lag/sampling, runner
custody, receipt reconciliation and authorized LIVE proof remain required. A protected persistent journal is a prerequisite, not an
assumed property of hosted Actions runners. GitHub failure visibility is not an
approved or verified fallback notification route. The parent visibility versus
independent fallback choice remains pending. #20 and #29 remain open.

## Remaining CODE and LIVE gates

#20 still lacks external platform-generated 5xx, absent-Cron, workflow/deployment
failure outside the Worker, total route/pre-binding failure and operator-receipt
observations. The bounded outer-runtime follow-up below wires application tick,
prompt delivery and request failure observations, but cannot close those external
gaps or prove live Discord routing. Existing Discord producer tests do
not make #20 accepted. Managed Composer/tested-ZIP MVP upgrades, vvaz **or**
gmarques authority (no hierarchy), Discord routing and the approved tracing policy
are settled decisions, not LIVE settings or candidate approval.

LIVE prerequisites, after CODE compatibility is reviewed:

1. Reviewed real endpoint identity/version, deployment ID, ETag/script digest,
   module/binding manifests, complete native resource/output graph, physical D1
   IDs/instances, and actual full migration/history/checksum/column manifests.
   Establish whether ledger 0002 is committed; never infer it from a fixture.
2. Authenticated GitHub permissions, protected-environment reviewers and protected
   runner proof; candidate-specific post-plan approval of exact source/lockfile/
   migration/target/state/window/bundle digests, nonce and expiry.
3. Parent-managed private one-shot secret delivery; no profile/cache discovery.
   Existing broad Alchemy state bearer stays only in the trusted broker, never
   graph/child/public evidence. Explicitly scoped deployment/read/App custody.
4. All external writers excluded from acquisition through apply and incident
   reconciliation, including local operators, automation, other repositories,
   endpoint deployers and credential holders. Local serialization is insufficient;
   exclusion and retained marker ownership survive cancellation/expiry/runner loss.
5. Separately authorized remote RPC/key/binding custody proof, Test F proving the
   negative plan/apply boundary, staged restore/epoch/revocation/erasure/suspension/
   uncertain-delivery drills, and staged Discord delivery/recovery/disable/custody
   and privacy read-back drills. Confirm private destination access, retention and
   incident receipt/acknowledgment arrangements without inventing a responder order.
6. Explicit live authorization and fresh staging/production candidate approval.
   No policy decision or this draft grants them. #20/#29 remain open.

### Offline observer review corrections

PR122 independent review found three P2 Spec defects and one P3 test-convention
breach. All were corrected: same-time HTTP samples cannot confirm recovery,
samples cannot pair across candidate/maintenance generations, late older Cron
failures retain unresolved ownership after a previous recovery, and privacy
fixtures use runtime-generated artifact-scanner canaries. Four added regression
cases reproduced the defects before correction; all 81 protocol tests pass after.
No transport, producer, scheduler, durable sender or LIVE evidence is implied.

### Internal Cron progress producer CODE follow-up

The Cron callback now retains `ScheduledController.scheduledTime`, actual UTC
start, finite support phase outcomes and separate notification drain results in
new aggregate SupportLedger tables (`0005_cron_progress.sql`). Terminal records
follow local work/finalizer settlement; they do not resolve uncertain provider
writes. The 60-minute/four-attempt ring uses a sticky partial marker for overflow
and lost unresolved evidence. Progress I/O is best effort with 100ms cooperative
bounds per write and never joins restore drain/admission. Retained native upload
requires public candidate/stage identity in both Discord modes. Missing identity
leaves observation unknown while support continues.

This is internal producer CODE only. Remote migration applicability, activation,
external snapshot coverage/source/authentication and observer enablement remain
unknown/unwired. The 100-row offline consumer cannot silently consume the
240-row ring as complete; the next read-only adapter needs bounded coherent
pagination or explicit partial coverage. See the exact next capability contract
in [observer design](external-incident-observer.md#internal-cron-producer-code-slice-2026-10-27).
All LIVE manifests/permissions/reviewers/runner/exclusion/credentials/approvals,
RPC/Test F and drills remain unverified. #20/#29 stay open. No live operations,
settings, credentials, notifications or external resources were changed.
