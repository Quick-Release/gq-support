# Support security design

Decision record for [issue #4](https://github.com/Quick-Release/gq-support/issues/4). [ADR 0009](adr/0009-project-repository-intake-and-reporter-scoped-projection.md) supersedes older proposals for dedicated Support repositories and client-visible GitHub comments: reports go into the project's existing repository, and the WordPress projection contains submitted issue text and status only. [CONTEXT.md](../CONTEXT.md) defines the domain terms used here. This is a design and test contract, not a claim that the scaffold implements these controls.

## Trust boundaries and authority

```text
Browser (untrusted fields)
  -- same-site WordPress cookie + X-WP-Nonce: wp_rest --> WordPress REST
  -- per-route capabilities + current site membership + resource checks --> WP server
  -- TLS + per-installation signed request --> Worker
  -- verified installation key resolves Client, environment, project repository --> operational records
  -- scoped GitHub App access --> project's existing private repository
```

The nonce defends the WordPress REST cookie-authentication boundary against CSRF; it is not authorization and never goes to the Worker. WordPress determines the current user and capabilities on **each** browser request. The Worker verifies the installation and object scope independently, but cannot independently prove which human is logged into WordPress. A compromised WordPress server can impersonate Reporters and perform permitted actions **within its own approved installation scope**. It cannot choose another Client, installation, environment, or repository by changing a browser field, signed body, hostname, or `Origin`. Protecting against arbitrary content submitted by a compromised site within its own scope is outside this boundary; limit blast radius by installation and rate.

The Worker never exposes a browser-facing Reporter session or direct object URL. Operator provisioning/administration has separate authentication and no bypass via WordPress settings or installation credentials. A WordPress user ID alone is not globally unique: on first authorized use WordPress generates a random immutable Reporter subject, stored in site-local user metadata. The service keys ownership by verified installation identity plus subject. WordPress maps that subject to the *current* authenticated user; never derive it from email/username or transfer it to a replacement account. Use the service's historical association, subject to #16's retention/erasure rules, after a user is deleted. Revocation applies on the next REST request, not to a previously accepted delivery intent.

## Capabilities and access matrix

Custom capabilities: `gq_support_submit_requests`, `gq_support_view_site_requests`, `gq_support_manage_settings`. `submit_requests` includes listing/reading **own** requests and receipts; `view_site_requests` adds **read-only** access to all requests and receipts associated with that installation. Neither implies the other. No WordPress close/reopen, reply, or attachment ability is enabled in the current issue-intake slice; ADR 0009 leaves status mutation unresolved, and comments remain internal. Deny any such routes until separately designed and approved.

| Actor / effective grant | Submit report | Own list/read/receipt | Installation-wide list/read/receipt | Setup state / request connection | Approve mapping / issue credentials / GitHub |
| --- | --- | --- | --- | --- | --- |
| Reporter (`submit_requests`) | Yes, on originating installation | Yes | No | No | No |
| Site-wide Support manager (`view_site_requests` only) | No, unless separately granted submit | Own only if also granted submit | Yes, originating installation only | No | No |
| Administrator (initial grant: submit + manage settings) | Yes | Yes | No, unless explicitly granted view-site | Yes, redacted; initiate request only | No |
| Installation service credential | Server-to-server calls for originating installation only | Attested subject, fresh WordPress check required | Only on a fresh, attested view-site authorization from that installation | No operator access | No |
| Operator (separately authenticated) | Not via a WordPress Reporter session | Only via an explicitly audited operator workflow | Only via an explicitly audited operator workflow | Yes | Yes, limited to approved project mapping |
| Anonymous / ungranted / other installation | No | No | No | No | No |

A Support manager's ordinary grant is site-local. Cross-installation visibility is **deferred**: it would require an independently authenticated, operator-approved and revocable service-side manager identity with an enumerated installation set. Matching WordPress names, emails, roles, or numeric IDs is not proof; even a WordPress login held by such a manager cannot authorize cross-installation Worker requests. WordPress→Worker calls are always confined to their originating installation. Network activation, Super Admin status, and a Client-level repository mapping do not grant cross-installation reads. In multisite, initialize IDs, subjects, and capabilities per site and check membership on each request.

Initial installation grants submit + manage-settings capabilities to the Administrator role only. Other role/user grants and site-wide visibility are explicit. Being logged in, being an Editor, or holding `manage_options` alone does not authorize reporting or management. Record versioned capability migration state so normal upgrades do not undo intentional revocation; a new capability may be granted by a dedicated migration to the intended Administrator role, but do not repeatedly re-grant existing ones. Deactivation preserves grants; uninstall removes only plugin-owned grants it actually added (including migrated grants), without removing independently granted permissions or altering unrelated role capabilities. A removed capability or site membership takes effect on the next REST request, including requests from an open widget.

For **every** list, read, receipt and cached projection lookup, resolve the object by internal request/receipt identity and verify installation plus either the originating subject or the fresh, installation-wide view grant. Do not rely on a GitHub issue number, label, repository, URL, opaque ID, or user-supplied subject. The same checks must precede any future message operation or attachment metadata/byte download, including signed download URL issuance; attachments are deferred and denied by default. No cross-site read within the same Client, even if both sites share a repository. Render only client-allowlisted fields, never GitHub comments, internal labels, assignment, repository URLs granting access, or raw provider payloads.

## Browser → WordPress sequence

```mermaid
sequenceDiagram
  participant B as Browser
  participant WP as WordPress REST
  participant W as Worker
  B->>WP: same-site cookie + X-WP-Nonce (wp_rest) + user input
  WP->>WP: authenticate session/nonce; check current site membership + capability
  WP->>WP: resolve current site + Reporter subject; validate input/size
  WP->>W: TLS signed installation request + attested subject/grant (no WP nonce)
  W->>W: verify installation and resource scope; return allowlisted projection/receipt
  W-->>WP: scoped response
  WP-->>B: escaped plain-text projection / honest delivery outcome
```

Each route registers a `permission_callback`; operation-specific object access is checked before forwarding and again at the Worker boundary. A nonce is not a substitute for either check. If a nonce expires, refresh it only for the same authenticated session; otherwise pause, require login, and verify identity, membership, and grants again. Do not silently replay a failed write. Hold an unsent draft only in current-tab memory during reauthentication; never auto-submit under a different user. Clear it on logout, user switch or tab close, offering copy/download before clearing where possible. No persistent browser draft storage by default.

## WordPress → Worker sequence and credentials

```mermaid
sequenceDiagram
  participant WP as WordPress server
  participant W as Worker
  participant K as Trusted installation mapping
  participant G as GitHub / operational delivery
  WP->>W: HTTPS method, path, body, key ID, timestamp, unique request ID, HMAC
  W->>W: constant-time signature + digest check; clock-window and replay check
  W->>K: resolve key ID to active installation, Client, environment, repository
  K-->>W: approved scope (never body-/Origin-selected)
  W->>W: check attested Reporter/grant, object ownership and abuse limits
  W->>G: scoped operation with idempotency/reconciliation for create
  G-->>W: accepted-pending / delivered / failed / outcome-unknown
  W-->>WP: allowlisted response + correlation ID
```

Each installation **and environment** receives its own server-side, revocable HMAC key; no shared client-wide credential. Sign a canonical representation binding method, path (including query), exact body digest, timestamp, unique request ID, and key ID. Specify the canonical encoding and clock-window value in the protocol implementation; reject duplicate request IDs within that window using bounded atomic replay state. Reuse an idempotency key for a legitimate retry of one creation intent; do not confuse it with the single-use authentication request ID. If authentication, replay storage, or key lookup fails, deny: never fall back to unsigned calls or `Origin`. TLS is mandatory. Rotation uses key IDs with a short overlap restricted to the **same installation**; revocation immediately rejects that key even during overlap. The Worker derives all repository and Client authority from trusted configuration, not a signed-but-user-controlled mapping claim. No WordPress nonce, GitHub/App/provider token, HMAC secret, or unredacted connection credential appears in browser assets/config, support payloads, logs, or client errors.

Revocation stops new Worker operations from that installation; do not use another installation's key or claim a fresh success. Accepted receipts remain in service-side reconciliation state for operators; reconnect needs operator approval. Operator processes alone may approve project mapping and issue/revoke credentials. The site-local `manage_settings` grant permits redacted connection state and a request to connect, not credential disclosure or self-approval. On URL change or database clone, the existing lifecycle changes the local installation ID; old credentials must not silently authorize the new identity (see `plugin/includes/class-gq-support-lifecycle.php`).

## Bounded threats and failure rules

| Threat | Control / explicit boundary |
| --- | --- |
| CSRF, stale nonce, logout, role changes | Cookie + `wp_rest` nonce and fresh WordPress capability/membership checks; reject writes and require explicit review/resubmit after reauth. |
| IDOR and shared repository cross-site leaks | Server-side installation + subject mapping and fresh grant on every list/object/receipt/cache lookup; no issue-number-only or label-based authorization. |
| Forged Client/repository/environment or stolen site key | Resolve scope from authenticated key on Worker; per-installation revocation/rotation and least-privilege GitHub App. Stolen key can act only in that installation's scope until revoked. |
| Replay and duplicate GitHub creation | Timestamp + unique request ID + atomic replay check; separate creation idempotency and reconcile unknown GitHub outcomes before retry. No exactly-once claim. |
| Oversized/spam intake or provider overload | Enforce explicit title/report/response byte limits, whole-request size and timeouts at both boundaries, and bounded per-subject and per-installation create rates. Reject before GitHub. If counters fail, fail closed for new creates; allow safe reads separately if possible. Choose numeric thresholds and backing store with #9/#10/#11 load tests before implementation ships. |
| HTML/Markdown injection, secrets, leaked internal discussion | First slice displays escaped plain text only; never render raw GitHub HTML or include comments. Future Markdown needs a reviewed allowlist and safe-link policy. Minimize metadata; never log content, cookies, nonces, or secrets. |
| Malicious/compromised WordPress server | May impersonate users within its approved installation and submit/read there. Cannot attain another installation's scope or independent operator credentials. Rate limits, audits, and revocation reduce impact, not eliminate it. |

Use generic but actionable client errors and opaque correlation IDs in safe operational logs. A rate-counter outage rejects new creates without claiming acceptance. Accepted-pending is used only after durable recording; a transport timeout is not delivered and is not automatically retried as a new issue (ADR 0003). No local WordPress outbox or new authentication framework is implied here.

## Implementation-ready security tests

Run tests at both REST and Worker boundaries, with two Reporters on installation A, installation B belonging to the same Client and sharing the project repository, and installation C belonging to another Client; include multisite sites with overlapping numeric WP user IDs.

1. Without login/nonce, with stale/invalid nonce, or after logout: all Reporter routes deny; `permission_callback` is present on each route; no downstream Worker call. A valid nonce without the operation's capability also denies.
2. Reporter A can submit/list/read only A's own request and receipt. Reporter B cannot read A's request, receipt, cache entry or direct issue-number lookup; site-wide manager on A can read them but cannot submit without `submit_requests`.
3. Installation B's Reporter/manager cannot read A's request despite sharing a Client and repository; C also cannot. B's matching username, email, numeric WP user ID, label or GitHub issue number does not change this. Super Admin alone does not confer service-side cross-installation access.
4. Submission and setup routes reject browser-provided Client, environment, installation, subject, repository or issue mapping overrides; the Worker resolves only the verified key's configuration. A compromised A signing key cannot request B's or C's scope, including via an attested cross-installation manager claim.
5. Removing submit/view-site/manage-settings permissions, removing site membership, or deleting a Reporter denies affected operations on the next REST request, including from an open widget. Do not transfer ownership to a new account with a matching email/name/numeric ID; a view-site grant alone remains read-only.
6. Same-session nonce refresh permits a fresh *explicit* request; changed user/session, logout, or re-login never silently resubmits the prior draft. Draft is not saved to persistent storage and is cleared on user switch/tab close; test the copy/download affordance when clearing is detectable.
7. Wrong HMAC, unknown/revoked key ID, altered path/query/body/method/timestamp, expired clock window, duplicated request ID, replay-store outage, missing TLS, and forged `Origin` all reject without GitHub side effects. Rotation overlap works only for the approved installation; immediate revocation wins over overlap.
8. Repeated create with a new authentication request ID but the *same* creation idempotency key does not create a second issue. Unknown GitHub outcome triggers reconciliation rather than blind retry; accepted-pending is not presented as delivered.
9. Oversized title/report/request, per-subject and per-installation rate breaches, counter outage, and upstream timeout yield bounded, honest outcomes and no unsupported success. Assert no content/secrets in log output or browser bootstrap.
10. An attachment route, guessed object URL, future receipt/message/cache path, or signed download URL must deny without explicit ownership/grant; currently attachment and comment endpoints do not exist and must not leak by proxying GitHub. HTML/script and malicious Markdown remain inert escaped text; only issue text and `open`/`closed` status are returned.
11. Role migration preserves a deliberate capability revocation across upgrades, allows explicit grants, scopes multisite initialization per site, leaves grants on deactivation, and uninstall removes only tracked plugin-owned grants. URL clone changes installation identity and cannot reuse the old connection.

## Follow-up boundaries

Numeric payload/rate/clock-window values, atomic replay and quota storage, credential provisioning and rotation runbooks are implementation gates coordinated with #7, #9, #10, #11 and #19, not silent infrastructure choices here. #16 owns retention, export and erasure of historical Reporter associations. #15 owns any future attachment enablement. No client-visible replies or WordPress close/reopen routes may be added without reopening the domain decision in ADR 0009.
