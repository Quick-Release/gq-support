# GitHub webhook receiver

Receiver core: [#55](https://github.com/Quick-Release/gq-support/issues/55),
part of [#50](https://github.com/Quick-Release/gq-support/issues/50).

The existing Support Worker accepts `POST /v1/github/webhooks` outside
WordPress installation authentication. Only `application/json` is accepted
(including a charset parameter). Event, delivery and a strict lowercase
`sha256=` signature are required. The receiver counts raw bytes while streaming,
verifies HMAC-SHA256 using `crypto.subtle.verify`, then parses UTF-8 JSON and
checks the hook target type (`integration`) and this stage's numeric App ID.
The App ID is distinct from the App's client ID and its installation ID.

The event/action allowlist is empty: all verified, correctly targeted JSON
deliveries return an empty `204`. There is no handler, gateway call, payload
storage or D1 access. Invalid deliveries return an empty `401`, increment the
Effect `github_webhook_rejections_total` counter, and log only a fixed message
and a reason class (`configuration`, `content_type`, `headers`, `body_size`,
`body_read`, `signature`, `json`, `target`). No payload, signature, delivery ID,
App secret, raw exception or arbitrary header is logged. Counter export/alert
routing belongs to #20; the structured rejection log also supports log counts.

The current cap is **1 MiB**, a provisional bound, enforced even without
`Content-Length` or when that header lies. It is not yet derived from real
stage deliveries. GitHub documents a provider cap of 25 MB, but this receiver
deliberately has a lower bound. Measure the events below before activation and
revise `GITHUB_WEBHOOK_BODY_BYTES` if needed. See the
[payload and header reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
and [signature validation guide](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## Deployment and activation

Use the separate staging/prod Apps and the Tipme Cloudflare account described
in the [App custody runbook](github-app-key-custody.md). Each GitHub Environment
needs the public variable `SUPPORT_GITHUB_APP_ID` and encrypted secrets
`SUPPORT_GITHUB_WEBHOOK_SECRET` and, during rotation only,
`SUPPORT_GITHUB_WEBHOOK_PREVIOUS_SECRET`. Choose an independent high-entropy
webhook secret for each stage. Never reuse the App private key or another
stage's secret. Store the same current webhook secret in that App's webhook
settings. Do not place it in a checked-in file, command argument or log.

The deploy workflow maps these names to `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`
and `GITHUB_WEBHOOK_PREVIOUS_SECRET`. Before declaring resources, Alchemy
authenticates the App and checks that its numeric ID matches the configured
ID and that the current webhook secret exists. The existing apply-only
`GitHubAppSecret` provider uploads the two HMAC bindings as Worker `secret_text`
after each Worker deployment. Missing previous configuration explicitly removes
that binding, so closing a rotation window does not leave a stale key accepted.
Only public App metadata enters Alchemy state. The runtime imports each
configured key once per isolate, lazily on the first structurally valid delivery.

Deploy the verified receiver before enabling delivery. Replace the reserved
placeholder URL in App settings with the stage Worker's HTTPS URL plus
`/v1/github/webhooks`, keep TLS verification enabled, and select JSON delivery.
Complete the staging evidence below before enabling production. This core
acknowledges events without changing Support status; the sweep remains the
source of recovery until later handlers land.

## Rotation

1. Put the outgoing secret in the stage's encrypted previous-secret source;
   put a new independently generated secret in its current-secret source.
   Deploy so the Worker accepts both before changing the App's webhook secret.
2. Change the App's webhook secret to the new current value. Send a fresh
   staging delivery and explicitly redeliver a pre-rotation one. Verify which
   secret signs the redelivery in memory; record only the classification
   `current` or `previous`, never the signature or secret.
3. Keep overlap until queued/in-flight deliveries and the chosen operational
   redelivery window are covered. Do not infer redelivery signing behavior from
   the local two-key test.
4. Remove the stage's encrypted previous-secret source and deploy again.
   The provider deletes `GITHUB_WEBHOOK_PREVIOUS_SECRET`; the new isolate then
   imports only the current key. Confirm a current delivery passes and an old
   signature fails. Do not retain old secrets in files or artifacts.

## Spike evidence and outstanding live checks

Local evidence (2026-10-18): the request-boundary tests send signed raw payloads
through Effect's `fromWeb` / `toWebResult` conversion, as used by Alchemy's
`Cloudflare/Workers/HttpServer.ts` adapter. UTF-8, combining characters, emoji,
CRLF and JSON whitespace verify byte-for-byte; Unicode normalization without
resigning fails. The installed Effect 4.0.5 conversion preserves the original
Web Request when available. Streaming over-limit bodies are cancelled without
waiting for the producer. GitHub's independently published `Hello, World!`
vector passes HMAC and reaches the expected JSON rejection (the published
payload is not JSON). Tampered bytes fail HMAC before parsing.

Not yet observed against this stage's real App:

- Confirm the live hook target type and ID, including `ping`, `issues`,
  `installation` and `installation_repositories`. The expected type is
  `integration`; the public documentation describes these headers without
  enumerating all type values. Record only the type and numeric App ID.
- Measure exact UTF-8 byte lengths of real issue and installation payloads,
  including long issue text and a large selected-repository installation.
  Record event/action, byte length and the maximum per event, never content.
  Use those measurements and headroom to finalize the provisional cap.
- Rotate and redeliver a pre-rotation delivery; record whether GitHub used the
  current or previous secret. Repeat after removing the previous binding.

The implementation session had no stage App or webhook secrets in its process
environment. No stage deployment, App configuration change, actual payload
measurement or rotation/redelivery rehearsal is claimed. Keep #55's live-spike
acceptance item open until these observations are recorded in the issue.
