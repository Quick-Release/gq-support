# Architecture research: WordPress–GitHub support widget

- **Status:** Recommended architecture for the first implementation slice
- **Research date:** 2026-09-18
- **Scope:** An authenticated WordPress admin widget that submits client support requests to the project-configured, dedicated private GitHub support repository.

This document is an implementation recommendation, not a replacement for the accepted domain decisions. The repository's terminology and boundaries are defined in [`CONTEXT.md`](../../CONTEXT.md), the support domain design in [`docs/support-domain-design.md`](../support-domain-design.md), and the relevant decisions in [`docs/adr/`](../adr/).

## Executive recommendation

Use a same-origin WordPress REST API as the browser boundary, an intake/delivery Worker as the trusted delivery boundary, and GitHub as the canonical client-visible conversation record:

```text
Authenticated WP admin user
        |
        | browser fetch, WP cookie + wp_rest nonce
        v
WordPress plugin REST routes
        |
        | server-to-server request; no GitHub credential in browser
        v
Cloudflare Worker intake API
        |
        | durable operational intent + idempotency key
        v
D1 operational store  --->  Queue delivery attempt
                                  |
                                  v
                    GitHub App installation token
                                  |
                                  v
          dedicated private client support repository
```

The important distinction is between **acceptance** and **delivery**:

- WordPress returns `locally-unsent`/a retryable error if it cannot reach the intake boundary and the intent was not durably accepted.
- The Worker returns `accepted-pending` only after the delivery intent is durably recorded.
- A delivery worker reports `delivered` only after GitHub returns and the provider identity is recorded.
- A timeout or lost GitHub response is `outcome-unknown`; it must be reconciled before another side effect is attempted.

This follows ADR 0003 and avoids claiming that an HTTP response or queue enqueue proves that GitHub created an issue. Cloudflare Queues explicitly provides **at-least-once** delivery, so both the queue consumer and the provider reconciliation path must be idempotent ([Cloudflare delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)).

## 1. Boundaries and authority

The existing domain model is the right shape for this feature:

| Concern | Authority | Consequence for the widget |
| --- | --- | --- |
| Logged-in identity, installation, environment, and local capabilities | WordPress | The browser never supplies its own reporter identity or capability claim. |
| Client/install-to-repository mapping | Operator-controlled configuration | Never accept an owner, repository, or installation ID from widget input. |
| Support issue body, comments, open/closed status, and client-visible classification | GitHub support repository | The WordPress UI is a projection, not a support database. |
| Receipts, delivery attempts, idempotency, ordering, and reconciliation | Intake/delivery service | These records explain delivery without becoming a competing conversation record. |

This is consistent with [ADR 0001](../adr/0001-client-support-repository-boundary.md), [ADR 0004](../adr/0004-authority-split-for-support-records.md), [ADR 0007](../adr/0007-append-only-client-visible-support-conversation.md), and [ADR 0008](../adr/0008-one-support-repository-per-client-by-default.md).

### Recommended trust flow

1. The user opens a WordPress admin page.
2. WordPress decides whether the widget is rendered and passes only endpoint/configuration data needed by the browser.
3. The browser calls same-origin WordPress REST routes.
4. WordPress authenticates the cookie-backed request and checks the WordPress capability plus the explicit support visibility scope.
5. The WordPress callback forwards an authenticated server-to-server intent to the Worker. The Worker verifies the installation binding and request authenticity, resolves the operator-controlled repository mapping, and ignores any client-supplied routing fields.
6. The Worker records the intent and returns a receipt. Delivery to GitHub occurs synchronously only when it can still preserve the receipt semantics; otherwise a queue/reconciler performs it asynchronously.

A WordPress REST nonce is a CSRF defense for the WordPress REST boundary. It is not a credential that the browser should present directly to the Worker. Keeping the Worker call behind the WordPress callback avoids CORS and prevents the browser from receiving a Worker service credential. The exact WordPress-to-Worker authentication mechanism (for example, a short-lived signed assertion or an installation-specific HMAC) should be an implementation ADR; it must bind the request to the WordPress installation, HTTP method/path, timestamp, and body digest, and reject replay.

