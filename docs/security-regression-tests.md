# Adversarial security regression gates

Issue #33 extends the existing test harnesses. The numbered cases below trace to
the [implementation-ready checklist](support-security-design.md#implementation-ready-security-tests).
These tests use disposable WordPress users, generated keys, local workerd-backed
D1 and stubbed providers. They need no production credentials, Client data or
real GitHub issues.

## Commands and CI ownership

From the repository root:

```sh
pnpm --filter gq-support-worker typecheck
pnpm --filter gq-support-worker test
pnpm build:app
bash plugin/tests/integration/run.sh
GQ_SUPPORT_BROWSER_SUITE=acceptance pnpm test:browser
bash plugin/tests/integration/multisite.sh
```

Run the browser suite before converting the disposable single-site installation
to multisite. `run.sh` includes the PHP contract suite and both generated and
constants-backed signing-key custody probes. `multisite.sh` repeats REST access
checks and both custody probes on an independently enrolled subsite. To repeat a
custody probe, run `ddev wp --path=.test-site eval-file
plugin/tests/integration/key-custody.php generated` (or `constants`), in a separate
process for each source, on an active installation with GETQUICK Design active.

The existing `Worker typecheck + tests` job runs all Worker cases. The WordPress
runtime cells run `run.sh`, browser acceptance and multisite through
`scripts/ci/run-cell.sh`; #68 owns their runtime matrix and required-check
aggregation. No additional workflow or competing test framework is needed.

## Checklist evidence

1. **Login, nonce and per-operation permission.**
   `plugin/tests/integration/access.php` dispatches list, create, read and status
   changes with an invalid nonce, no grant, a destroyed cookie session and after
   logout. Every denial must precede downstream HTTP. It checks registered
   permission callbacks. `plugin/tests/browser/session.spec.ts` verifies real HTTP
   cookie/nonce errors and private, no-store responses.
2. **Reporter ownership, receipts and cached projections.**
   `worker/test/support-requests.test.ts` uses two Reporters on A, B in the same
   Client/repository and C in another Client. It checks own lists/reads,
   indistinguishable missing/foreign IDs, scoped Submission IDs and cursor
   tampering. `access.php` switches between two real WordPress Reporters after
   warming a read and rejects foreign list/read payloads from the service.
   Receipt/cache endpoints are absent and tested as denied, rather than treated
   as an alternate authority. `requests.spec.ts` clears cached projections after
   session changes and grant revocation.
3. **Installation isolation, including multisite.**
   The same Worker fixture denies B/C even with matching subjects and site scope.
   `access.php`, repeated by `multisite.sh`, uses the same network user ID on a
   second site and requires a distinct Reporter subject. Super Admin cannot
   replace an explicit grant or site membership.
4. **Forged authority.**
   `access.php` rejects browser authority overrides before HTTP;
   `worker/test/support-requests.test.ts` rejects forged Client, Slot, repository
   and installation fields and confines a stolen key to its own installation.
   `worker/test/enrollment.test.ts` rejects setup mapping overrides. An Origin
   header is never authority: forged Origin cannot change the verified key's
   scope, and unsigned requests still deny.
5. **Revocation and identity reuse.**
   `access.php` tests immediate grant revocation, read-only site visibility,
   removed multisite membership on every operation, account deletion and a
   replacement account with the same login. `run.sh` checks settings handlers
   deny Reporters and administrators without the settings grant. Status mutation
   authorization is also covered by `worker/test/status-changes.test.ts` and
   `plugin/tests/browser/status-change.spec.ts` (ADR 0020 supersedes the older
   checklist's read-only status boundary).
6. **Abandoned draft.**
   `session.spec.ts` and `recovery.spec.ts` test account switch, re-login, revoked
   grants, explicit retry after nonce refresh, no persistent draft storage,
   stopping uncertain-submission checks, and clearing on back/forward-cache
   navigation. `recovery.spec.ts` also exercises Copy draft and its manual
   selection fallback (the implemented recovery affordance).
7. **Signing, replay, outages and rotation.**
   `worker/test/signing.test.ts` pins the PHP signature fixture.
   `support-requests.test.ts` tampers with method, path, query, body, timestamp,
   request ID, key ID and signature at the HTTP boundary, tests correctly signed
   expired/future requests, and asserts no additional request/intent is accepted.
   `enrollment.test.ts` covers TLS, replay-store failure, replay, revocation during
   verification, failed rotation retaining the active key and permitting retry,
   and immediate revocation after successful rotation. Rotation races are tested
   in `support-requests.test.ts`; there is no old-key overlap (ADR 0012).
8. **Creation idempotency and honest outcomes.**
   `support-requests.test.ts` covers concurrent retries and ambiguous commits;
   `worker/test/delivery.test.ts` and `support-issues.test.ts` cover unknown GitHub
   outcomes and reconciliation without a blind second create. Browser
   `recovery.spec.ts` distinguishes received, delivered, failed and unknown.
9. **Limits, failure and key custody (isolation G).**
   `support-requests.test.ts` tests payload limits, atomic Reporter/Slot quotas,
   quota-store failure and read-counter availability. It captures console output
   and scans every service table and list/read/status response for generated
   installation private material, while requiring the public verification key to
   remain stored. `key-custody.php` captures PHP error logs and output during
   generated/constants-backed enrollment, signing and transport failure, and
   checks transport payloads, state, Site Health, REST settings and bootstrap for
   raw/base64/hex private keys and seeds. The local WordPress key option is
   intentional; service-side plaintext private-key storage is forbidden.
   `worker/test/github-gateway.test.ts` checks generated App keys, JWTs and
   installation tokens never enter logs/failures; `key-custody-scan.test.ts`
   checks artifact/state scanning, including encoded and historical App keys.
10. **No proxy to comments, attachments or internal issues; inert text.**
    `support-requests.test.ts` denies comment, receipt, cache, direct issue-number
    and guessed signed-attachment paths on A/B/C with no-store errors.
    `access.php` also rejects deferred WordPress paths and strips service-only
    fields from the projection. Browser `requests.spec.ts` verifies HTML/script
    and malicious Markdown stay text, with no created script/image/link nodes
    or attacker-image request. `support-issues.test.ts` tests the inert GitHub
    template; status synchronization tests keep internal GitHub edits out of
    Submitted text.
11. **Lifecycle and unrelated requests.**
    Existing `lifecycle.php`, `connection.php`, `run.sh`, `multisite.sh` and
    `plugin/tests/browser/performance.spec.ts` cover migrations preserving
    revocations, per-site initialization, deactivation/uninstall grant boundaries,
    URL clones and zero support HTTP on unrelated requests. #70 owns installed
    release ZIP lifecycle, archive exclusions and digest-verified promotion;
    #69 owns general source/history/bundle secret scans. Reuse those release
    gates and the [CI release checklist](research/ci-compatibility-and-security-tests.md).

Privacy export/erasure remains owned by #16. Provider sandbox smoke tests remain
manual/trusted workflows (`github-app-spike.yml`, `github-webhook-spike.yml`);
untrusted pull-request CI uses only deterministic local fixtures and fakes.
