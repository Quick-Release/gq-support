# GitHub Issues through a least-privilege GitHub App

- **Research target:** GitHub issue [#8](https://github.com/Quick-Release/gq-support/issues/8)
- **Status:** Recommended decision for the Worker's GitHub boundary
- **Access date:** 2026-09-28
- **Inputs:** [CONTEXT.md](../../CONTEXT.md), [ADR 0009](../adr/0009-project-repository-intake-and-reporter-scoped-projection.md), [ADR 0010](../adr/0010-installation-scoped-attestation-not-cross-site-identity.md), [support domain design](../support-domain-design.md), [support security design](../support-security-design.md), [support API contract](../support-api-contract.md), [repository connection research](support-widget-and-repository-connection.md)

The accepted domain constraints are fixed inputs here, not open questions. Each Support request becomes one issue in the WordPress project's **existing** Project repository. The GitHub App is the author. A Client-origin label is applied and an internal Developer is assigned. GitHub comments are internal and are never projected to Reporters. Creation is idempotent per Submission ID, and unknown outcomes are reconciled before any retry. The Reporter's view of status is read-only in the MVP. This note answers the GitHub-side questions: permissions, tokens, routing, the body template, limits, failure mapping, and how to find an issue after an ambiguous create.

GitHub facts are cited to docs.github.com. Anything marked **verify in spike** is an inference that the first implementation slice must confirm against a real test repository.

## Recommendation

1. **One GETQUICK-owned GitHub App, operated centrally.** The private key lives only in the one Worker component that talks to GitHub (the "GitHub gateway"). It is never stored in WordPress, the browser, D1, or logs.
2. **Permissions:** Repository **Issues: read & write**, and **Metadata: read**. Nothing else: no Contents, Administration, Pull requests, Members, or organization or account permissions. Webhook subscriptions are listed in the event matrix below.
3. **Tokens:** Each GitHub call uses an installation access token minted with `repository_ids: [<mapped repo id>]` and `permissions: {issues: "write", metadata: "read"}`. Cache it per isolate, in memory only, keyed by (installation ID, repository ID), and refresh it about 5 minutes before `expires_at`.
4. **Routing:** The verified installation credential resolves to an operational record: Client, installation, environment, and repository mapping. That record stores GitHub's numeric `installation_id` and numeric `repository_id` as identity. `owner/name` is only a cached display and URL value, refreshed from the mint response. Browser and WordPress input never selects the installation or repository.
5. **Create:** one `POST /repos/{owner}/{repo}/issues` per creation intent. It carries `title`, a versioned body with a hidden correlation marker, `labels: [<client-origin label>]`, and `assignees: [<Developer login>]`. Mutations are never retried automatically. After the response, check the returned labels and assignees and repair any gap with the idempotent add-label and add-assignee endpoints.
6. **Reconciliation of an unknown create:** list the repository's issues filtered by `creator=<app-slug>[bot]`, `state=all`, sorted by created date descending. Page back to the intent's first attempt time minus a skew allowance. Match the marker on the **first line** of the body. Do not use the Search API for this.
7. **Private-only guard:** refuse to create when the mint response shows the target repository is not `private`. Webhooks also suspend the mapping when a repository is publicized.
8. **Worker shape:** a thin, fetch-based `GitHubGateway` Effect service with typed errors. Octokit's generic retry and throttling plugins are not used on mutations.

## Permissions and event matrix

Sources: [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), [webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

| Operation (MVP unless noted) | Endpoint | Permission |
|---|---|---|
| Create Support request | `POST /repos/{o}/{r}/issues` | Issues: write |
| Read one issue (text, state, labels, assignees) | `GET /repos/{o}/{r}/issues/{n}` | Issues: read |
| Reconciliation and status sweep | `GET /repos/{o}/{r}/issues?creator=…&state=all` | Issues: read |
| Repair label, repair assignee | `POST /repos/{o}/{r}/issues/{n}/labels`, `POST …/{n}/assignees` | Issues: write |
| Validate Developer at mapping approval | `GET /repos/{o}/{r}/assignees/{login}` (204 or 404) | Issues: read |
| Provision the client-origin label at connection | `GET`/`POST /repos/{o}/{r}/labels` | Issues: read/write |
| Repository privacy, name, and archived state | `GET /repos/{o}/{r}`; `repositories[]` in the mint response | Metadata: read |
| Client-authorized close/reopen (**post-MVP, #28**) | `PATCH /repos/{o}/{r}/issues/{n}` with `state` | Issues: write |
| Comments (**not used**) | `…/issues/{n}/comments` | Issues: write (no finer grant exists) |

Notes:

- There is no comment-only or label-only permission. Issues write covers issue creation, labels, assignees, and comments together, so "the App never writes comments" is a code and test invariant, not a GitHub-enforced limit.
- Issues write does not allow deleting issues or transferring them. Neither is needed.
- GitHub returns an `X-Accepted-GitHub-Permissions` header naming the permissions an endpoint needs. Log it on 403 responses to diagnose a missing permission ([source](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)).
- If the App later adds a permission, each installing account owner must approve it, and "their installation will continue to use the old permissions" until they do ([source](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)). Changing permissions is therefore a fleet rollout with an approval-tracking step.

| Webhook event | Needed permission | Why | Owner |
|---|---|---|---|
| `installation` (`created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`) | always delivered | Suspend or restore mappings, and track permission approval | #8 / #7 |
| `installation_repositories` (`added`, `removed`) | always delivered | A removed repository suspends its mapping | #8 / #7 |
| `repository` (`publicized`, `privatized`, `renamed`, `transferred`, `archived`, `unarchived`, `deleted`) | Metadata: read | Privacy guard, display-name refresh, write suspension | #8 |
| `public` | Metadata: read | Redundant publicized signal | #8 |
| `issues` (`closed`, `reopened`, `transferred`, `deleted`, `edited`) | Issues: read | Status projection freshness, and moved or deleted issues | #10 / #12 |
| `installation_target` (account renamed) | always delivered | Refresh the cached owner name | #8 |
| `issue_comment` | — | **Do not subscribe.** Comments are internal and never processed | — |

GitHub says: "All GitHub Apps receive this event by default" for `installation` and `installation_repositories`. The `repository` and `public` events require Metadata read, and `issues` requires Issues read ([source](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).

Receiver basics are in scope only as far as this ticket needs them; #12 owns the receiver ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)):

- Verify `X-Hub-Signature-256` with the webhook secret.
- Respond 2xx within 10 seconds and process asynchronously.
- Deduplicate on `X-GitHub-Delivery`, which stays the same on redelivery.
- Check the event type and action before acting.
- "GitHub does not automatically redeliver failed deliveries" ([source](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)), so correctness must never depend on a webhook arriving. Every safety check is repeated synchronously at write time.

## Authentication and tokens

- **JWT:** RS256, `iat` 60 s in the past, `exp` no more than 10 minutes ahead, `iss` set to the App's client ID ([source](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)).
- **Private key format:** GitHub issues keys as "PEM … in `PKCS#1 RSAPrivateKey` format" ([source](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)). Web Crypto `importKey` accepts RSA private keys as `pkcs8` or `jwk`, not PKCS#1 ([W3C Web Crypto](https://w3c.github.io/webcrypto/#rsassa-pkcs1)). Workers support RSASSA-PKCS1-v1_5 sign and import ([Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)). The provisioning runbook therefore converts the key once (`openssl pkcs8 -topk8 -nocrypt`) and stores it as a Worker secret through Alchemy. Up to 25 keys can exist, which allows zero-downtime rotation ([source](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)).
- **Installation token:** `POST /app/installations/{id}/access_tokens` returns a token that expires "after 1 hour". The request can narrow access with `repository_ids` and `permissions`. The response includes `expires_at`, `permissions`, `repository_selection`, and `repositories[]` ([installation auth](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation), [endpoint](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)).
- **Caching:** GitHub says "You should cache tokens that you create" ([best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)). Cache tokens in isolate memory only. Never persist them to D1 or KV, because a leaked store row would then be a live credential. A cold isolate costs one extra mint, which is cheap. `DELETE /installation/token` can revoke a token early, for example on offboarding.
- **Use the mint response as a live check.** Each mint returns the repository's current `full_name` and `private` flag, and fails with 404 or 422 when the installation or repository access is gone. It is the cheapest synchronous check of routing and privacy before a write. **Verify in spike:** that `repositories[]` includes `private` and `archived` for a token scoped by `repository_ids`. If it does not, add `GET /repos/{o}/{r}` (Metadata read) before each create.
- **Attribution:** installation tokens "attribute activity to your app". Apps "should never use a personal access token" ([source](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)). The issue author is `<app-slug>[bot]`, and the Developer appears only as assignee.
- **Headers on every call:**
  - `Authorization: Bearer <token>`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2026-03-10`, pinned. Without it, requests default to `2022-11-28`.
  - A `User-Agent` naming the App. "All API requests must include a valid `User-Agent` header" ([source](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api)).
- **Use `assignees[]` only.** The singular `assignee` field was removed in a versioned breaking change ([source](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes)).

## Routing and stable identity

GitHub advises: "If you store references to repositories, organizations, and enterprises, use their `id`" and "never use identifiers that can change over time" ([source](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)).

Mapping record, owned by #7 and #10 and approved by an operator:

`installation credential → { client_id, wp_installation_id, environment, github_installation_id, github_repository_id, cached_full_name, client_origin_label, developer_login, mapping_state }`

- **Resolution:** the verified HMAC key ID (#32) selects the mapping. No other input can. A token minted with `repository_ids: [github_repository_id]` physically cannot touch another repository, even if the code has a bug. That is the cross-tenant denial enforced at GitHub.
- **Issue identity:** store the issue's numeric `id` and `node_id` as well as `number`. Addressing uses `/repos/{full_name}/issues/{number}`, and `full_name` is refreshed from the mint response.
- **Approval:** `GET /repos/{o}/{r}/installation` (JWT) confirms that the installation matches ([source](https://docs.github.com/en/rest/apps/apps)). The repository `id` must equal the configured ID, and the operator verification flow from the [connection research](support-widget-and-repository-connection.md) applies. The setup-URL `installation_id` is spoofable and never trusted alone.
- **Shared installations:** if many project repositories sit under one organization installation, for example GETQUICK's own organization, that installation's rate limits are shared by every Client routed to it (see Limits).

## Lifecycle cases and safe responses

| Event | Detected by | Response |
|---|---|---|
| Installation deleted or suspended | `installation` webhook; mint returns 404 or 403 | Mapping becomes `suspended`. New creates return `503 gq_support_not_accepted` and are not accepted. Accepted intents stay `accepted-pending` for an operator. Reads serve the last projection, marked stale. |
| Repository removed from the installation | `installation_repositories.removed`; mint fails for that `repository_id` | Same as above |
| Permissions reduced or not approved | 403 plus `X-Accepted-GitHub-Permissions` | Suspend the mapping and raise an operator alert. Never retry. |
| Repository renamed | `repository.renamed`; `full_name` in the mint response | Update `cached_full_name`. Identity is unchanged. GitHub's 301 redirects are followed for GETs only. |
| Repository transferred to another owner | `repository.transferred`; installation or repository access changes | If still accessible with the same `repository_id` and installation, update and continue. Otherwise suspend and require operator re-approval. |
| Repository archived | `repository.archived` | Suspend writes. Writes are expected to fail with 403 (**verify in spike**). Reads continue. |
| Repository becomes public or internal | `repository.publicized`, `public`; `private` false in the mint response | **Fail closed:** suspend the mapping and refuse creates before any write. Keep pending intents unsent and page an operator. Only an operator can resume, and a Client decision is required. Allowed visibility is `private` only. |
| Repository deleted | `repository.deleted`; 404 | Suspend. Operational records remain under #16's retention rules. |
| Issue transferred | `issues.transferred`; GET returns 301 | Follow the 301 once to learn the new location. Record the new repository and issue identity only if the new repository is inside the same approved mapping. Otherwise show the request as closed to the Reporter and mark it `moved`. |
| Issue deleted | `issues.deleted`; GET returns 410 (or 404 without access) | Reporter sees the request as closed. The record is marked `deleted-upstream`. It is never recreated automatically. |
| Issues disabled on the repository | Create returns 410 | Suspend the mapping. The attempt fails as known-not-created. |
| Engineer edits the title, body, or labels | `issues.edited` / `labeled` | Engineer changes are authoritative. The App never rewrites an existing body or labels, except to add a missing client-origin label at creation time. |

Transfer and delete behaviour quoted from GitHub: "The API returns a 301 Moved Permanently status if the issue was transferred … If the issue was deleted from a repository where the authenticated user has read access, the API returns a 410 Gone status" ([source](https://docs.github.com/en/rest/issues/issues#get-an-issue)).

## Issue template v1

GitHub renders the body as Markdown. Reporter text can therefore @mention people (and notify them), cross-reference issues, embed remote images, or forge template sections. Title text is not rendered as Markdown.

```markdown
<!-- gq-support:v1 intent=int_01J8Z6Q4M1ZC7XK2 -->
**Support request** submitted via GETQUICK Support · `production` · installation `inst_7c2e` · reporter `rs_4f9c1a` · 2026-09-28 10:00 UTC

### Description

~~~~text
On the cart page, clicking Checkout does nothing. I expected the payment step.
~~~~

### Environment

<!-- fields allowlisted by #14; omitted until #14 lands -->
```

- **Title:** the Reporter's Summary, or the description's first line cut to about 80 characters (API contract). No prefix is added, because the label already classifies the issue.
- **Marker:** the first line only. It holds an opaque, service-issued intent ID. It is not the Submission ID and not the resource `id`, and it carries no Reporter or site data. The marker is a correlation hint, not authority: reconciliation also requires the creator to be the App bot and the creation time to fall within the window.
- **Reporter text** goes inside a tilde code fence longer than any tilde run in the text, following the CommonMark fence rule. That makes mentions, references, images, HTML, and forged markers inert. This trades rendered formatting for safety, and it matches the plain-text MVP.
- **Attribution:** pseudonymous by default. The environment, a short installation reference, and a short hash of the Reporter subject give Developers something to correlate with operators, without putting names or emails into a repository that all project collaborators can read. Adding a WordPress display name is a #16 privacy decision. The App is the visible author, and the text never claims to be written by a GitHub user.
- **Never in GitHub:** email addresses, usernames, WordPress user IDs, IP addresses, cookies, nonces, HMAC material, the Submission ID, service URLs, or raw request metadata.
- **Labels:** exactly one client-origin label per mapping, for example `client-support`. The label is created at connection time with `POST /repos/{o}/{r}/labels`, because relying on implicit creation during issue create is undocumented. The mapping allowlists it. Reporters supply no labels, and there is no urgency or category field in v1 (API contract). A future triage label must come from a mapping allowlist, never from free text (#21).

## Create and reconciliation algorithm

GitHub facts that shape this algorithm:

- "Only users with push access can set labels … Labels are silently dropped otherwise", and the same applies to assignees and milestone ([source](https://docs.github.com/en/rest/issues/issues#create-an-issue)). An App with Issues write is expected to have this ability (**verify in spike**). Either way, the response must be checked.
- The create endpoint "triggers notifications" and can hit secondary rate limits. It returns 201, 400, 403, 404, 410, 422, or 503.

Steps:

1. Load the intent: (installation, subject, Submission ID) maps to an intent ID and an attempt counter, owned by #11. If the intent already records an issue identity, return it.
2. Mint or reuse the scoped token. Check `private`, and fail closed if the repository is not private. **Before sending, record `attempt_started_at`.**
3. Send `POST /issues` with the title, the v1 body, `labels`, and `assignees`. Send it once, with no automatic retry.
4. Classify the outcome:

| Result | Classification | Next step |
|---|---|---|
| 201 with a parseable issue | Delivered | Store `id`, `node_id`, `number`, and `created_at`. If the label or assignee is missing from the response, run `POST …/labels` or `POST …/assignees`. These add to the issue, so running them twice is harmless. A failed repair is logged and retried later; it never blocks delivery. |
| 400, 404, 410, 422 (validation) | Known not created | `failed`, or mapping `suspended` for 404/410. A 422 naming the assignee means: mark the Developer invalid, create without an assignee, and alert. This is safe because 422 means no issue was created. |
| 401, 403 (not rate-limit) | Known not created | Suspend the mapping and alert |
| 403 or 429 with rate-limit headers | Known not created | Hold with `retry-after` or `x-ratelimit-reset`, and stay `accepted-pending` |
| Timeout, connection reset, 5xx, 2xx with an unparseable body | **Unknown** | Reconcile before any retry |

5. **Reconcile:**
   - Call `GET /repos/{o}/{r}/issues?creator=<app-slug>%5Bbot%5D&state=all&sort=created&direction=desc&per_page=100`.
   - Page back until `created_at < attempt_started_at − 5 min`.
   - Skip any item with a `pull_request` key.
   - Match the first body line exactly.
   - If exactly one issue matches, it is delivered.
   - If several match, which the algorithm should prevent, keep the lowest issue number and alert an operator. Never auto-close the others.
   - If none match, wait a short delay, then check again once to allow for read-after-write lag. If there is still no match, the attempt is known absent and may be retried with the same intent ID. The counter is bounded, and after the bound the intent becomes `failed` plus an alert.

List-endpoint facts ([source](https://docs.github.com/en/rest/issues/issues#list-repository-issues)): it supports `creator`, `state=all`, `sort=created`, and `per_page` up to 100. Its `since` filter uses *updated* time, so it is not used as the stop condition.

**Verify in spike:**

- the exact `creator` value for the App bot (`<slug>[bot]`);
- read-after-write lag on the list endpoint.

**Why not the Search API:**

- Search has its own limit of 30 requests per minute ([source](https://docs.github.com/en/rest/search/search)).
- It can return `incomplete_results`.
- It depends on an asynchronous search index, so a missing result cannot prove absence.
- The list endpoint reads the primary store, is filtered to App-created issues, and is bounded by the time window.

**Residual risks:**

- A collaborator edits the first line of the body during the short reconciliation window. The result is a possible duplicate, which the operator alert reveals.
- A collaborator forges a marker into an App-created issue. They cannot, because `creator` must be the bot.

There is no exactly-once guarantee (security design). The guarantee is at most one issue per intent under normal conditions, with detected and alerted duplicates otherwise.

## Limits, retries, and errors

Source: [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

- **Primary limit:** an installation token gets 5,000 requests per hour per installation. It scales above 20 repositories or 20 users. An Enterprise Cloud organization gets 15,000.
- **Secondary limits:**
  - at most 100 concurrent requests;
  - 900 points per minute, where most mutations cost 5 points;
  - 90 s of CPU time per 60 s;
  - **80 content-generating requests per minute and 500 per hour**.
- **Status and headers:**
  - An exceeded limit returns **403 or 429**.
  - Honour `retry-after` when it is present.
  - When `x-ratelimit-remaining` is `0`, wait until `x-ratelimit-reset`.
  - Otherwise wait at least one minute, then back off exponentially.
  - GitHub also advises making requests serially and waiting at least 1 s between mutations in bulk ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).
- **Budget:** each Support request costs one create (content-generating) plus rarely one or two repairs. The 500-per-hour cap per installation is the real ceiling. Enforce per-installation and per-subject create caps (security design) well below it, and serialize creates per GitHub installation, which a queue (#11) or Durable Object can do.
- **Reads:** use `If-None-Match` with the stored ETag. A 304 "does not count against your primary rate limit". Webhooks keep the status projection (#10, #12) fresh, so a list view does not fan out N GETs on every refresh.
- **Redirects:** follow a 301 on GETs only and record the new location. Never follow redirects on POST or PATCH; treat them as unknown and reconcile. Do not parse or construct URLs from response bodies.
- **Error mapping to the API contract:**
  - Rate-limited, suspended, or not-private: the create was durably recorded as `202 accepted-pending`, or returns `503 gq_support_not_accepted` if it was not recorded.
  - Unknown: the reconciliation path (`504 gq_support_outcome_unknown` at WordPress).
  - GitHub error bodies, URLs, repository names, and `X-Accepted-GitHub-Permissions` values go only to operator logs, never to WordPress.

## Worker service boundary (Effect)

- Define a `GitHubGateway` service (Effect `Context` tag plus a `Layer`) with a small, domain-shaped interface:
  - `createIssue(mapping, intent)` returns `Created | KnownNotCreated | Unknown`;
  - `reconcile(mapping, intent)`;
  - `readIssue(mapping, issueRef)`;
  - `verifyMapping(mapping)`;
  - `ensureLabel(mapping)`.
- Typed failures: `RateLimited{until}`, `InstallationUnavailable`, `RepositoryUnavailable`, `RepositoryNotPrivate`, `PermissionMissing{accepted}`, `IssueMoved{location}`, `IssueGone`, `ValidationRejected`, `OutcomeUnknown`.
- The gateway is the only module that imports the App key or handles tokens. Other modules see mapping IDs and issue references, never tokens.
- Implement over `fetch` through Effect's HTTP client with explicit timeouts, which fits the existing Effect 4 and Alchemy Worker. Do not adopt Octokit's retry or throttling plugins: they make retry decisions for mutations that belong to the intent state machine. The App JWT signing is about 30 lines of Web Crypto.
- Test the gateway against a fake GitHub implemented as a `Layer`, driven by recorded fixtures, plus one opt-in live smoke test against a sandbox repository.
- The App private key and webhook secret are Alchemy-managed Worker secrets. If #9 chooses per-Client Workers, only a single central gateway should hold the App key, because the key "grants access to every account that the app is installed on" ([source](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)). Per-Client Workers would then call that gateway.

## Alternatives considered

| Option | Why not |
|---|---|
| Personal access token or machine user | Tied to a human or seat, broad scope, impersonates a person. GitHub says apps should never use one. Rejected by map decision 6 and ADR 0009. |
| User-to-server token (App acting as a Developer) | Makes the Developer the author, requires a live user session and refresh tokens, and misattributes client text to a person |
| Installation token without `repository_ids` | One routing bug could write to any repository in the installation. Scoping costs nothing. |
| Per-Client GitHub Apps | Isolates private keys, but N keys, N registrations, and N permission rollouts. Revisit only if a Client demands it contractually. |
| GraphQL `createIssue` | Similar semantics, with no idempotency key either. Rate limits are point-based and harder to budget. REST is simpler for about 6 endpoints. |
| Search API for reconciliation | Rate-limited to 30/min, eventually consistent, and cannot prove absence |
| Retry blindly with backoff | Duplicates issues on ambiguous timeouts (ADR 0003, ADR 0006) |
| Posting comments as a Reporter channel | Out of scope under ADR 0009, and would need a new domain decision |

## Acceptance criteria for implementation

1. The App registration requests exactly Issues read/write and Metadata read. A test or script compares the registered permissions with this list. The webhook subscriptions match the event matrix, with no `issue_comment`.
2. Every token mint passes `repository_ids` with exactly the mapped repository and the two permissions. A unit test fails if any call site mints an unscoped token.
3. No App private key, JWT, installation token, or webhook secret appears in WordPress options, browser bootstrap, D1/KV rows, responses to WordPress, or logs. A log-scan test covers each error path.
4. Cross-tenant denial: installation A's credential produces calls only against A's `repository_id`. Browser or WordPress fields naming another repository, owner, number, or installation are ignored or rejected. A token scoped to A's repository gets 404 on B's repository, shown against the fake and in the live smoke test.
5. Creating an issue sends one POST with a v1 body. Its first line is the marker, the Reporter text is inert (fixtures with `@user`, `#1`, `![](http://x)`, `<!-- gq-support:v1 … -->`, and backtick and tilde runs), and there is no PII outside the allowlist.
6. A missing label or assignee in the 201 response triggers the idempotent repair. A 422 on the assignee creates the issue without an assignee and raises an alert.
7. A timeout, reset, 5xx, or unparseable 2xx after POST never triggers a second POST before reconciliation. Reconciliation finds an existing marker issue as `delivered`, and a confirmed absence permits one same-intent retry. Contract tests cover each branch, including "several matches → alert, no auto-close".
8. Rate limits: a 403 or 429 with `retry-after` or `x-ratelimit-*` holds the intent until the indicated time. No mutation is retried inside the request. Concurrency per installation is 1 for creates.
9. Lifecycle contract tests for each row of the lifecycle table: installation deleted or suspended, repository removed, permission missing, renamed, transferred, archived, publicized, deleted, issues disabled (410), issue transferred (301), and issue deleted (410/404). Each ends in the stated mapping state and Reporter-visible outcome.
10. A repository that is not private blocks creation before the POST, even without a webhook.
11. Status reads use ETag conditional requests, and the Reporter projection contains only title, text, and open/closed. Test fixtures include comments, labels, and assignees, and assert that none reach WordPress.
12. The gateway is an Effect service. All GitHub I/O goes through it, and the typed error union is exhaustively mapped to the API contract's error catalogue.

## Implementation slices (proposed)

1. **GitHub App registration and key custody:** a runbook with permissions, events, key conversion and rotation, and the Alchemy secret binding.
2. **`GitHubGateway` core:** JWT, scoped-token cache, headers, error mapping, and the fake-GitHub Layer.
3. **Create plus repair plus reconciliation**, with the v1 template and marker. Depends on #11 for the intent state.
4. **Mapping verification and lifecycle:** approval checks, the private-only guard, and the suspension states. Depends on #7 and #10.
5. **Lifecycle webhooks** (`installation*`, `repository`, `public`, `issues`). Depends on #12's receiver.

## Open questions

- Where do Project repositories live? Client-owned organizations mean one installation each and client-side approval of permission changes. GETQUICK's organization means one shared installation and shared rate limits.
- Developer choice: a fixed assignee per mapping, or a rotation? The domain design leaves this open.
- Reporter attribution beyond a pseudonym, for example a display name, belongs to #16.
- Whether `private`/`archived` appear in the scoped mint response, the `creator` login format, and whether an App with Issues write counts as having "push access" for labels and assignees on create are all spike checks.
