# Support operations implementation handover

Updated 2026-10-31. This hands over [#20](https://github.com/Quick-Release/gq-support/issues/20), the implementation specification [#134](https://github.com/Quick-Release/gq-support/issues/134), and their rollout dependencies. **Implementation and production readiness are not complete.**

## Resume here

1. Preserve the user's pause on cybersecurity-related implementation, probes and reviews. Do not reword prompts to evade a flag. Resume that work only on explicit instruction. Documentation and repository housekeeping are authorized.
2. gq-support main is `cb7451b48afb36cdf705ca67c1f2f3e1cd60cc1f` before this handover. The previous working branch, `fix/manual-release-registry`, is already merged through PR #157; it has no remaining commits to merge.
3. Do **not** merge [gq-site #150](https://github.com/Quick-Release/gq-site/pull/150) at `516a0938c38ae1f4c6773067148adcf3d5bfa78f`. All 12 checks pass, but independent review reproduced a controller policy-admission bypass. GitHub's CLEAN/MERGEABLE status is not review approval.
4. No real-host guarded deployment is enabled. No authoritative Support 0.1.11 release approval or real Slot/target binding exists. Production Support rollout and its Banquinha key/deploy remain held.
5. Nomia production is back on baseline `0749f2f5aa0a16dde34d484f768b4b6b0bc68c8e`. Nightlies remain paused. A new offline trial snapshot is prepared, but no new live trial, login, deployment, draft write or stable tag is authorized.

This file records known evidence, not permission to perform the listed live actions. Provider state and CI must be rechecked when work resumes. Scratch files are local evidence, not durable storage guarantees.

## Decisions to preserve

- Use the Tipme Cloudflare account `8f38791a8c37b182239af2a385ab3c31` and shared resources per stage. Never replace/delete shared databases to onboard or offboard one Client.
- EKIS and Nomia use central hosting/Composer deployment, not WordPress-native updates. Bruaa waits until it has WordPress.
- EKIS CMS is staging. Nomia CMS is **production**, even though its existing Sigillo environment is named `staging`.
- All authorized team members can view, claim and resolve incidents. No assigned on-call rotation, escalation or reminder system was requested.
- Never introduce backend health/update calls into ordinary WordPress page rendering. Accepted Support work remains service-owned when a Client is disabled or revoked.
- D1 outbox/recovery sweep is the current delivery model. Queues/DLQ and blind replay are not prerequisites. Never force-create an outcome that is still unknown.
- Private package approval binds authenticated provenance and exact normalized installed files. Source commit, published tag/package commit and ZIP byte identity are different facts; Composer may repack a ZIP without changing its approved files.
- The real update/recovery drill is **0.1.11 → signed/approved 0.1.12 → 0.1.11**. Do not roll back to an unsigned legacy package.
- Local tests, publication, dispatch and provider SUCCESS are not installation convergence or human acceptance. Historical acceptance of the failed Nomia trial does not authorize another run.
- Cross-repository work must use a T3 session bound to that repository and a dedicated worktree before its agent starts. Do not change directories into other repositories from this session. Do not use bare stash or rewrite reviewed history.

## Completed source integrations and evidence

| Repository / work | Integrated state | What this establishes |
|---|---|---|
| gq-support #135–#148 implementation, consolidated by #149 | Source on main; acceptance issues remain open | Operations, incidents, inventory, release policy, recovery and readiness foundations; not live readiness |
| gq-support #150 | `460c902` | Deployment foundation, retained resource identities and migration dependency ordering |
| gq-support #152 | `077c1fe0c8a366d82d21452b7683afe8724b74e0` | HTTP/upgrade test corrections |
| gq-support #154 | `29de3c7ec66ad96d6726bae20766c2acc7fcc312` | Read-only authoritative Composer approval CLI; this is gq-site's reviewed Operator pin |
| gq-support #155 | `9c4357b5610b8764e91d113b26af3101de81eada` | Scheduler cancellation/latency corrections; staging deployment succeeded |
| gq-support #156 | `55ec3ed9201277de0dc6722d9187917f9acc8b4f` | Test-only WordPress login autofocus race correction |
| gq-support #158 | `806bcdfa8429a15cbc0e0ac86cb6c86b815e8671` | Idle cleanup sequential calls reduced from 16 to 12; privacy/ledger order retained |
| gq-support #159 | `be93143dfd3759694ac72d8ccc77ec061097412f` | Sanitized public HTML mismatch evidence; no runtime B1 root cause/fix claimed |
| gq-support #157 | `cb7451b48afb36cdf705ca67c1f2f3e1cd60cc1f` | Manual registry notification permission fix, including correct source-release read token |
| Banquinha #107–#110 | Latest integration `78a6e3d229320e0f81812a8a7e1ebfd8e9e8ffc1` | Staging dashboard deployed and signed-in inventory/health smoke passed; real incident claim/resolve drill still needed |
| EKIS #218 | `3bbc87cf35de066694f469cc1edf78c728a35261` | Opt-in release-ref source support; remote Ploi script has not been updated |
| Nomia #118 / #119 | Main `d80fdd791f45b025302a0355376d16b4abe8a2c6` | Nightly pause and strict offline snapshot/record helper; merging did not deploy |
| Design #98 | `e8b070f3c0a7fd2c967c585b7e41e74805eb89ef` | Real-editor coverage and WordPress 7.1 canvas theme injection fix |
| Design #100 | `c39163047a03092f01ad7c5e19c2d937cbf06f18` | Late template-list normalization fixes indexed core lookup warnings |
| Design #102 | `b97b0ae868ad2e71880e97445cf6b9b6cd7bd70d` | Core-support golden subset policy and expanded 7.1.4 integration CI; runtime unchanged from #100 |

Design #98/#100/#102 were normally merged at pinned reviewed heads, with merge trees equal to tested heads. Both WP heavy lanes passed at their final heads. Polylang Pro was denied **before steps** by its tag-only environment rule; the aggregate runs FAILED. This is not full CI green. Real stable tag publication must still pass Pro CI; do not weaken the environment or create a fake tag.

### Support 0.1.11 publication

- Release run: `41200395919`, source `55ec3ed9201277de0dc6722d9187917f9acc8b4f`.
- Published package/tag commit: `670beb54e618a77345d60039c8730743bac1c5f0`.
- Approved candidate ZIP SHA256: `7ff15e5f3df52abca0eedbd75d45936c0ff44ebacf0c65dc9fe6fd50f6bd5f87`.
- Normalized 31-file digest: `8d3319a66d63c91d8f3ce6c3317bc0d5d45426051a50540459b084c911fea9d6`.
- Authenticated Composer metadata had the same source/dist reference; its repacked dist matched all 31 paths and file hashes, with no extra/missing files. Nothing was installed on EKIS.
- Registry notification `41208572858` and receiving registry build `41208582847` succeeded. Publication is **not** an authoritative D1 release approval; that record has not been created.
- Local evidence: `/tmp/gq-release-0.1.11-candidate`, `/tmp/gq-release-0.1.11-41200395919`, `/tmp/gq-support-0111-publication-verification.json`, `/data/agents/scratch/ekis-audit/`.

### Last known service deployment

Staging Worker deployment `41204100955` succeeded at `806bcdf` on 2026-10-31 13:10:52Z. Main migrations through `0031` and ledger through `0004` were applied there. Production remains at the earlier `0e6bfc92` deployment, main schema `0019` / ledger `0002`; no production upgrade is authorized.

Staging resources:

- Worker: `gqsupportworker-worker-staging-fzos3ewkrboeduj2`.
- SupportDB: `8e8e563c-6633-415a-b435-0a36c0debafe`.
- SupportLedger: `d9e31902-5d44-43ed-bdeb-c88b1a6c63af`.

Production resources:

- SupportDB: `c52c2ec5-f954-4d93-9099-82bcd058d34f`.
- SupportLedger: `4e0aa172-c5f2-4341-8286-c69a6316b6c3`.

Short staging observations after #158 showed 10 completed cleanup ticks / 0 timeouts, then a separate 20 completed / 0 timeouts. One signal timeout occurred in the first window. This is short-term evidence, not a seven-day baseline or production improvement claim. Reports: `/tmp/gq-staging-cleanup-verification-2026-10-31.md`, `/tmp/gq-stage-158-observation.json`, `/tmp/gq-stage-158-followup-observation.json`.

## Ordered remaining implementation and rollout work

### 1. Resume and finish gq-site #150 only after the user lifts the pause

Remote head: `516a0938c38ae1f4c6773067148adcf3d5bfa78f`, based on merged main `8c80742946cd` (0.32.0). The worktree was clean and no owned tests/containers were running when paused. The watch is off.

**Blocking review finding:** one controller admission `ls-remote` call still discovers Git configuration from its cwd rather than using the controller-owned scratch repository. Independent local review demonstrated that workspace repository configuration can select a different default branch and admit an otherwise held release. The initial admission and release-step re-admission share this flaw. Green CI did not cover that cwd case.

When explicitly resumed:

- Bind every controller Git call to the isolated repository; add a behavioural regression for repository configuration in the tag workspace. Prevent cwd discovery from influencing default-branch policy authority.
- Reconcile environment/protocol/URL rules across `trusted-git.mjs`, controller `release.ts`, and `ci-release.mjs` source fetch. The latter still passes caller environment and lacks some promised isolation. Do not claim the three copies are identical until verified.
- Specify supported URL schemes consistently, remove unintended production fallbacks, clean scratch repositories on completion, register the shared Git HTTP test helper in development docs, and correct the remaining documentation overclaims.
- Preserve the normal main merge and its verified resolutions: `{ composerOnly, env }`, precheck `{ env: context.env }`, and separate Unreleased / released CHANGELOG sections.
- Run affected local tests and required checks, then fresh independent Standards and Spec/security review at the exact pushed head. Merge only after blockers are resolved. Never equate an empty reviewDecision or MERGEABLE with approval.

Admission itself now uses explicit state: only exact `open\n` serves PHP. Previous maintenance-file, nested-INI and unreadable-state problems were fixed and reviewed. The full generated deploy smoke passed 52 checks, but no real Ploi host was verified.

**Activation prerequisites remain a separate human-reviewed hosting gate:**

1. Serving FPM pool enforces the Site-owned prepend with `php_admin_value`; all PHP under the docroot uses that pool, one guarded Site gate per pool.
2. Correct `apps/cms/web` docroot before bootstrap; trusted local HTTPS for the admin host and reachable challenge path.
3. Reviewed permission to reload the serving PHP-FPM version.
4. Required process visibility.
5. Review shared-master reload effects, interrupted in-flight requests, and startup-error display/cache policy.

Routing → prepare gate → enable pool setting → first verified guarded deploy is the bootstrap sequence. A missing gate under the enforced setting is an outage. Static assets are not held. Startup warnings may produce a 200 response before the gate without running app code. Same Unix user, hard links, FIFO availability, two-version test limits and production-template uncertainty remain documented limitations. No hosting changes have been made.

Existing deployed controllers lack the new admission. After a reviewed gq-site release, every participating Site needs `gq sync` and `gq ci deploy` under separate rollout authorization. Keep release tags blocked until its controller is updated.

### 2. Complete the Support approval and EKIS central deployment path

- Establish actual staging Slot/account/database/ledger bindings and reviewed Operator machine configuration; do not use a sandbox approval for EKIS.
- Create the authoritative approval for Support 0.1.11 using the exact published package identity, provenance and normalized files. Readiness and policy checks must pass before dispatch.
- EKIS live staging remains `31fd9c0c4945b4281d6af379b6229f9a9a3c8f96`. Ordinary main deploy hold stays. Main still locks unsigned Support 0.1.4 and would downgrade without a reviewed lock PR.
- Integrate approval and installed-file checks plus reviewed request admission into EKIS's actual custom deploy path. Today it checks release SHA/Ploi success only. gq-site source alone does not wire this custom script.
- The remote Ploi script remains `a0c78e8`, without release-ref support. Prepare/review the exact script, then obtain separate permission for uploading it; verify release-ref passthrough. Do not upload merely because #218 merged.
- Prepare/review a Support-only staging-release branch from the live baseline, locking 0.1.11 at `670beb54`; retain unrelated Design/theme/content pins. No such branch currently exists.
- Deploy only after the approval/host/script gates. Verify installed files and runtime before recording convergence. Prepare a separately approved signed 0.1.12, then run 0.1.11 → 0.1.12 → 0.1.11 recovery with exact package evidence.
- Prepare a separate Support-only main lock PR before resuming ordinary main deploys. Never fall back to an unsigned legacy package.
- [EKIS #219](https://github.com/Quick-Release/ekis/issues/219) tracks its stale manual `validate:api` schema. It is pre-existing and not wired to runtime/CI/deploy; do not treat it as a new WP 7.1 rollout blocker.

### 3. Complete incident, notification and independent-monitor operation

- Staging Support-request Discord destination and dashboard signing/access were configured. Production Support-request destination was supplied but not installed. Operational-incident webhook destinations and independent checker configuration remain missing. Request secrets through the private secret tool, never chat or source.
- Configure reviewed staff/Operator authorities and credential ownership. Production mappings, targets, contacts, expiries/rotation evidence and final reviewers remain incomplete. Anyone with the approved Sigillo access may hold credential-owner responsibility; no new on-call policy is implied.
- Run a controlled staging incident end to end: persistence, Discord notification, dashboard visibility, competing claims, resolve, audit, recovery and CLI fallback. No production fault injection.
- Deploy/enable and verify the independent scheduled checker, documenting its GitHub failure-domain and artifact-retention limitations.
- Run the complete required recovery drills from [support-operations.md](docs/runbooks/support-operations.md), including broken webhook, Worker/D1 outage, unknown/late delivery, restore/suppression replay, notification/dashboard outage, bad update, compatibility window, offboarding and separate-device contact.
- Capture actual retention/access settings and at least seven days of threshold measurements. Keep provisional thresholds labelled provisional.
- Only after the required incident and WordPress update/recovery drills may production Banquinha key/deploy and service rollout be proposed.

### 4. Nomia Design dependency: prepared, not approved for another live trial

Production baseline is `0749f2f5…`. The historical trial snapshot `373bcf7a…` **FAILED at D4c** and was recovered without DB restore. Trial record `7458489028` is ERROR; rollback record `7458574027` is SUCCESS, Ploi recovery log `122908358`. Draft 1930 was permanently deleted; protected page modified/revision values were unchanged. Two full deployment paths, refreshes, edit locks, transients, archives and ledger records remain: deletion was not “no trace”.

Old trial plan SHA256 `b86109c76c0bca220c14a8c447c955550850268b7bb9acb18f8b61b3c19e0199` and H-result `9dbd4d2a16ca375e4bd8b8aae9bd3fba1101e4d8dda2c835de7b2806e343bf8e` remain historical. Prior human E3/SSH acceptances apply only to that failed run. Retired sources `c8e8e78` / old snapshots must not advance.

New **prepared source only**: `b97b0ae868ad2e71880e97445cf6b9b6cd7bd70d`, existing nightly `v0.9.6-nightly.20261031.16.1`. Source version remains 0.9.5, which has never been stably tagged/published. No stable approval exists.

| Prepared identity | Value |
|---|---|
| Design manifest SHA256 | `079b54e99ca70d9a283ed62ea14f698ba1948d68ec9537e6a870614b53465b87` |
| Design ZIP SHA256 | `8f91ccae3e98f5106ecfebe8418574b8a1b305d70c7347a8dec2312ee8dcac2b` |
| ZIP SHA1 / lock dist shasum | `ca24edcb26ecc303505aa5cee7c0de89a917270f` |
| Nomia snapshot | `82dd0ec2ea6cfd1540e6e8b76b964303b152b20f`, parent baseline `0749f2f5…` |
| Bundle SHA256 | `e835073b761386eb1682c046e38bbe7dae89d0176515d7246fc8ecae595e8057` |
| Lock SHA256 | `33eba70e1a6da7963e8a45e5ec850e26f213316745e4fca12c9f95c8820981eb` |
| composer.json SHA256 | `fb96873d05be3498c70dff2377dac405ebe21b7ff9a78fbfa5d3351da5646b6d` |
| Lock version / plugin API | `dev-nightly-20261031.16.1` / `2.11.0` unchanged from baseline |
| Served theme.js discriminator | `c8871af8ac086a2db126caae24e7419f22e3237162c2488c6b2f70d8bdc39d09` |

The helper verified a clean tree and exact six-entry delta; only Design/content-hash changed in the lock. Content remains nightly 14.1 at source `043afbe`; frontend, deployment lifecycle, pnpm and VERSION are unchanged. Candidate R2 archive is **not created**. `responsive-editor.js` is unchanged from baseline and cannot distinguish this build; use theme.js plus runtime version in the binding chain. GitHub release `immutable:false`: rely on hashes, not an immutability claim.

Remaining preparation/approval gates:

- Design owner binding-chain review must replace checklist PENDING identity rows with independently verified snapshot values. Preserve old checklist/failed evidence, issue a new hash for any change.
- Decide listener logs versus sanitized HAR, review the harness and credential minimization. **No HAR decision was finalized.** A raw HAR contains authentication material and must not be collected casually.
- Authorize and pass a harmless, user-present capture preflight: visible headed window, real screenshot/ARIA, console error and failed-request detection from navigation start. The prepared harness has not been launched. Prior hidden T3 preview could not supply acceptance-quality captures.
- Confirm human 2FA works in a fresh disposable browser profile. Never export cookies/storage state from the user's regular browser.
- Obtain fresh separate human acceptance for E3 (PHP logs unverified, including known-warning context), residual out-of-band SSH risk and any applicable hosting risk, each role/UTC; agents cannot accept them.
- Present the final plan/checklist/snapshot hashes for explicit approval of record/deploy/refresh, exactly one test draft/save/permanent delete and baseline recovery. No live step is authorized by preparation or this handover.
- After an accepted trial, ask separately for stable approval and a v0.9.5 tag. Its tag CI, including Polylang Pro, must pass before publication. Nightly dispatch remains off until separately authorized.

Design [#104](https://github.com/Quick-Release/gq-design/issues/104) remains open: pre-existing native/Design alignment and gradient overlaps occurred on both WP 7.0 and 7.1.4. No new 7.1 output conflict was reproduced within the bounded local probe; Post Content, individual Site title/tagline, Button width and live consumer rendering were not fully exercised. No control removal, migration or precedence change was approved. This is separate from #102's metadata oracle; the trial must not silently exercise or waive it.

Source audits found no direct manifest-support consumer in tracked Nomia, EKIS, gq-site or Content source. Design's 0.9.0/0.9.4/current schema/client source accepts additive maps; instance nodes do not acquire metadata keys. Authored native styles can still create rendering-parity differences. Custom Site adapters, storefront internals, hosted limits and actual installed identities remain unverified. Design #99/#101 closed as source fixes, not claims of live acceptance.

### 5. Finish acceptance issues, not just code merges

All these issues are still OPEN as of this handover:

| Issue | Outstanding acceptance / dependency |
|---|---|
| [#135](https://github.com/Quick-Release/gq-support/issues/135) | Real durable incident claim/resolve/audit evidence |
| [#136](https://github.com/Quick-Release/gq-support/issues/136) | Operational destination configuration and notification/recovery drill |
| [#137](https://github.com/Quick-Release/gq-support/issues/137) | Complete real installation/credential/resource ownership inventory |
| [#138](https://github.com/Quick-Release/gq-support/issues/138) | Measured routing/threshold evidence and controlled failures |
| [#139](https://github.com/Quick-Release/gq-support/issues/139) | Independent checker configuration, deployment and outage proof |
| [#140](https://github.com/Quick-Release/gq-support/issues/140) | Retained non-destructive prod plan and authorized deploy evidence |
| [#141](https://github.com/Quick-Release/gq-support/issues/141) | Authoritative release approval, dispatch and compatibility-window proof |
| [#142](https://github.com/Quick-Release/gq-support/issues/142) | Reconcile native implementation scope with central-only selected Sites; real package/update validation |
| [#143](https://github.com/Quick-Release/gq-support/issues/143) | Reviewed gq-site/EKIS adapters, host prerequisites and actual installed-file validation |
| [#144](https://github.com/Quick-Release/gq-support/issues/144) | Eligible targets, dispatch/convergence and compatible rollback drill |
| [#145](https://github.com/Quick-Release/gq-support/issues/145) | Dashboard source/staging smoke done; incident E2E and production access/deploy held |
| [#146](https://github.com/Quick-Release/gq-support/issues/146) | Real staging D1 restore/recovery evidence, suppression and unknown outcomes |
| [#147](https://github.com/Quick-Release/gq-support/issues/147) | Offboarding drill and each Client's verified independent recovery contact |
| [#148](https://github.com/Quick-Release/gq-support/issues/148) | Complete evidence, trusted readiness run and actual human sign-off |

Parent #134 and #20 stay open until their acceptance is evidenced. [#29](https://github.com/Quick-Release/gq-support/issues/29), complete lifecycle/recovery verification, is an explicit readiness dependency and remains open. [#86](https://github.com/Quick-Release/gq-support/issues/86) requires renewing or dropping the braces audit exception before 2027-01-19. Do not close these from local test counts.

Use [production-readiness.md](docs/runbooks/production-readiness.md) and `worker/src/readiness.ts` as the gate schema. Its historical “Current state” section predates the staging deployments and publication above: re-collect current evidence rather than repeating those stale negatives. Still collect all fresh evidence at the exact proposed Worker commit. Run offline first; trusted verification is read-only but needs authorized access. A human's own sign-off comment must quote the final evidence digest; an agent must not post it for them.

## Older open gq-support PR stack: reconcile before merging

PRs #104–#133 are still OPEN, despite later main integrations. Many are drafts or older proposals from a different implementation session. This handover does not establish that any is safe or still needed. Compare their actual patches against current main and #134 decisions; close superseded work only after review, or extract a remaining change into a current, tested PR. Git mergeability alone is insufficient, especially while security work is paused.

| PRs | Subject / status requiring reconciliation |
|---|---|
| #104–#107 | Compatibility/footer, Worker test parallelism, PHP diagnostics, initial readiness evidence; #105/#106 conflict |
| #108–#110 | Restore fencing, deploy protections, Discord delivery; #108/#109 conflict; inspect overlap with consolidated implementation |
| #111–#117 | Native planner, state attestation, I/O confinement, authenticated continuation, staging and additive migrations; #112–#115 drafts |
| #118 | Conflicting draft combined integration candidate; do not treat as the integration authority |
| #119–#121 | Draft custody, outer-runtime observation and external-observer design |
| #122–#128 | Draft observer evaluation/progress/read/review/private-custody stack |
| #129–#133 | Draft runtime validation, tracked Actions reads/custody, planner diagnosis and staging packet |

Other repositories have unrelated open PRs (for example Design #22/#103 and Nomia #111). They were not reviewed for this issue; do not merge them as part of handover housekeeping.

## Evidence locations and handoff owners

- gq-support: root checkout and linked #20/#134 issues. Service source and runbooks are the authoritative implementation; provider observations above are dated captures.
- gq-site: PR150 branch `ops/support-composer-interface`, clean at `516a093`; implementation session `mcp:65e0c4ac-293c-49aa-b2ea-30e00dac2ef0`. Review summary is in the root conversation; retained harness `/data/agents/scratch/pr150-516a093-spec/h1/run.sh`. Do not execute security probes while paused.
- EKIS: session `mcp:5eff9e1b-aba6-4f60-a77d-dd5215845ac6`; registry/file evidence `/data/agents/scratch/ekis-audit/`.
- Design: session `mcp:47efbd57-c58d-425d-83eb-d5a92de46b7e`; prepared provenance `/data/agents/scratch/gqd-prepared-b97/PROVENANCE.md`, SHA256 `68329b0d9a1040280861b9c162ba904b96dde8e9f5bd689bf4c2e4da42939ee9`; local diagnoses under `/data/agents/scratch/gqd-d4c/`.
- Nomia: session `mcp:58233ed8-9457-4aff-b194-ba4139d3ef51`; new plan `/data/agents/scratch/nomia-trial-v2/TRIAL-PLAN-v2.md`, SHA256 `3cf7348acf1dc55fddee203a57a3d4827bb58ada85f32dc8c10af59bb12e6adb`; capture script under its `capture/`; checklist v3 `/data/agents/scratch/gqd-095-acceptance-checklist-v3.md`, SHA256 `2dd82e4421ba5f1995a7152a9c2cc41c30b7abb44b6ed84054ca342cd36a679c` (identity rows were still PENDING at last owner report).
- Historical Nomia trial: `/data/agents/scratch/nomia-trial/exec/evidence/H-result.json` and `H-addendum-2026-10-31.json`; archive/artifact/proof and redacted scan reports remain there. Baseline evidence was archived to private R2 under `evidence/nomia-design-trial/2026-10-31/baseline-0749f2f5/`: 13 create-only objects, GET/hash verified. Bucket lifecycle/object lock remain UNVERIFIED; no retention/immutability promise.
- Content runtime audit: source `043afbe` (v0.4.2 and installed nightly source); session `mcp:ec3de062-241a-4859-be9e-4714ced5870d`.
- Banquinha: session `mcp:launch:4a946f5897e157cce0e26e35f3f2b3edf9e143c6d7b528457b3cc65424bff7f7`; staging deployed, production held.

Read a thread before relying on its status. Completed reviews/audits have been settled; settling is organization, not completion of their parent acceptance gates. Preserve local artifacts before machine cleanup. Never copy raw HARs, credentials, auth URLs, identities or content-bearing logs into this repository.