## 2. WordPress plugin architecture

### 2.1 Admin bootstrapping

Use the existing hooks, with capability and asset checks tightened:

- [`admin_enqueue_scripts`](https://developer.wordpress.org/reference/hooks/admin_enqueue_scripts/) is the appropriate hook for loading the React assets in admin screens. Use its screen suffix to record the originating admin screen, but do not use the screen name as authorization.
- [`admin_footer`](https://developer.wordpress.org/reference/hooks/admin_footer/) can emit the mount element after the admin page markup. The mount element should be emitted only for an eligible authenticated user.
- [`wp_enqueue_script`](https://developer.wordpress.org/reference/functions/wp_enqueue_script/) should register the built script with an explicit version and footer loading. Enqueue the stylesheet separately.

The current `edit_others_posts` check is only a scaffold approximation. Replace it with a plugin capability such as `gq_support_submit` (and separate read/reply/state capabilities if needed), then apply the domain's explicit installation/request scope. A WordPress role name such as Editor must not itself mean support manager. WordPress's REST guidance says that a route needs a `permission_callback`, and recommends capability checks such as `current_user_can` rather than merely checking login state ([custom REST endpoints](https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/), [`current_user_can`](https://developer.wordpress.org/reference/functions/current_user_can/)).

The hook is a good delivery mechanism for the widget, but it should not be treated as a guarantee that every unusual admin rendering context has a normal footer. The first slice should define its supported admin contexts and fail closed when the root or assets cannot be rendered. If “any WP-Admin page” is a hard requirement, test classic screens, list tables, settings pages, network admin, and screens with custom markup before calling the requirement complete.

### 2.2 Configuration passed to React

Pass a small, non-secret bootstrap object before the built app script, using [`wp_add_inline_script`](https://developer.wordpress.org/reference/functions/wp_add_inline_script/) (or [`wp_localize_script`](https://developer.wordpress.org/reference/functions/wp_localize_script/) for genuinely localized data):

```json
{
  "restBase": "/wp-json/gq-support/v1",
  "nonce": "wp-rest-nonce",
  "installation": "opaque-installation-id",
  "actor": {
    "displayName": "Reporter",
    "canCreate": true,
    "canReply": true,
    "canChangeState": false
  }
}
```

The actual object should be encoded with WordPress JSON helpers and treated as untrusted input by TypeScript. It may contain an endpoint URL, nonce, opaque installation identifier, UI capability flags, and a display name. It must not contain:

- a GitHub App private key, installation access token, Worker shared secret, or JWT;
- a client-selectable repository name or owner;
- a list of repositories the user may probe;
- unnecessary personal data.

The browser sends the nonce in the `X-WP-Nonce` header and relies on normal same-origin cookie authentication. WordPress documents cookie authentication for logged-in REST requests and the `wp_rest` nonce pattern in [REST API authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/). A nonce expires and is not a substitute for the route's authorization check, so every route still performs permission and resource-scope checks.

### 2.3 REST route surface

Register routes on `rest_api_init` with explicit schemas, validation, and `permission_callback`s. A minimal surface is:

```text
GET  /gq-support/v1/requests
GET  /gq-support/v1/requests/{requestId}
POST /gq-support/v1/requests
POST /gq-support/v1/requests/{requestId}/messages
POST /gq-support/v1/requests/{requestId}/state
```

Recommended request rules:

- `POST /requests` accepts a title, plain-text body, an allowlisted client-visible classification if the product needs one, and a client-generated idempotency key.
- `POST .../messages` accepts plain text and a new idempotency key. It does not accept Markdown, HTML, attachments, or an arbitrary GitHub issue number.
- `POST .../state` accepts only `open` or `closed`; reopening and closing are separate ordered intents even if they share an endpoint.
- IDs and cursors are opaque. The route must verify that the actor can access the referenced request before reading or mutating it.
- Payload size, line length, and rate limits should be explicit configuration, not accidental PHP or GitHub limits.
- Return a stable, sanitized API error code rather than raw Worker/GitHub error bodies.

A response should distinguish the delivery outcome from support status, for example:

```json
{
  "requestId": "support-request-id",
  "intentId": "delivery-intent-id",
  "outcome": "accepted-pending",
  "supportStatus": "open"
}
```

`requestId` can be allocated by the intake service before the GitHub issue exists. `supportStatus` is only a known projection when an issue identity exists; it must not be inferred from `accepted-pending`.

For an asynchronous accepted intent, `202 Accepted` is the honest transport response. A successful request that is already confirmed may use `200`. If the WordPress route cannot durably reach intake, return a retryable `503` (or equivalent) and identify the operation as `locally-unsent`; do not manufacture an `accepted-pending` receipt in the browser.

### 2.4 WordPress callback to Worker

The PHP callback should:

1. Read the authenticated WordPress user from the request context.
2. Re-check the action capability and explicit visibility scope.
3. Normalize and validate text and the idempotency key.
4. Resolve the installation/environment from server-side configuration.
5. Construct a server-to-server request containing verified reporter/install attribution, the domain request or intent ID, the action, payload, timestamp, and body digest.
6. Call the configured Worker endpoint with [`wp_remote_post`](https://developer.wordpress.org/reference/functions/wp_remote_post/) or the appropriate WordPress HTTP API method, using a short timeout and no browser-visible service secret.
7. Translate the Worker response into the stable WordPress REST contract.

WordPress's local nonce and cookie prove the local browser request; the server-to-server authentication proves to the Worker that the request came through a configured installation. Do not forward the raw cookie or nonce as Worker authorization.

### 2.5 Read projection

For reads, the Worker should resolve the request's provider identity and read the issue plus paginated comments from GitHub. It should return only the client projection:

- request ID and GitHub issue URL/number where appropriate;
- title, initial plain-text report, and verified reporter/install attribution;
- client-visible messages in order;
- `open`/`closed` support status;
- allowlisted client-visible classification;
- delivery outcome for the actor's own pending intents.

Do not copy internal engineering labels, unrelated project issues, private GitHub metadata, tokens, or provider-internal error details into the WordPress response. A dedicated support repository reduces accidental cross-client disclosure but does not replace every object-level authorization check.

## 3. GitHub integration

### 3.1 Use a GitHub App installation, not a user token

The Worker should authenticate as a GitHub App installation for the mapped support repository:

1. Store the App private key only as a Worker secret.
2. Create a short-lived App JWT in the Worker.
3. Exchange it for an installation access token.
4. Request only the approved repository and permissions.
5. Use that token for issue, comment, read, and state operations.
6. Refresh on expiry or an authentication response; never expose or persist the token in WordPress or React.

GitHub documents that an installation access token is limited by the App's permissions and repository access, and expires after one hour ([authenticating as an installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)). GitHub also recommends minimum permissions and repository restriction in its [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).

The minimum capability for this MVP is the GitHub App repository **Issues: write** permission. Confirm the final permission matrix during App registration: the App must be able to read the issue/conversation and create comments as well as create issues and update state. GitHub's [permission selection guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) is the authority for the current permission names and endpoint requirements.

### 3.2 Provider operations

Map domain operations to the GitHub REST API:

| Domain operation | GitHub representation | Official API |
| --- | --- | --- |
| Create support request | New issue; initial message is the body | [Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue) |
| Add a client-visible message | Issue comment | [Create an issue comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment) |
| Read a request | Issue plus issue comments | [Issues](https://docs.github.com/en/rest/issues/issues), [list issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments) |
| Close/reopen | Issue `state` set to `closed`/`open` | [Update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue) |

Use plain text in the body and comments. Include a stable, opaque support intent reference in a visible footer or other plain-text attribution envelope. This is not intended as a hidden security mechanism; it gives reconciliation a provider-searchable marker while preserving the client-visible record. Keep the marker free of email addresses, raw WordPress IDs where avoidable, and secrets.

GitHub's create-issue and comment APIs do not make the architecture exactly-once. The service therefore treats the provider ID as unknown until observed and reconciles an ambiguous attempt by searching or listing the exact mapped repository, checking the opaque marker and expected content, and recording the existing issue/comment if found. If it cannot establish whether the side effect happened, retain `outcome-unknown` and do not blindly create another side effect.

### 3.3 Repository mapping

The mapping table must be operator-controlled and include at least:

```text
installation_id -> client_id, environment, github_installation_id,
                    repository owner/name, active status, mapping version
```

The default is one dedicated private support repository per client. A separate repository per installation is an explicit isolation exception, as required by [ADR 0008](../adr/0008-one-support-repository-per-client-by-default.md). The widget receives neither the mapping nor a repository selector. A missing, inactive, or changed mapping is a configuration error—not a request to fall back to the product repository.

## 4. Durable delivery model

### 4.1 Operational records

A recommended operational schema is:

```text
installations
  installation_id, client_id, environment, GitHub installation ID,
  repository owner/name, mapping version, active

support_requests
  request_id, installation_id, reporter reference, provider issue ID/number,
  first intent ID, current known provider state

delivery_intents
  intent_id, request_id, sequence, action, plain-text payload,
  idempotency key, outcome, provider ID, attempt count, timestamps

delivery_attempts
  intent_id, attempt ID, started/finished timestamps, response class,
  reconciliation state, correlation ID
```

These are operational references and delivery material. The support conversation remains GitHub's record. Payload retention, encryption, access, export, and erasure need an explicit privacy decision because pending retries require enough data to perform delivery.

Enforce uniqueness at the store level for the installation-scoped idempotency key and `(request_id, sequence)`. Allocate a monotonically increasing sequence for every mutation. A request creation is sequence 0; replies and state changes follow it. This implements [ADR 0006](../adr/0006-ordered-reconciliation-of-support-mutations.md).

### 4.2 Acceptance and queueing

A robust intake path is:

1. Authenticate and validate the request.
2. Resolve the installation mapping and authorize the actor.
3. Insert the delivery intent transactionally with its idempotency key and `accepted-pending` state.
4. Attempt to enqueue the intent for delivery.
5. Return the existing receipt for a duplicate idempotency key.
6. Have a periodic sweeper enqueue accepted intents whose queue publish was lost.

The database insert and queue publish are not assumed to be one atomic transaction. A duplicate queue message is harmless only if the consumer re-reads the intent, checks its state/sequence, and uses reconciliation before retrying an ambiguous provider attempt. If D1 and Queues are adopted, the choice and failure-recovery behavior should be recorded in a follow-up ADR; the current domain design deliberately leaves those infrastructure choices open.

The consumer should hold or retry an intent whose predecessor is not delivered. It must not add a reply before issue creation is known delivered, and must not apply a state change ahead of earlier messages. A client can receive an accepted receipt for a valid queued reply only if the service has defined how it will preserve that dependency; otherwise return a conflict/retry response while the creation is unresolved.

### 4.3 Retry and reconciliation policy

Classify failures before retrying:

| Condition | Outcome/action |
| --- | --- |
| Invalid input, missing mapping, forbidden scope | Known failure; no retry. |
| GitHub authentication/permission/configuration failure | Known failure; alert operators; do not retry indefinitely. |
| GitHub not found after verified mapping/provider identity | Known failure or reconciliation/configuration incident. |
| Rate limit or transient 5xx | Bounded retry with backoff; respect `Retry-After` when present. |
| Timeout, connection reset, worker crash after request transmission | `outcome-unknown`; reconcile by marker/provider identity before retry. |
| Queue redelivery | Re-read idempotency state; safely no-op, hold, or reconcile. |

A retry must be bounded and observable. A known GitHub 4xx should not be converted to a duplicate attempt. A reconciliation query must always be constrained to the mapped private repository and verify the marker/content before associating a provider object.

## 5. TanStack choices in the React app

### Use TanStack Query

TanStack Query is appropriate for the browser-facing **server state**:

- `useQuery` for the request list and selected request projection;
- `useMutation` for create, reply, close, and reopen intents;
- stable query keys including installation and request ID;
- explicit invalidation after a mutation response, following TanStack's [invalidations from mutations](https://tanstack.com/query/latest/docs/framework/react/guides/invalidations-from-mutations);
- an explicit Refresh action that refetches GitHub-backed projection data.

TanStack's [mutation guide](https://tanstack.com/query/latest/docs/framework/react/guides/mutations) provides the mutation lifecycle used for pending/error UI. Mutation success must not be treated as GitHub delivery success: the returned `outcome` controls the message shown to the user. For `accepted-pending`, show “accepted; delivery is pending” and retain the intent ID. Invalidate relevant request queries after the mutation so a subsequent read can observe provider state, but do not use an optimistic update to make an unconfirmed issue/comment appear delivered.

Do not persist the Query cache as a local outbox. The cache is a rendering aid and is not the durable acceptance record required by ADR 0003. Avoid polling and focus refetching in the MVP; manual refresh is the accepted behavior in [ADR 0005](../adr/0005-minimal-plain-text-support-slice.md).

### Do not add the other TanStack products yet

- **TanStack Form:** not needed for one plain-text title/body flow; native controlled inputs or a small local form state keep the boundary obvious. Reconsider if validation, field arrays, or a multi-step form becomes substantial. See [TanStack Form](https://tanstack.com/form/latest).
- **TanStack Store:** not needed for a small widget. Query already owns remote request state and React local state owns transient panel/form state. See [TanStack Store](https://tanstack.com/store/latest).
- **TanStack Router:** not needed for a widget embedded in arbitrary admin screens. Use local selected-request state rather than changing the WordPress admin URL. See [TanStack Router](https://tanstack.com/router/latest).

This keeps the client architecture shallow: React renders the widget, Query coordinates server state, and WordPress REST remains the browser contract.

## 6. Effect design in the Worker

The current Worker scaffold already imports Effect, but the implementation should separate HTTP adaptation from a domain program. The Worker runtime is Cloudflare Workers, not Node; the current `@effect/platform-node` dependency should not be assumed to be a valid production adapter. Confirm the Effect v4 RC HTTP/runtime compatibility in a small deployment spike before choosing platform packages.

### 6.1 Typed expected errors

Represent expected delivery failures as tagged errors, for example:

```text
InvalidRequest
UnauthenticatedInstallation
ForbiddenScope
MappingMissing
PersistenceFailure
GitHubAuthenticationFailure
GitHubRateLimited
GitHubNotFound
GitHubConflict
GitHubTransientFailure
GitHubOutcomeUnknown
```

The route boundary maps these to stable HTTP status/error codes. The domain layer should not throw arbitrary strings or let every exception become a 500. Effect documents that expected errors are tracked in the error channel and can be handled precisely ([Expected Errors](https://effect.website/docs/v3/error-management/expected-errors)); the v4 API names should be verified against the installed RC before implementation.

### 6.2 Retry only safe classes

Wrap fetch, token minting, and persistence operations in Effects that map transport responses to typed errors. Apply a bounded `Schedule` only to rate-limit/transient failures. Do not retry validation, authorization, missing mapping, or ambiguous GitHub operations without first reconciling them. Effect's retry model supports policies and schedules, including fallback after exhaustion ([Retrying](https://effect.website/docs/v3/error-management/retrying)).

The Worker should expose two distinct programs:

```text
acceptIntent(request)
  -> authenticate, authorize, validate, persist, return receipt

deliverIntent(intent)
  -> check ordering, mint scoped token, reconcile if needed,
     perform GitHub mutation, persist provider identity/outcome
```

This separation makes it difficult for a failed provider call to erase the already accepted operational receipt.

### 6.3 Structured logging and spans

Use Effect logs and spans around:

- request authentication and authorization;
- intent persistence and queue publication;
- GitHub token acquisition;
- each provider operation and reconciliation;
- final outcome classification.

Annotate logs/spans with opaque `correlationId`, `installationId`, `requestId`, `intentId`, sequence, operation, attempt, and outcome. Never log report/comment text, cookies, WP nonces, App private keys, installation tokens, or unnecessary personal data. Effect documents JSON logging and spans/tracing ([Logging](https://effect.website/docs/v3/observability/logging), [Tracing](https://effect.website/docs/v3/observability/tracing)).

Enable Cloudflare Workers logs and traces with an intentional sampling policy. Cloudflare documents structured Workers logs and trace configuration in [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [Exporting OpenTelemetry data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/). Correlate the WordPress request ID, Worker trace/span context, queue attempt ID, and GitHub intent ID; do not assume Effect's tracing integration is automatically exported by Cloudflare without testing the chosen runtime adapter.

## 7. Secrets, privacy, and abuse controls

Store Worker-side credentials as Cloudflare Worker secrets, not source, Alchemy configuration checked into the repository, or WordPress inline data. Cloudflare documents secret bindings and access through the Worker `env` object in [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/). The secret set should include only what the deployment needs, such as:

- GitHub App private key and App ID;
- WordPress-to-Worker signing material or equivalent service credential;
- any operational encryption/key material selected by the privacy design.

The MVP should additionally:

- enforce maximum plain-text sizes and request rate limits per installation/reporter;
- use HTTPS for WordPress-to-Worker and Worker-to-GitHub traffic;
- redact provider responses at every boundary;
- avoid collecting attachments, diagnostics, screenshots, or session recordings;
- define retention for failed/pending payloads and reporter identifiers;
- make the issue body/comment attribution explicit and plain text;
- keep repository mapping and App installation changes operator-controlled and auditable.

The dedicated private repository is a routing/isolation boundary, not permission to put secrets or unbounded personal data into issue bodies.

## 8. Failure and user experience matrix

| User-visible situation | HTTP/UI treatment | Honest meaning |
| --- | --- | --- |
| Not logged in / expired session | 401; ask user to reload/login | WordPress did not authenticate the actor. |
| Missing capability or request scope | 403; do not reveal resource existence | Actor is not authorized for this action. |
| Invalid/too-large plain text | 400 with field error | Nothing was accepted. |
| Intake unavailable before persistence | 503; retain entered text in current form only | `locally-unsent`; retry is safe because no receipt exists. |
| Intent persisted, delivery not complete | 202 and intent ID | `accepted-pending`; do not claim a GitHub issue/comment exists. |
| GitHub mutation confirmed | success and provider identity/status | `delivered`; projection can be refreshed. |
| Known non-retryable delivery failure | error plus intent/reference for support | Delivery failed; no duplicate automatic mutation. |
| Provider response ambiguous | pending/unknown state and reconciliation message | GitHub may already contain the change; retry is not yet safe. |
| Another support actor replied in GitHub | appears after explicit refresh | GitHub remains authoritative; no live sync is promised. |

The UI should never clear a form or display “sent” merely because `fetch()` returned 200. It may clear after the service returns a successful accepted receipt according to the product's chosen UX, but it must preserve the intent/reference and make pending delivery visible.

## 9. Suggested implementation sequence

1. **Contract first:** finalize the REST/Worker schemas, error codes, receipt states, scope rules, idempotency key format, and sequence behavior.
2. **WordPress boundary:** add route registration, nonce bootstrap, capability/scope checks, input schemas, and server-side Worker forwarding. Test every supported admin screen.
3. **Operational persistence:** choose D1/schema/retention and write uniqueness constraints and reconciliation states. Record the choice in an ADR because the domain design leaves infrastructure open.
4. **GitHub App:** register the minimum permission set, configure the dedicated support repository installation, and implement scoped token minting/rotation.
5. **Provider adapter:** implement create issue, list/read comments, add comment, state changes, marker-based reconciliation, and pagination.
6. **Queue/reconciler:** add at-least-once-safe delivery, ordering gates, bounded retries, sweeper recovery, and `outcome-unknown` handling.
7. **React projection:** replace the empty `App` with Query-backed list/detail/mutation views, manual refresh, pending/error states, and plain-text form validation.
8. **Effect/observability:** add typed errors, retry schedules, structured logs, spans, correlation IDs, and Cloudflare sampling/export configuration.
9. **End-to-end tests:** cover duplicate submissions, queue redelivery, timeout after GitHub acceptance, GitHub 429/5xx/403/404, missing mapping, unauthorized request IDs, out-of-order reply, close/reopen, refresh after direct GitHub reply, and private-repository isolation.

## 10. Open decisions before code

These are the remaining decisions that should not be silently encoded in the widget:

- Where the operator-controlled installation-to-client/repository mapping lives and how it is rotated.
- The exact WordPress-to-Worker request authentication and replay window.
- D1 versus another operational store, schema, encryption, retention, and erasure behavior.
- Queue adoption, delivery concurrency, ordering strategy, and dead-letter/replay operations.
- Exact GitHub App permissions and installation onboarding lifecycle.
- Public versus private Worker endpoint policy and abuse/rate-limiting controls.
- Whether reporters can close/reopen their own requests or only support managers, consistent with the explicit scope matrix.
- The supported set of WordPress admin contexts.
- Effect v4 RC compatibility with the selected Cloudflare Worker HTTP adapter and trace exporter.

Until these are settled, the existing scaffold should remain a scaffold rather than implying that the placeholder Worker or `edit_others_posts` check meets the support contract.

## Sources

All external sources below are first-party documentation from the owning project. Accessed **2026-09-18**.

### WordPress Developer Resources

- [`admin_enqueue_scripts`](https://developer.wordpress.org/reference/hooks/admin_enqueue_scripts/)
- [`admin_footer`](https://developer.wordpress.org/reference/hooks/admin_footer/)
- [`current_user_can`](https://developer.wordpress.org/reference/functions/current_user_can/)
- [`wp_enqueue_script`](https://developer.wordpress.org/reference/functions/wp_enqueue_script/)
- [`wp_add_inline_script`](https://developer.wordpress.org/reference/functions/wp_add_inline_script/)
- [`wp_localize_script`](https://developer.wordpress.org/reference/functions/wp_localize_script/)
- [`wp_remote_post`](https://developer.wordpress.org/reference/functions/wp_remote_post/)
- [Adding custom REST endpoints](https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/)
- [REST API authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/)

### GitHub Docs

- [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue)
- [Create an issue comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
- [List issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments)
- [Update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue)

### TanStack

- [TanStack Query mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations)
- [Invalidations from mutations](https://tanstack.com/query/latest/docs/framework/react/guides/invalidations-from-mutations)
- [TanStack Form](https://tanstack.com/form/latest)
- [TanStack Store](https://tanstack.com/store/latest)
- [TanStack Router](https://tanstack.com/router/latest)

### Effect

- [Expected errors](https://effect.website/docs/v3/error-management/expected-errors)
- [Retrying](https://effect.website/docs/v3/error-management/retrying)
- [Logging](https://effect.website/docs/v3/observability/logging)
- [Tracing](https://effect.website/docs/v3/observability/tracing)

### Cloudflare Workers and Queues

- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Exporting OpenTelemetry data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
- [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
