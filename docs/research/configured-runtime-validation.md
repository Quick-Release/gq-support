# Configured Worker runtime validation (local CODE evidence)

This closes only the local compatibility-date startup gap identified in the
[observer design](external-incident-observer.md#configured-runtime-validation-follow-up).
The candidate is stacked on PR #128, `6927a400180828dc448b7517be43b00f58141a3f`.
Production compatibility remains **2026-10-17**. No production enablement follows.

## Reproduction and cause

With Node 26.12.1 first in PATH and the baseline frozen lock installed:

```sh
export PATH=/home/valerio/.local/share/mise/installs/node/26.12.1/bin:$PATH
pnpm install --frozen-lockfile
# After adding the gate, deliberately bypass its runtime override for RED:
pnpm --filter gq-support-worker exec vitest run --config vitest.configured-runtime.config.ts
```

RED: **2 failed / 1 file**, including the actual Alchemy-built `src/worker.ts`.
Both fail at workerd startup with:

```text
This Worker requires compatibility date "2026-10-17", but the newest date supported by this server binary is "2026-09-23".
MiniflareCoreError [ERR_RUNTIME_FAILURE]: The Workers runtime failed to start.
```

The direct test dependency `miniflare@5.20260916.0-alpha` pins
`workerd@1.20260916.1`. Its installed `dist/src/index.js` `getRuntimeCommand()`
chooses `MINIFLARE_WORKERD_PATH ?? import_workerd.default`. Without an override,
that resolves the September platform binary, **not** the later workerd reached
through Alchemy's runtime package. Updating types or installing a sibling binary
does not change that resolution. The old binary's package release date is
September 16; its maximum supported date is September 23. Those are different
facts, not a misreported version. The tagged workerd
[validation source](https://github.com/cloudflare/workerd/blob/v1.20260916.1/src/workerd/io/compatibility-date.c%2B%2B)
explains that `MAXIMUM_COMPATIBILITY_DATE` can be slightly ahead of its build.
The existing observer fixture explicitly selects September 16; other local D1
fixtures omit the date and use Miniflare defaults. Neither is configured-date proof.

The resolved Linux baseline executable is
`node_modules/.pnpm/@cloudflare+workerd-linux-64@1.20260916.1/node_modules/@cloudflare/workerd-linux-64/bin/workerd`
(relative to the checkout), reporting `workerd 2026-09-16`. The gate resolves the
same platform-package path shape at `1.20261027.1`, reporting
`workerd 2026-10-27`.

Ranked diagnosis: pinned runtime too old; then harness date selection; then
Alchemy compatibility handling. Differential startup isolated the first cause:
the same installed Miniflare and native Alchemy build succeed after changing
only the selected executable.

## Small supported fix and dependency impact

Add exact **development-only `workerd@1.20261027.1`**. Use Miniflare's documented
[`MINIFLARE_WORKERD_PATH` override](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/README.md#local-workerd)
only in `pnpm --filter gq-support-worker test:configured-runtime`.
The launcher resolves the installed pinned package, checks its package and binary
versions, overrides any ambient executable choice, and propagates test failure
or timeout. It never retries at an older date. A separate mandatory local-runtime
step in the existing Worker CI job invokes this command; no hosted run was polled.

The lock adds six versioned package records: the wrapper and five optional
platform binaries, each with SHA-512 integrity. This host installs two packages.
The Linux x64 tarball is about 43.16 MB; its installed executable is 147,403,608
bytes. The pnpm release-age allowlist expands only to these exact versions.
No existing lock resolution changes: Alchemy **2.0.0-beta.83**, Effect **4.0.5**,
Miniflare **5.20260916.0-alpha**, Vitest **5.0.5**, and Wrangler **4.133.0** stay
fixed. The original Miniflare binary and existing fixture date stay intact.
The Worker declaration and gate now share `worker-compatibility.ts`, preventing
an independent test-date literal from claiming production-date evidence.

Primary release/package evidence checked on 2026-10-27:

- [workerd release](https://github.com/cloudflare/workerd/releases/tag/v1.20261027.1),
  [registry metadata](https://registry.npmjs.org/workerd/1.20261027.1), and
  [Linux platform metadata](https://registry.npmjs.org/@cloudflare/workerd-linux-64/1.20261027.1).
- Wrapper integrity:
  `sha512-L+8DNms50ddCOXoTLBPOd/HMw1g6Ue+iAfDOMA0/LYXvTvmCoHSbul2irpnrauwHhErJE72xlWComALGkj0eWg==`.
- Linux x64 integrity:
  `sha512-VmwsqKsmnZetMmC4P9de3tmOd6+fzOKA1k7EwalGBiuY6POpaYO+R3qb1L1qqSCh9DEcS8iUVldSz7E70g8W4w==`.
- [Compatibility-date documentation](https://developers.cloudflare.com/workers/configuration/compatibility-dates/)
  and [local execution/binding distinction](https://developers.cloudflare.com/workers/local-development/).

This deliberately mixes a newer executable with the existing Miniflare control
protocol through its documented escape hatch. The gate proves compatibility of
the exercised APIs and D1 paths, not every simulated binding. Future upgrades
must repeat it. Normal dev/deploy/fixtures do not inherit this override. There is
no Alchemy wholesale upgrade or production provider/runtime replacement.

## GREEN and refusal control

```sh
pnpm --filter gq-support-worker test:configured-runtime
```

GREEN: **2 passed / 1 file**, `maxWorkers: 1`. The launcher reports
`workerd 1.20261027.1; binary workerd 2026-10-27`. Both cases explicitly start
workerd with the shared configured **2026-10-17** date and Alchemy-resolved flags.

The first case bundles real observer code with local-only acquisition
instrumentation. Wrong well-formed token: 401 and zero ledger acquisitions.
Correct token: native Workers SHA-256/`timingSafeEqual` authentication reaches
exactly one deliberately failing acquisition, returning sanitized 503.
Readiness performs zero acquisitions. This proves execution of the native
primitive, not a statistical timing guarantee or Node crypto substitute.

The case also checks a runtime default enabled on October 1,
`Cloudflare.compatibilityFlags.durable_object_io_tasks_prevent_eviction`, from the
[tagged compatibility schema](https://github.com/cloudflare/workerd/blob/v1.20261027.1/src/workerd/io/compatibility-date.capnp).
It then deliberately restarts the same executable at **2026-09-16** and requires
the probe to reject with `configured-date fallback refused`. This is an executed
negative control, not a skipped case. Exact date selection is shared with the
production declaration; startup is strict in the installed Miniflare/workerd
path, as the RED failures demonstrate. The behavioral sentinel independently
catches substitution of the old fixture semantics.

The second case uses installed Alchemy's `WorkerBundle` with its real Effect
virtual entry and `src/worker.ts`, without replacement module aliases or mocked
Worker/D1 registrations. The actual bridge serves readiness without D1, observer
configuration, App key or support configuration. With both real local D1
bindings (`SupportDB`, `SupportLedger`) and all committed migrations applied, it
serves the authenticated coherent 240-cell snapshot within 64 KiB, including
terminal phases and an unfinished attempt. It verifies generation changes,
late-owner write fencing, held-mode support containment (403 when open, 503 when
held), malformed aggregate refusal and sanitized errors. Each runtime has a
rejecting outbound service; successful cases require zero outbound calls.
Canaries are generated per observer README and never printed.

## Verification record

All commands use Node 26.12.1; each Vitest run uses one worker. The new gate
builds and starts actual workerd twice plus its deliberate older-date control.
Existing fixture tests continue to be labeled separately from configured cases.

- Frozen install, Worker typecheck and lint: passed.
- `pnpm test:ci`: **114 passed**; runtime-matrix and workflow policies: passed.
- Isolated observer command from its README: **339 passed / 5 files**.
- `pnpm build:app` and `pnpm test:size`: build passed; **29 passed**, all five
  gzip budgets passed (launcher JS 1,410/1,536; app JS 8,742/10,240 bytes).
- `pnpm audit --json`: 0 critical, 1 high, 8 moderate, 4 low. The high is existing
  `GHSA-mrhx-c7xc-m3w5`, Zod 3.25.76 only through the app's Lighthouse/Puppeteer
  development chain, covered by the unchanged exception through 2027-01-22.
  The raw audit exits 1; this is not a claim that a full Composer audit ran.
  The repository evaluator confirms `excepted` for that high finding and
  `review` for all lower findings; no pnpm finding is blocking. Missing Composer
  inputs remain explicitly unrun. No PHP/DDEV invocation was made.

The exact focused regression commands are:

```sh
pnpm --filter gq-support-worker exec vitest run --maxWorkers=1 test/retained-provider-continuation.test.ts test/protected-native-planner.test.ts test/confined-planning.test.ts test/staging-target.test.ts test/planning-apply-broker.test.ts test/mvp-integration.test.ts test/observer-http.test.ts test/worker-runtime-alerts.test.ts test/observer-custody.test.ts test/runtime-alerts.test.ts test/scheduled-alerts.test.ts test/cron-progress.test.ts test/additive-d1-native.test.ts test/trusted-discord-custody.test.ts
pnpm --filter gq-support-worker exec vitest run --maxWorkers=1 test/retained-provider-continuation.test.ts test/confined-planning.test.ts
pnpm --filter gq-support-worker exec vitest run --config tools/observer/vitest.config.ts
pnpm --filter gq-support-worker typecheck
pnpm --filter gq-support-worker lint
pnpm lint:js
pnpm test:ci
pnpm test:lint
node scripts/ci/runtime-matrix.mjs policy
node scripts/ci/workflow-policy.mjs
pnpm --filter gq-support-worker exec alchemy deploy --help
scripts/ci/gitleaks.sh dir worker
scripts/ci/gitleaks.sh dir docs
git diff --check
```

The first focused invocation initially had **24 failures / 2 files**, because I
started it before staging the new shared compatibility module. The confinement
harness intentionally copies tracked source only; its children could not import
that file. Staging it resolved a focused real-four-resource graph case (**1
passed**, 21 filtered cases). The unchanged remaining **281 tests / 12 files**
passed; both affected files were rerun without filters. This setup failure is
separate from the configured-runtime RED above.

The gate's real Worker build passed; the Alchemy CLI startup check passed at
beta.83. Root and Worker lint, **3 lint controls**, both redacted secret scans and
whitespace checks passed. No global runtime update was made, so no final full
Worker suite was run. Configured cases and focused native/fixture evidence are
kept distinct.

## Practical limits

This is reproducible local CODE evidence only. It supplies no hosted Cloudflare
provider, TLS, account, DNS, resource settings, remote RPC or deployment proof.
No credentials/profiles, live State, notifications, drill, or approval authority
were used. The parent fallback policy and persistent custody/storage proof remain
independent and pending. Real manifests, permissions, exclusion, credentials,
approval, Test F, drills, receipt and human acknowledgment remain outstanding.
**#20/#29 stay open; no global MVP-ready claim or production enablement.**
