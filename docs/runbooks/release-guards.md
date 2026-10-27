# Release guard preparation for #20 / #35 Test F

This change is a **safe partial implementation**. It authorizes no apply,
migration, environment setting change or release. Test F is **not verified**.

## Worker apply is blocked

The existing deploy workflow now fails before the credentialed apply step,
for both staging and prod, with no bypass input. `release-evidence.mjs plan`
checks the explicit stage and Tipme account and then always refuses. It does
not run Alchemy, read cloud state, or claim to evaluate a plan. Replacement,
deletion and additive-plan acceptance tests remain unavailable until the real
adapter below exists. This deliberately prevents even additive deployments.
The existing guarded destroy script and retention on **both** SupportDB and
SupportLedger remain in place. Nothing restores either database.

The [official plan documentation](https://alchemy.run/cli/plan/) describes
`alchemy plan` as a non-applying preview, equivalent to `deploy --dry-run`.
Inspection of the **installed, lockfile-pinned 2.0.0-beta.83 source** found:

- `src/Cli/commands/deploy.ts`: `planCommand` calls `Stacks.plan` with dry-run
  enabled, then renders the native plan. No supported JSON/saved-plan flag is
  exposed. Human-readable rendering is not a machine schema.
- `src/Alchemist/routes/stack.ts`: native snapshots expose resources, deletions,
  stack/stage and the session; `apply(snapshot)` can consume that same plan.
  This is a possible future integration seam, not an implemented adapter.
- `src/Cloudflare/StateStore/State.ts`: `state()` can resume a local bootstrap
  via `hasLocalStack` / `deployWithLocalState` even without `--yes`.
  `loginWithCloudflare` obtains state credentials using `readSecretViaEdge`,
  which calls `createEdgeSession` with a Secrets Store binding. A fresh CI
  runner can take that path. `CI=1` alone is not a read-only guarantee.
- The failed secret-probe path logs a response body and session URL. Raw
  plan/state/session outputs must not be printed or uploaded; redacted CLI
  resource rendering alone is not a complete output audit.

No authenticated plan was attempted and no new credential is requested.
The minimal next prerequisite is a reviewed state-access approach that can use
the existing credential boundary without edge uploads, bootstrap or state
updates. Prefer an upstream read-only mode; otherwise review a narrowly scoped
read-only state adapter before replacing this refusal. Do not introduce a
boolean environment variable, dispatch flag or hand-authored JSON attestation
as a substitute for a native plan.

That adapter must validate the native plan and the **same snapshot passed to
apply**, including deletions/orphans, not just declared resources. Verify the
resolved account and stage, stable database IDs/names and EU jurisdiction for
both SupportDB and SupportLedger. Reject replacement, deletion, missing or
renamed databases, malformed/unknown/unavailable plans and mismatched targets;
accept reviewed additive changes. Test those cases against the pinned engine's
actual native types before enabling deployment. A reviewed candidate plan
also needs source/migration digests, serialization against concurrent applies,
and a fresh human authorization. Initial creation/adoption needs a separately
reviewed procedure; do not silently treat missing state as safe creation.

## State-access investigation follow-up

The [beta.83 feasibility report](../research/non-mutating-alchemy-plan.md)
identifies a supported explicit HTTP State-service seam and tests its reads
without bootstrap/recovery. It also proves why native bulk export is not a
complete authoritative snapshot: missing rows are skipped, outputs are omitted,
and the wire state schema is permissive. The store bearer has write and
cross-stack authority; no approved read-only credential/snapshot or writer
exclusion procedure is available. The report specifies two bounded custody
options and exact implementation prerequisites. It does **not** implement a
release adapter or lift this refusal. Its local protocol tests are not native
replacement/deletion/additive acceptance or authenticated Test F.

## Candidate and approval boundaries

Plugin publication now runs only on a manual dispatch from `main`, within the
existing `prod` environment. Tag pushes can build/test candidates but cannot
publish. The registry dispatch now follows successful manual publication;
publication still promotes the tested ZIP with its pinned digest, never a
rebuild. Existing installed-package and compatibility dependencies remain
mandatory. The provenance check also binds the candidate to version, source
SHA, workflow run, ZIP digest and both frozen lockfile digests.

The read-only environment metadata check refuses missing required reviewers or
reviewers outside the two authorized people, vvaz/gmarques. It changes no
settings. On 2026-10-27, GET environment metadata for prod and staging still
returned only the branch-policy rule, **no required reviewers**, so publication
is blocked. A person's name, workflow dispatch, passing tests, or this PR is
not release approval. The check verifies configuration presence; it does not
create or export a candidate-specific approval record or establish that admin
bypass is disabled. GitHub's environment boundary supplies the actual approval
step when correctly configured; administrators can change that boundary.

Recommendation requiring separate authorization: configure the existing prod
environment with vvaz and/or gmarques as required reviewers; select self-review
and administrator-bypass policy explicitly (recommend preventing both). Preserve
main-only deployment policy. Decide staging review policy separately. No
primary/backup order has been chosen. See
[GitHub environment API](https://docs.github.com/en/rest/deployments/environments)
and [environment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
If the workflow token cannot read environment metadata, it fails closed; do
not broaden token permissions or treat unavailable metadata as approval.

## Local evidence and remaining live gates

CI script tests cover target refusal, unconditional refusal without a safe plan,
missing/malformed approval configuration, swapped provenance, destructive
Alchemy/Wrangler commands and removal of release workflow dependencies/gates.
Workflow policy is a conservative text check, not a shell sandbox: it catches
direct command vocabulary, including multiline invocation, across workflows
and local actions. Review changes to invoked scripts too; dynamically assembled
commands and arbitrary shell programs are outside this check's guarantee.

Still missing: a real non-mutating plan adapter; replacement/deletion/additive
native-plan tests; authenticated Test F for both databases; candidate-specific
fleet/Worker/schema compatibility and rollback evidence; environment policy
decisions/configuration; explicit human release approval; authorized staged
rollout and recovery drills. Keep #20 and #29 open. Other readiness decisions
and restore-containment changes are owned by their existing pending PRs.

## Disabled direct-backend integration on PR111

Local native D1 plan fixtures, confined snapshot acquisition and a retained-plan
handoff primitive now exist. Their exact behavior, unsupported state forms and
remaining integration gates are documented in
[the implementation boundary](../research/protected-native-planner-implementation.md).
The workflow's refusal remains: these fixtures do not yet supply endpoint
attestation, full-provider confinement, authenticated candidate approval or an
exclusive writer window. Do not replace the guard with a second CLI deploy.
