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

The cap is **1 MiB**, enforced even without `Content-Length` or when that header
lies. Staging measured an issue payload with substantial synthetic Unicode text
at **75,766 bytes**, and installation lifecycle payloads up to **3,009 bytes**.
The cap gives roughly 13.8x headroom over the largest observed payload. Those
observations cover the current single-repository sandbox installation, not an
unbounded repository selection or every possible GitHub payload. Revisit the cap
when installation size or subscribed events expand. GitHub documents a provider
cap of 25 MB; this service keeps a lower bound and the sweep repairs missed hints.
See the
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

The live checklist (completion evidence follows below):

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

The initial implementation session had no stage App or webhook secrets in its
process environment. The later automated rollout uses the existing CI-held App
key, with live observations distinguished from those local tests below.

## Automated staging procedure

The operator runner uses the existing authenticated `gh` CLI. Run from the repo
root after the automation is on `main`. It never downloads the App private key.
GitHub Actions uses the existing encrypted staging source for App JWTs. Random
HMAC secrets are sent directly to `gh secret set` on stdin and never written to
the progress file, arguments or console. The progress file contains only public
run URLs, delivery IDs, status codes, byte counts and key classifications.

1. Run `python3 scripts/github-webhook-staging.py setup`. This sets staging's
   public App ID `5355960`, creates a random current secret and an encrypted
   duplicate previous source, enables temporary staging diagnostics, deploys
   through Alchemy, configures the App's JSON webhook URL/secret/TLS through its
   API, and checks current/wrong-stage signatures. The duplicate source lets
   rotation retain the original secret without retrieving encrypted CI values.
   Setup refuses to overwrite an existing current secret without its original
   progress file. The default progress file is `/tmp/gq-support-55.json`;
   use `--state <path>` consistently to keep another location.
2. In the staging App's
   [General settings](https://github.com/organizations/Quick-Release/settings/apps/getquick-support-staging),
   check **Active**, verify the configured Worker URL and enabled SSL
   verification, then choose **Save changes**. Do not replace the secret field.
   The browser agent can perform this when the session is authenticated; the
   App webhook configuration API exposes URL/content type/secret/TLS but not
   the Active toggle. Do not activate the production App.
3. Run `python3 scripts/github-webhook-staging.py exercise`. It verifies that
   repository `1424354303` is the private sandbox, creates a synthetic Unicode
   issue, closes/reopens/closes it, and suspends/restores only staging's sandbox
   installation `172696674` to produce lifecycle events. The restoration runs
   even when suspension fails. It collects real delivery headers and their
   actual receiver byte counts and saves a pre-rotation delivery ID.
4. Run `python3 scripts/github-webhook-staging.py rotate`. It creates a new
   current secret, keeps the old encrypted previous source, deploys both, tests
   their acceptance, then updates GitHub's webhook secret to the new current
   value. This order avoids a gap between producer and receiver configurations.
5. Run `python3 scripts/github-webhook-staging.py redeliver`. It redelivers the
   saved pre-rotation event and records the receiver's `current`/`previous`
   classification. GitHub redelivery is asynchronous: if the runner reports no
   completed attempt yet, run `collect` before retrying and inspect the saved
   workflow/delivery IDs. This is a deliberate rehearsal, not an automatic
   production redelivery service.
6. Run `python3 scripts/github-webhook-staging.py retire`. A CI job deploys with
   the previous runtime secret absent while retaining its encrypted source in
   that job's memory. It proves a signature made with the old key gets `401`
   and the new key gets `204`, then the local runner deletes the previous CI
   source. Do not dispatch another deployment between these steps. Run
   `python3 scripts/github-webhook-staging.py redeliver` again afterward to
   observe a real pre-rotation GitHub delivery after the old binding is gone.
7. Run `python3 scripts/github-webhook-staging.py finish`. It requires verified
   issue and installation byte measurements, disables temporary diagnostics,
   deploys again, and repeats current/wrong-stage checks. This final deployment
   also runs the normal App-key custody audit. Production remains unchanged.
8. Run `python3 scripts/github-webhook-staging.py report`. Record the workflow
   URLs, real target headers, pre-rotation redelivery signer, rejection after
   retirement, and maximum raw payload bytes in #55. Compare those maxima and
   headroom with the cap, document its final rationale, and close the issue once
   every acceptance item has evidence.

Each workflow wait is bounded to 20 minutes and prints its owned run URL.
On failure, stop and inspect that URL before retrying; a timed-out workflow may
still be active. Do not rerun setup with a new state path to bypass its guard.
If a retirement run succeeded but deleting its encrypted source failed, remove
`SUPPORT_GITHUB_WEBHOOK_PREVIOUS_SECRET` from the staging Environment before
another normal deployment, or that deployment would restore the old binding.

Temporary diagnostics are gated by both the staging slug and a disabled-by-default
config flag. Only successful verified responses include `X-GQ-Webhook-Bytes`
(the exact raw byte count) and `X-GQ-Webhook-Key` (`current` or `previous`). The
spike workflow reads these from GitHub's stored delivery response headers. It
never estimates raw bytes by reserializing GitHub's parsed JSON and never prints
payloads, signatures, arbitrary response headers or secrets. These diagnostic
headers are disabled again by the final deployment.
