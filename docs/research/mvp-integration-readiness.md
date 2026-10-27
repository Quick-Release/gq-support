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

## Remaining CODE and LIVE gates

#20 still lacks external platform 5xx,
missing-Cron and deployment-failure observations, outer tick/prompt wrapper failure
observations and failed-route observations. Existing Discord producer tests do
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
