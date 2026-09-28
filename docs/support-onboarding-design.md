# Support onboarding and credential lifecycle

Decision record for [issue #7](https://github.com/Quick-Release/gq-support/issues/7). It covers how a WordPress installation is connected to its Project repository, how its Installation credential is created, stored, rotated and revoked, and what the site does when it is copied or moved. [ADR 0012](adr/0012-installation-signing-with-site-held-ed25519-keys.md) records the key type. The [security design](support-security-design.md) owns request signing and authorization, and the [API contract](support-api-contract.md) owns the Reporter routes. Terms are defined in [CONTEXT.md](../CONTEXT.md).

## Who does what

| Actor | Can | Cannot |
|---|---|---|
| Operator (GETQUICK staff) | Add or change Repository mappings (by PR), issue Enrollment codes, revoke credentials, check slot status | Act through a WordPress Reporter session |
| Site admin (`gq_support_manage_settings`) | See redacted connection state, enter an Enrollment code, test the connection, disconnect | Choose the repository, see or export the key, approve their own connection |
| Reporter | Nothing on this surface | See the setup page |

All Project repositories live in GETQUICK's GitHub organization, where the GitHub App is installed once ([GitHub App research](https://github.com/Quick-Release/gq-support/issues/8)). Connecting a site never involves GitHub and never needs a client GitHub account.

## Repository mappings as code

Each mapping is an entry in a reviewed config file in `worker/`. Approval is the PR merge, and the history is the git log. It is deployed with Alchemy.

| Field | Notes |
|---|---|
| Slot | Stable name for one installation and environment, e.g. `acme-shop/production` |
| Client | Customer boundary |
| WordPress project | Groups a project's environments |
| Environment | Declared by the operator. This value is authoritative |
| Repository | Numeric GitHub repository ID; the name is only a cached label |
| Default Developer | One GitHub login, assigned to every new Support request for the project. Developers reassign in GitHub |

Runtime bindings are **not** in code: Enrollment code hashes, public keys, key IDs, bound installation ID and origin, and revocations. These live in the service's D1 database ([Cloudflare isolation research](https://github.com/Quick-Release/gq-support/issues/9)), so enrolling or revoking needs no redeploy. Removing a mapping from code rejects its key after the next deploy.

## Operator CLI

A script in `worker/` authenticates with the operator's own Cloudflare credentials and writes to D1. The Worker has **no operator endpoint and no operator login** in the MVP.

- `enroll <slot>` prints a single-use Enrollment code: 128 random bits, shown as grouped base32. It is valid for 30 minutes and bound to that slot. Only its hash is stored.
- `revoke <slot>` revokes the slot's active key immediately.
- `status <slot>` shows the slot's key ID, bound installation ID and origin, when it was enrolled, and whether it is revoked.

## Enrollment exchange

```mermaid
sequenceDiagram
  participant O as Operator
  participant WP as WordPress (setup page or WP-CLI)
  participant W as Worker
  O->>W: CLI: enroll acme-shop/production (writes code hash to D1)
  O-->>WP: Enrollment code, out of band
  WP->>WP: generate Ed25519 key pair, store as pending
  WP->>W: POST /v1/enroll {code, installation_id, origin, public_key, wp_environment_type, plugin_version}, signed with the new key
  W->>W: verify proof of possession; consume code atomically; bind key ID + public key to slot, installation ID and origin; revoke slot's previous key
  W-->>WP: {key_id, environment, connected_at}
  WP->>WP: promote pending key to active; record state
```

- **Retrying an interrupted setup:** repeating the exchange with the same code *and the same public key* is idempotent and returns the same result. The same code with a different public key is rejected. An expired or unknown code returns a generic "code not valid" error.
- **Abuse:** `/v1/enroll` is rate-limited per IP address. Codes carry 128 bits, so guessing is not a practical attack.
- **Environment mismatch:** if the slot's environment differs from `wp_get_environment_type()`, enrollment still completes. The setup page shows a warning, because WordPress reports `production` whenever the type is unset.
- **Signed requests after enrollment** carry the installation ID. The Worker rejects a key used with any other installation ID.

## Rotation, revocation and disconnect

| Action | How | Effect |
|---|---|---|
| Rotate | Operator issues a new code, and the site re-enrolls | New key active; old key revoked in the same step. No overlap window |
| Self-rotation by the site | Not supported | A stolen key cannot be used to lock out the real site |
| Operator revocation | `revoke <slot>` | Immediate. Site shows "Rejected by service"; Reporters get `gq_support_not_configured` |
| Mapping removed from code | PR + deploy | Key rejected after deploy |
| Disconnect (site admin) | Setup page or `wp gq-support disconnect` | Signed "revoke my key" request as a best effort, then local keys deleted whatever the result. Reconnecting needs a new code |
| Repository made public, archived, or App access lost | Detected by the service (GitHub App research) | Mapping suspended; test shows "suspended"; Reporters get `gq_support_not_configured` |

Delivery intents already accepted stay in the service to be reconciled after a revocation (security design). A site can always give up its own access but never raise it.

## Copied, moved and restored sites

The lifecycle already gives a site a new installation ID when `home_url()` changes. When that happens, the plugin also **deletes the local key immediately**. The setup page shows "Disconnected: this site was copied or moved. Ask GETQUICK to reconnect." The Worker's installation-ID binding enforces the same outcome on the service side.

| Case | Result |
|---|---|
| Production copied to staging at a new URL | New installation ID, key deleted; staging must be enrolled separately against its own slot |
| Domain change of the real site | Same as above; operator re-enrolls |
| Backup restored at the same URL | Same installation; keeps working. If the restored key was since rotated or revoked, the service rejects it and the operator re-enrolls |
| Copy at the **same URL** (local host-file copy) | Not detectable; behaves as the same installation. Accepted limitation, documented for developers |
| Multisite | Each site enrolls separately with its own installation ID and key. No network-wide enrollment |

## WordPress configuration schema

| Option | Autoload | Contents | Read when |
|---|---|---|---|
| `gq_support_state` | no | Installation ID, origin, schema version, connection state (`not_connected`, `connected`, `copied_or_moved`, `rejected`), key ID, environment, `connected_at`, last test result and time, capability grant record | Admin screens that need the launcher or setup page; REST routes |
| `gq_support_signing_key` | no | Active Ed25519 private key; a pending key during enrollment | Only when signing a service request |

- The existing `gq_support_installation_id`, `gq_support_installation_origin`, `gq_support_schema_version` and `gq_support_administrator_grants` options migrate into `gq_support_state` in one versioned step. That takes admin screens from 2–4 option queries to one ([performance research](https://github.com/Quick-Release/gq-support/issues/18)).
- `GQ_SUPPORT_SIGNING_KEY` and `GQ_SUPPORT_KEY_ID` constants in `wp-config.php` override the stored key, for sites whose deployment manages secrets. The setup page then shows "Managed by server configuration" and hides Disconnect. `GQ_SUPPORT_SERVICE_URL` is described in the API contract.
- Neither option is registered with `show_in_rest` or exported to the browser. The key is excluded from Site Health debug data and never logged.
- There are no free-form settings, so the setup page does not use `register_setting()`. Its actions (enroll, test, disconnect) are `admin-post.php` handlers that check a nonce and `gq_support_manage_settings`.

## Setup page

`GETQUICK → Support`, with a Settings fallback when GETQUICK Config is absent, is gated by `gq_support_manage_settings`. It shows:

- Connection state and, when relevant, why: copied or moved, rejected by service, suspended, or environment mismatch.
- Environment, connection date, and key fingerprint.
- An Enrollment code field when not connected; **Test connection** and **Disconnect** when connected.

It never shows the repository name, the key, or the service URL.

**Test connection** sends a signed `GET /v1/installation`. It returns the environment, key ID, `connected_at` and mapping state (`active` or `suspended`), and stores the result and its time in `gq_support_state`. It is a bounded request run only on click, never on activation or page load.

## WP-CLI

`wp gq-support connect <code>`, `status`, `test`, `disconnect`, each accepting `--url` for a multisite site. The commands load only under WP-CLI.

## Deactivate and uninstall

- **Deactivate** keeps state and key; reactivating resumes.
- **Uninstall** deletes `gq_support_state` and `gq_support_signing_key`, along with the tracked capability grants, and makes **no remote call**. Offboarding requires the operator to run `revoke <slot>`; that runbook belongs to the observability and rollout ticket (#20). Retention of service-side records is #16's decision.

## Tests to plan

1. Replayed Enrollment code: a used code with a different public key is rejected, while a retry with the same key returns the same binding.
2. An expired, unknown or other slot's code is rejected with the same generic error.
3. A signed request with a valid key but a different installation ID is rejected.
4. Staging clone at a new URL: the key is deleted locally, the state is `copied_or_moved`, and no service call is attempted.
5. Rotation race: after re-enrollment, the old key is rejected at once, even for a request already in flight.
6. Revoked key: the next REST call returns `gq_support_not_configured` and the setup page shows "Rejected by service".
7. Interrupted setup: a pending key survives a failed exchange; a retry completes; an abandoned pending key is replaced by the next attempt.
8. A site admin without `gq_support_manage_settings`, and any Reporter, cannot reach the setup page, its handlers, or the WP-CLI commands' effects through the browser.
9. The key never appears in REST responses, the browser bootstrap, Site Health, or logs, and constants override the stored key.
10. Activation and unrelated pages make no remote calls; option queries on admin screens drop to one.
11. Uninstall removes only plugin options and tracked grants and makes no remote call.
