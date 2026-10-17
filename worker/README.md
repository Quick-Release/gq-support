# Support Worker enrollment

GitHub App registration, stage secrets, CI deployment, key rotation and incident
response are in the [key custody runbook](../docs/runbooks/github-app-key-custody.md).
Staging/prod Alchemy deployments now require that stage's App credentials and
run a read-only registration preflight before declaring resources. Development
stages do not receive an App key. Both Apps and encrypted CI sources are set up;
staging App-key replacement/revocation passed live authentication checks. Staging
CI deployment, Worker authentication, the custody audit and the Worker-side
replacement/revocation rehearsal have passed; see the runbook for evidence.

`src/repository-mappings.ts` is the reviewed Repository mapping registry. It is
intentionally empty until real Slots are approved. Each entry includes Slot,
Client, WordPress project, authoritative environment, numeric GitHub repository
ID and default Developer. Deploy mapping changes through Alchemy. Removing an
entry denies its keys after deployment; request payloads cannot override it.

## Cloudflare credentials

Use the Tipme account recorded in `AGENTS.md`. The account-owned API token
`GETQUICK Support Alchemy` grants Workers Scripts Write, D1 Write, and Secrets
Store Write within that account. It has no token-management grant and expires
on January 14, 2027. Its token ID is `48f5559e9daad1e3e324771d3708468f`.

The credential is stored at `https://secrets.getquick.io` in the **GQ Support**
project (`01M52TXAYNKP6QGHR8PZYYDEY6`), environment `dev`, as
`CLOUDFLARE_API_TOKEN`; `CLOUDFLARE_ACCOUNT_ID` is stored alongside it.
The `preview` and `prod` Sigillo environments are empty.

The current workstation has an Alchemy profile named `gq-support` configured
with this token. Select it with `--profile gq-support`; choose the deployment
stage explicitly when a deployment is authorized. This machine-local profile
is not included in a checkout. On another workstation, inject the credential
from Sigillo and configure the profile with Alchemy's `--set apiToken=env:CLOUDFLARE_API_TOKEN`
input. Keep values out of command arguments and logs.

The token manager remains in EKIS's Sigillo `ops` environment as
`CLOUDFLARE_TOKEN_MANAGER_API_TOKEN`. Use it only to mint or rotate the Support
credential; application and deployment processes receive the child token.

## Operator commands

Use the database ID from the intended Alchemy stage's outputs and the GETQUICK
Cloudflare account ID. The CLI requires both explicitly and always targets
remote D1. Run from `worker/` using your own Wrangler login or Cloudflare
credentials with D1 read/write access; no operator credential is bound to the
Worker and there is no operator HTTP endpoint.

```sh
pnpm exec wrangler login
pnpm operator enroll shop/production --account-id <account-id> --database-id <database-id>
pnpm operator status shop/production --account-id <account-id> --database-id <database-id>
pnpm operator revoke shop/production --account-id <account-id> --database-id <database-id>
```

`enroll` prints a grouped base32 code with 128 random bits, valid for 30 minutes.
Deliver it out of band to the site's admin. Only its SHA-256 hash enters D1.
`status` shows the most recent key's ID, installation ID, origin, enrollment time
and revocation time; no public or private key material is printed. A new code
does not revoke a working installation until the signed enrollment succeeds.

`revoke` records the active key in `revocations.json` **before** revoking it in D1.
Commit this append-only logical ledger after every revocation. The deployed
Worker also denies listed keys, so deploying the ledger protects those operator
revocations after a D1 restore (ADR 0016). A failed D1 write can safely be retried.
Concurrent revoke commands in one checkout are refused by `revocations.lock`;
if a process dies, inspect its log and remove the stale lock before retrying.
Do not remove records. Coordinate ledger changes across operator checkouts.

The full restore gate, including runtime rotation/self-revocation history,
restore epochs and suppression replay, remains rollout work in #20; this CLI
ledger alone is not evidence that a restored database is safe to serve traffic.

## HTTP behavior

- `POST /v1/enroll` matches the existing WordPress signer's Ed25519 proof and
  body format. The code alone determines the Slot and environment. The signed
  installation ID must match the body. Client-selected mapping fields are denied.
- Code consumption, previous-key revocation and new binding are one D1 batch.
  Every dependent write is conditional on winning consumption. Concurrent retries
  with the same public key return the original binding; a different key,
  installation ID or origin is rejected. Retrying an old code never revives a
  revoked key. A consumed code can complete its same-binding retry after expiry.
- `GET /v1/installation` requires a signed request and returns only `key_id`,
  `environment`, `connected_at` and `mapping_state` (`active` or `suspended`).
- `DELETE /v1/installation` requires a signed request and revokes only that key.
  Signature verification is followed by an atomic active-key/replay check, so
  revocation during verification wins. Status reads use primary D1 without a
  cross-request key cache or read-replica session.
- Enrollment is limited to 10 attempts per IP per fixed 10-minute window, before
  proof verification. The edge's `CF-Connecting-IP` is hashed; raw IPs are not
  stored. A missing edge IP is denied and counter failure returns 503. Requests
  are bounded to 8 KiB (creates to 128 KiB), including bodies without Content-Length.
- The existing PHP canonical string is preserved: `gq-support-v1`, method,
  path/query, key ID, installation ID, epoch-second timestamp, request ID,
  RFC 9530 SHA-256 Content-Digest, separated by newlines without a trailing newline.
  Timestamps allow 5 minutes of skew; signed installation requests consume a
  nonce retained for 10 minutes, with bounded indexed cleanup.
  `contract/fixtures/signing.json` pins this string for PHP and the Worker.
