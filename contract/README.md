# Support v1 contract fixtures

These JSON cases belong to both implementations of [the API contract](../docs/support-api-contract.md). They contain no credentials or customer data. The WordPress PHPUnit suite reads every case, and the Worker suite reads `create.json`, `resources.json` and `signing.json` rather than copying expected values.

- `create.json`: browser payload, trailing JSON whitespace (`padding`, in bytes), and expected HTTP status. Serialize compactly as UTF-8 without escaping Unicode or slashes, then append the padding. This makes the 32 KiB boundary exact. Field lengths are Unicode code points after trimming.
- `list.json`: pagination, cursor, and scope boundaries.
- `local-errors.json`: browser session, grant, and connection failures at WordPress.
- `resources.json`: public resource, whether its delivery/status pair is valid, and the create HTTP status. Valid cases are exercised as a resource, a list item, and a create acknowledgment. The WordPress test adapter adds its own trusted ownership metadata before forwarding the response.
- `signing.json`: a test-only Ed25519 key and signed requests with their exact canonical string, `Content-Digest` and signature. PHPUnit re-signs each case with `GQ_Support_Signer`; the Worker verifies each one and rejects every single-field mutation. The key signs nothing else.
- `errors.json`: upstream HTTP status, create/read browser error codes, and browser status (read-time 504 maps to 503). Worker authentication failures intentionally become 503, distinct from browser authentication failures tested in `integration/access.php`.

Run against the disposable DDEV WordPress site with the plugin active:

```sh
ddev exec --dir /var/www/html/plugin composer install
ddev wp --path=.test-site eval-file plugin/tests/contract/run.php
```

`plugin/tests/integration/run.sh` includes this suite. It uses real WordPress routes, cookie/nonce authorization, Reporter subjects, and an injected `pre_http_request` service boundary. It creates a temporary Reporter and restores the original connection state and key after each test. Use only a disposable database. Browser behavior is covered by `plugin/tests/browser/submission.spec.ts` with the REST service stubbed.

These tests verify the plugin contract, transport, and reconciliation behavior. Durable acceptance, idempotent persistence and signing verification are tested in `worker/test/`; GitHub delivery is not implemented yet.
