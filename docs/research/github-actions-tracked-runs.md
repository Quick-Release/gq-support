# Exact tracked GitHub Actions API contract

Retrieved 2026-10-27 from public official GitHub documentation only. No account/API
reads, credentials or live identity/permission checks were performed. This note
records contracts used by the disabled launcher library, not an approved SLO.

- [Get a workflow](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#get-a-workflow): accepts a workflow filename in the fixed GET route. The response is one workflow object with numeric id, path, state and URL. Fine-grained access requires repository Actions:read; public resources support unauthenticated access.
- [Get a workflow run attempt](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10#get-a-workflow-run-attempt): exact run and attempt numbers address one object. Documented fields include workflow_id/workflow_url, run_attempt, repository/head_repository, head_branch/head_sha, event, status/conclusion and created_at/run_started_at/updated_at. Same read permission/public access model. These are objects, not the observer's proposed normalized envelope; a list's workflow_runs array is also not an exact attempt.
- [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions): current documented version is **2026-03-10**, explicitly pinned here. Omitting the header defaults to 2022-11-28; the adapter never relies on that default.
- [Request headers](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#headers): GitHub documents its JSON media type, explicit version header and required User-Agent. The adapter supplies these plus identity encoding and only its explicit dedicated bearer credential.
- [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api): unauthenticated public-resource reads have a primary limit of **60 requests/hour per originating IP**. Secondary limits apply independently. A local 23-request ceiling is not proof of provider quota, entitlement or freshness; the adapter stops on refusal and never retries.

Repository interpretation is separately grounded in checked-in
[CI](../../.github/workflows/ci.yml), [deploy](../../.github/workflows/deploy-worker.yml)
and [release](../../.github/workflows/release-plugin.yml): CI tracked reads are
push/main, deploy dispatch is guarded to main, release allows manual main or the
exact approved plugin-v tag push. Release tags are matched to the independently
expected commit and exact ref; no discovery or tag-resolution claim is made.
Neither display titles nor run path strings reveal trusted stage. Workflow metadata's
numeric ID is joined to the exact run instead. A passing workflow does not establish
the deployed Worker candidate, business health or delivery receipt.

Implementation limits/authority are in the
[observer README](../../worker/tools/observer/README.md#exact-tracked-github-actions-wire-adapter-stacked-on-129).
It permits <=20 exact expectations (including outstanding runs older than 24h),
<=3 metadata + <=20 exact attempt GETs, 64 KiB/body, 512 KiB total, 1024 chunks/body,
10 seconds total clipped to expiry. These local proposals are intentionally finite;
none assert complete untracked discovery, actual GitHub lag or API entitlement.

Offline vectors preserve official envelope shape while substituting synthetic IDs,
private canaries, repository context and responses. They exercise the actual
protocol evaluator, retained failures, exact retry approval, transport refusal and
late stream disposal. Mutation controls remove workflow/head joins, turn cancellation
into success and fabricate empty-source success; each must fail real assertions.
This proves fake-HTTP schema handling and behavior only. Actual repository identity,
workflow metadata, permissions, token scope, lag, private approval/custody and
persistent runner ownership remain independently unverified LIVE prerequisites.

No expansion of #127/#128's private credential bundle or observer-read approval is
made. A dedicated Actions:read delivery and purpose requires future explicit review;
trusted injected source context is not authenticated custody. No Actions write grant,
scheduler, sender, retry, deployment, notification or production enablement follows.
#20/#29 and parent fallback policy remain open.

## Offline validation record

Node **26.12.1**, single Vitest worker, on top of #129 commit
`4b931a09c9bb7a650e0f266d8b6f26a1c1b4e43c`:

```sh
pnpm install --offline --frozen-lockfile
pnpm --filter gq-support-worker exec vitest run --config tools/observer/vitest.config.ts --maxWorkers=1
# 422 tests / 6 files; 83 new Actions vectors plus 339 existing vectors
node worker/tools/observer/negative-controls.mjs
node worker/tools/observer/transport-negative-controls.mjs
node worker/tools/observer/review-negative-controls.mjs
# all 10 existing mutation controls detected by real assertion failures
node worker/tools/observer/actions-negative-controls.mjs
# all 4 new controls detected by real assertion failures
pnpm --filter gq-support-worker typecheck
pnpm --filter gq-support-worker lint
node --test 'scripts/ci/*.test.mjs'
# 114 passed
node scripts/ci/runtime-matrix.mjs policy
node scripts/ci/workflow-policy.mjs
scripts/ci/gitleaks.sh dir worker
scripts/ci/gitleaks.sh dir docs
git diff --check
```

Types, lint, policies, redacted secret scans and whitespace pass. Dependency install
was offline (1387 reused packages, zero downloads). No full Worker suite, DDEV,
browser, live source reads, notifications, deployments or CI polling/watch was run.
The isolated library does not change configured-runtime pins or CI, so #129's
reviewed zero findings/two configured-date cases are retained evidence, not a new
configured-runtime run or live proof from this slice. Only public official docs
were retrieved for the new technical contract; git push/draft-PR publication is
limited to this authorized change.