- `POST /v1/requests`, `GET /v1/requests` and `GET /v1/requests/{id}` require a
  signed request and an attested `reporter_subject` and `scope`. The key selects
  the Slot; Slot-owned rows are reached only through `createStorageFor`. A create
  records the request, its `create` intent and the Reporter and Slot quota debits
  in one D1 batch and returns `202 accepted-pending`. A same-key retry returns
  the existing request (`201` once delivered) without a debit; another body is
  409. Quotas, scope and failure codes are listed in the
  [security design](../docs/support-security-design.md#implemented-installation-authentication-32).
  Every call also spends a request budget (120 per Reporter and 600 per Slot per
  ten minutes). Delivery to GitHub is not implemented yet: intents stay `pending`.
- TLS is required. Unknown, expired and conflicting codes return the same 400
  error; rate limits return 429. Internal failures return generic 503 errors.
  Responses use `Cache-Control: no-store`; errors and request bodies are not logged.

`support.getquick.io` is still a placeholder. No service origin or Cloudflare
provisioning is established by these changes.

## Verification

The Worker pins Alchemy `2.0.0-beta.83` and Effect / `@effect/platform-node`
`4.0.5`. Its Vite 8 and Vitest 5 development dependencies satisfy Alchemy and
Effect's peer requirements. Effect 4's HTTP modules use the `effect/http/*`
exports. The old `rc.112` transitive overrides are no longer needed.
CI checks CLI startup as well as the application tests.

```sh
pnpm exec alchemy deploy --help
pnpm typecheck
pnpm exec vitest run test/enrollment.test.ts
pnpm test
pnpm load-test   # about 90 s; LOAD_SLOTS / LOAD_REPORTERS / LOAD_CONCURRENCY scale it
```

Tests exercise the HTTP handler and operator command interface against workerd
D1 via Miniflare. They do not access a remote Cloudflare account.

Platform behavior checked against the installed Wrangler and Cloudflare docs:
[D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[primary reads and Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/),
[Ed25519](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), and
[Wrangler D1 queries](https://developers.cloudflare.com/d1/wrangler-commands/#execute).

### Support issue provider operations

`src/support-issues.ts` exposes `supportIssues.create`, `repair` and `reconcile`
for the delivery scheduler described in `docs/support-delivery-design.md` (#38).
These operations do not dispatch intake records or own installation permits.

- Construct `SupportIssueIntent` from trusted, pinned operational records. The
  title is intake's derived title; the label and default Developer are approved
  mapping configuration. Attribution takes only an environment, opaque
  installation reference and Reporter pseudonym (`rs_…`), never a raw subject,
  username, email or Submission ID. The versioned template fences Reporter text
  with a tilde run longer than any in that text; context fields remain omitted.
- Persist authorization/attempt ownership **before** calling `create` once.
  Persist the returned GitHub identity even when metadata is missing. An
  `OutcomeUnknown` goes to reconciliation, never a generic mutation retry.
  The scheduler must recheck execution deadlines and erasure/suppression before
  dispatch; provider operations cannot provide durable authorization themselves.
- Call `repair` with that trusted identity under the installation mutation budget.
  It reads current metadata and sends at most one additive POST. `RepairPending`
  needs a later paced repair; `Repaired` changes no delivery identity. A repair
  failure leaves the successful delivery intact. Gateway errors retain rate
  feedback. Silent provider drops are detected by the final read.
- `reconcile` reads one creator-filtered, creation-descending page (100 issues)
  per call, plus the preceding page on resumption to verify its boundary has
  not shifted through insertion, deletion or transfer. Persist a `Continue.progress` checkpoint with the intent and pass it
  to the next call. Checkpoints hold only scope, pagination and candidate
  identities, never Reporter text. An error preserves the previous checkpoint;
  retry that read under the provider budget. A shifted/inconclusive scan needs a
  fresh scan at the next scheduled check. Never interpret either as absence.
- Supply the recorded attempt's bounded dispatch window and configured App bot
  login. Before erasure, supply the exact original template/title as
  `expectedIssue` (reconstruct it with `supportIssues.prepare`); after purging text use `null` with `erasurePending`. A known
  GitHub identity, if any, must also match. Repository identity is checked live.
  A single candidate is re-read after completing the scan; changed content or
  identity requires review. A collaborator can copy even the entire template:
  this is correlation evidence, not authentication. Before committing a result,
  the scheduler must conditionally verify request ownership and ensure the
  returned identity is not already bound to another request.
- `Unknown` always remains outcome-unknown, including complete empty scans.
  `alert: true` signals suspicious or multiple matches for immediate Operator
  review; it sends no notification. No operation selects a duplicate, closes,
  deletes or recreates an issue. Scheduling (1/5/15/60 minutes, then hourly),
  unresolved alerts after 15 minutes, the 24-hour review deadline and late
  positive binding belong to the delivery scheduler, not this module.
- An erased discovery returns `RedactionRequired` with an identity, never a
  create or repair. Route it to the privacy redaction workflow (#46); when
  original text was purged, `reviewTitle` requires Operator title review. This
  signal alone does not claim erasure is complete. Multiple/suspicious erased
  discoveries still require review, with candidate identities for cleanup.
