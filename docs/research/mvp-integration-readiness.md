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
  Discord custody → deployed-key check. Dropping the Discord call failed the new
  provider-lifecycle regression. Injected protected custody remains isolated from
  ambient Discord operations. Failed Discord custody cannot report success.
- Restore admission/runtime containment, fresh independent ledger/provider checks,
  epoch matching, and uncertain notification isolation are retained unchanged.
- Latest #117's `exclusiveLocalWindow.runApply` still encloses the complete
  continuation. Any failed continuation retains its local marker, even before
  dispatch; only verified success releases it. No expiry, new window ID or
  force-clear releases unresolved ownership. External exclusion must survive
  runner loss through incident reconciliation.

### Confirmed CODE blocker: protected Discord custody

**Integrated deployment is blocked in code, even when alerts default disabled.**
`planning-entry.ts` checks `assertIntegratedCustodyReady` after source validation,
before acquiring the window or reading private delivery. Reviewed LIVE metadata
alone cannot remove this gate.

The actual pinned graph has four resources: SupportDB, SupportLedger, Worker and
GitHubAppSecret. Neither source defines a `DiscordAlertSecret` graph resource.
Discord operations were folded into the ordinary App provider. The planning
provider injects a three-operation App custody interface and consequently cannot
perform that ambient work. There is no reviewed Discord resource/profile/protocol.
Adding an independently tracked `DiscordAlertSecret` would currently fail the
exact four-resource snapshot/plan allowlist, lacks a planning provider, and has no
broker state-write/instance/output contract. This task introduces none of those
grants or resource designs.

Concrete unsupported paths under the pinned Worker script:

- `PUT /secrets` to disable/enable Discord and install the URL/release binding;
- `DELETE /secrets/DISCORD_ALERT_WEBHOOK_URL` and `/DISCORD_ALERT_RELEASE`;
- verified absence from `GET /settings`, then `PATCH /script-settings` to restore
  traces, then settings read-back. GET alone has no mutation authority.

The real Discord helper, bridged to the protected broker with fake HTTP, refuses
both enabled and disabled transitions before a secret mutation. Direct unsupported
PUT/DELETE/PATCH requests poison the session with zero privileged dispatches.
Silently omitting custody would upload traces off and commit an incomplete apply.
The explicit gate prevents that outcome; green component tests are not a working
integrated protected deployment.

Smallest follow-up: separately review a bounded Discord custody operation/profile
and its graph ownership (whether the existing App resource or a separate one),
private config/revision binding and exact state/settings transition. Bind it to
the retained candidate and existing authorization/deadline/abort/synchronous
pre-dispatch checks, deny replay after uncertainty, then demonstrate actual shared
graph → provider → broker → verified output completion in both stages. Do not
remove the gate until enabled logs-on/traces-off and disabled verified-removal-
before-traces-on transitions pass, without exposing the broad state bearer.

### Graph, runtime and migration audit

The runtime uses Alchemy's WorkerEnvironment for Discord's optional secret values;
no duplicated ambient Env was added. Worker outputs remain the same six public
keys accepted by the broker. D1 bindings and whole-resource migration dependencies
remain intact. Worker upload keeps traces off during credential transitions;
the ordinary disabled custody helper preserves Logs settings, removes URL/release,
verifies absence **before** restoring traces, and verifies the result. Enabled
custody refuses active/unknown traces. Protected entry cannot complete either
transition yet; this is a CODE gate, not permission to leave disabled traces off.

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

## Newly executed evidence

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

Besides the protected Discord protocol blocker, #20 lacks external platform 5xx,
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
