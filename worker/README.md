# Support Worker enrollment

`src/repository-mappings.ts` is the reviewed Repository mapping registry. It is
intentionally empty until real Slots are approved. Each entry includes Slot,
Client, WordPress project, authoritative environment, numeric GitHub repository
ID and default Developer. Deploy mapping changes through Alchemy. Removing an
entry denies its keys after deployment; request payloads cannot override it.

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
  are bounded to 8 KiB, including bodies without Content-Length.
- The existing PHP canonical string is preserved: `gq-support-v1`, method,
  path/query, key ID, installation ID, epoch-second timestamp, request ID,
  RFC 9530 SHA-256 Content-Digest, separated by newlines without a trailing newline.
  Timestamps allow 5 minutes of skew; signed installation requests consume a
  nonce retained for 10 minutes, with bounded indexed cleanup. #32 still owns
  shared PHP/Worker fixtures and the remaining Reporter authorization surface.
- TLS is required. Unknown, expired and conflicting codes return the same 400
  error; rate limits return 429. Internal failures return generic 503 errors.
  Responses use `Cache-Control: no-store`; errors and request bodies are not logged.

`support.getquick.io` is still a placeholder. No service origin or Cloudflare
provisioning is established by these changes.

## Verification

Alchemy beta.77 requires Effect's `rc.112` Config API. Keep the Worker pins and
the transitive Effect overrides in `pnpm-workspace.yaml` together when upgrading;
`rc.113` renamed the Config constructors and prevents this Alchemy CLI from
starting. CI checks CLI startup as well as the application tests.

```sh
pnpm exec alchemy deploy --help
pnpm typecheck
pnpm exec vitest run test/enrollment.test.ts
pnpm test
```

Tests exercise the HTTP handler and operator command interface against workerd
D1 via Miniflare. They do not access a remote Cloudflare account.

Platform behavior checked against the installed Wrangler and Cloudflare docs:
[D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[primary reads and Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/),
[Ed25519](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), and
[Wrangler D1 queries](https://developers.cloudflare.com/d1/wrangler-commands/#execute).
