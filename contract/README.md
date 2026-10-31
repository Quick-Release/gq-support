# Support v1 contract fixtures

These JSON cases belong to both implementations of [the API contract](../docs/support-api-contract.md). They contain no credentials or customer data. The WordPress PHPUnit suite reads every case, and the Worker suite reads `context.json`, `create.json`, `resources.json`, `signing.json`, `status-change.json`, `update-signing.json` and `update.json` rather than copying expected values.

- `context.json`: the Report context schema ([context design](../docs/support-context-design.md)) and its shared limits. Each case is a submitted context and, when valid, its canonical serialization; an invalid one has no `canonical`. Both sides normalize every case, and both create routes accept the valid ones and reject the rest. WordPress also attaches a review envelope for the case; it never forwards one.

- `create.json`: browser payload, trailing JSON whitespace (`padding`, in bytes), and expected HTTP status. Serialize compactly as UTF-8 without escaping Unicode or slashes, then append the padding. This makes the 32 KiB boundary exact. Field lengths are Unicode code points after trimming.
- `list.json`: pagination, cursor, and scope boundaries.
- `local-errors.json`: browser session, grant, connection and local fail-safe (`GQ_SUPPORT_DISABLED`) failures at WordPress. `integration/fail-safe.php` runs the fail-safe case in its own process, because the constant cannot be undefined.
- `resources.json`: public resource, whether its delivery/status pair is valid, and the create HTTP status. Valid cases are exercised as a resource, a list item, and a create acknowledgment. The WordPress test adapter adds its own trusted ownership metadata before forwarding the response, and WordPress adds `own` to what it returns; the fixtures hold the Worker's shape, without `own`.
- `status-change.json`: browser close/reopen payloads (`payloads`) and the `status_change` resource field (`changes`), each valid or not. WordPress forwards only valid payloads, with the attested identity, and returns only a valid field; the Worker accepts the valid payloads once the create is delivered. ADR 0020.
- `signing.json`: a test-only Ed25519 key and signed requests with their exact canonical string, `Content-Digest` and signature. Each case names its `scheme`: `gq-support-v2` signs `GQ-Support-Plugin-Version`; `gq-support-v1` is what plugins before #141 sent. PHPUnit re-signs each v2 case with `GQ_Support_Signer`, which writes only v2; the Worker verifies every case, rejects every single-field mutation, and trusts a version only under v2. The key signs nothing else.
- `update-signing.json`: native update requests (#142) signed by an update key with the same test-only key: the `gq-support-update-v1` canonical string, which signs the installed version and the download grant header. `GQ_Support_Updater::headers()` reproduces each case and the Worker verifies it under `UPDATE_SIGNATURE`; the update key is never an Installation key.
- `update.json`: update metadata bodies, valid or not. WordPress caches only a valid offer, whose package path is the approved version and digest at the configured service; the Worker's metadata responses have exactly the valid shape.
- `errors.json`: upstream HTTP status, create/read browser error codes, and browser status (read-time 504 maps to 503). Worker authentication failures intentionally become 503, distinct from browser authentication failures tested in `integration/access.php`.

Run against the disposable DDEV WordPress site with the plugin active:

```sh
ddev exec --dir /var/www/html/plugin composer install
ddev wp --path=.test-site eval-file plugin/tests/contract/run.php
```

`plugin/tests/integration/run.sh` includes this suite. It uses real WordPress routes, cookie/nonce authorization, Reporter subjects, and an injected `pre_http_request` service boundary. It creates a temporary Reporter and restores the original connection state and key after each test. Use only a disposable database. Browser behavior is covered by `plugin/tests/browser/submission.spec.ts` with the REST service stubbed.

These tests verify the plugin contract, transport, and reconciliation behavior. Durable acceptance, idempotent persistence and signing verification are tested in `worker/test/`; GitHub delivery is not implemented yet.
