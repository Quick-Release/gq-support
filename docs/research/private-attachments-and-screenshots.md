# Optional private attachments and on-demand screenshots

Research resolution for **[Design optional private R2 attachments and on-demand screenshots](https://github.com/Quick-Release/gq-support/issues/15)**. Researched 2026-10-18 against local baseline `c274535`. Planning only: no feature implementation, resource provisioning, privacy approval, or production validation is implied.

## Decision and status of the evidence

**Defer attachments and screenshot capture for the MVP.** Plain-text reporting remains usable without R2, an evidence login, raster processing, or capture dependencies. The [WordPress-native, GitHub-backed client support map](https://github.com/Quick-Release/gq-support/issues/1) explicitly makes these optional; the [privacy decision](https://github.com/Quick-Release/gq-support/issues/16) approves only the plain-text inventory. There is no approval to provision R2 or collect screenshots. This research resolves the design direction and deferral; it does not accept the feature for release.

**Future candidate:** existing-file PNG/JPEG evidence first, private R2 behind authenticated Worker access, server-issued opaque keys, mandatory server-side decoding and canonical re-encoding before association, and a stable authenticated evidence page for engineers. Native display capture can follow as a separately enabled input to the same review/validation pipeline. Defer DOM capture and direct presigned transport unless later evidence justifies their additional complexity. This selects no new provider/vendor; it compares the already specified R2, browser, WordPress, and existing GitHub integration APIs.

Labels used throughout:

- **Verified platform fact:** linked official documentation or specification, checked on the research date. Specifications describe API behavior, not a verified browser compatibility matrix.
- **Existing project decision:** current local design/ADR or fetched issue; not necessarily fully implemented.
- **Proposed policy:** all future routes, schema, numerical limits, deadlines, authentication sessions and release criteria below. These require approval and feasibility tests; they are not provider limits or present product behavior.

Inputs read with `gh issue view --json ...` (including comments and labels): [Capabilities, REST authentication, and tenant/resource authorization](https://github.com/Quick-Release/gq-support/issues/4), [Choose per-client Cloudflare isolation and provision resources with Alchemy](https://github.com/Quick-Release/gq-support/issues/9), [Design minimal D1 metadata, receipts, and rebuildable GitHub projections](https://github.com/Quick-Release/gq-support/issues/10), the privacy decision, target research issue and parent map. Historical HMAC language in issue comments is superseded by ADR 0012's Ed25519 design.

Local authorities reviewed: [domain vocabulary](../../CONTEXT.md), [domain design](../support-domain-design.md), [security](../support-security-design.md), [onboarding](../support-onboarding-design.md), [API contract](../support-api-contract.md), [storage](../support-storage-design.md), [privacy](../support-privacy-design.md), [delivery](../support-delivery-design.md), [performance budgets](idle-performance-budgets.md), relevant ADRs (especially 0002, 0009–0019), [`storageFor`](../../worker/src/storage.ts), and the [Alchemy stack](../../worker/alchemy.run.ts). Where older domain prose differs, ADR 0015's Submitted text projection and the delivery privacy amendment govern. The current API has no attachment route/field; extending it needs an explicit decision under ADR 0009. No ADR/domain/API files are changed here.

## Transport comparison and WordPress destination

**Verified facts:** R2 presigned URLs authorize one operation on one object, expire between one second and seven days, and are reusable until expiry. Supported methods include PUT/GET/HEAD/DELETE; presigned HTML-form POST is unsupported. Signing Content-Type binds that header, not file validity. They use the S3 API endpoint rather than a custom domain. Treat them as bearer capabilities. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

**Proposed comparison:**

| Approach | Benefit | Cost and security consequence | Candidate decision |
|---|---|---|---|
| Browser → WordPress → authenticated Worker → private R2 | Fits the existing identity boundary; enforce authorization on every request and count actual bytes before accepting them; no object bearer URL in browser | Extra WordPress bandwidth, temporary disk/hosting limits and bounded PHP/HTTP time; new binary transport contract required | Prefer for small future files, subject to load testing |
| Direct presigned PUT into quarantine | Avoids relaying bytes through WordPress | Reusable write capability, cancellation cannot retract it individually, weak pre-ingest size enforcement, CORS configuration, overwrite/finalize races, separate signer credentials | Defer; use the alternative protocol below only after a new review |
| Presigned GET | Reduces download relay work | Whoever obtains the URL can read until expiry despite role revocation; can leak in issue text, referrers and logs | Reject for the initial future release; authenticated streaming only |

R2 buckets start private; enabling either `r2.dev` or a public custom domain exposes an independent access path. **Policy:** disable both in every stage; the evidence hostname must route to the Worker, not directly to an R2 bucket. A bucket binding is service access, never proof that a particular person may read an object. [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)

R2 CORS controls browser cross-origin access, including presigned requests. **Inference:** it cannot protect against someone using the same URL outside a browser. For the preferred proxy path no browser-to-R2 CORS is needed. If direct upload is later accepted, use exact approved origins, minimal PUT/HEAD methods/headers, and no wildcard credentials policy; authorization still happens before URL issuance. [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)

`media_handle_upload()` is designed to save an uploaded file and create a WordPress attachment, including attachment metadata. It is appropriate only if the Media Library is intentionally the destination. This candidate does not use it: a private attachment post does not itself secure the binary URL served from uploads, CDN copies, generated sizes or backups. Native `wp_get_image_editor()` can select a supported local image editor; it does not establish a centrally trusted validation boundary on a potentially compromised installation. [Media upload API](https://developer.wordpress.org/reference/functions/media_handle_upload/), [image editor API](https://developer.wordpress.org/reference/functions/wp_get_image_editor/)

For proxying, propose private temporary files outside web-served uploads, random names, a signed binary request whose digest covers the exact bytes and whose path binds the upload attempt. Clean temp files in `finally` and a bounded stale-file sweep. Never base64-wrap multi-megabyte files in the current small JSON adapter. Approve separate body/response limits, digest computation, stream handling and timeouts; the current 64 KB response cap and create/read timeouts cannot silently become binary transport defaults. Attachment failure must never block unrelated WordPress rendering or the plain-text create path.

## Authorization, ownership, keys and metadata

**Existing project decisions:** Client is the customer boundary; records belong to a Slot, not a replaceable installation ID (ADR 0014). The verified Ed25519 key resolves Slot → Client/environment/repository from trusted configuration. `storageFor(slot)` scopes every Slot-owned query and can route a Client to a dedicated database later. Sharing a repository, Client, email or issue number conveys no cross-Slot authority. Installation attestation cannot authenticate a cross-site manager (ADR 0010).

**Proposed authorization paths:**

1. **Reporter upload/finalize/remove:** same-site WordPress session and `wp_rest` nonce; check current site membership and `gq_support_submit_requests` on every operation, then require ownership of the draft reservation or associated request. WordPress derives subject/scope, signs a new service call with a fresh replay ID, and never forwards its nonce. Worker independently verifies credential, Slot, subject, request association, state, expiry and suppression. Browser-supplied Client, Slot, bucket, key, repository or subject overrides are rejected. WordPress cookie/nonces are the native REST mechanism; capabilities remain a separate check. [REST authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/)
2. **Reporter download/list:** through WordPress and the same independently verified association. Own reads require submit capability; an explicit `gq_support_view_site_requests` grant permits read-only evidence access in the same Slot, consistent with request visibility. This grants neither upload nor removal of another Reporter's file. Settings capability, Administrator/Super Admin role name, or a label confers no extra evidence authority. Clear local blobs/state on identity changes; never automatically replay a write after reauthentication.
3. **Developer/engineer:** the separate person-authenticated candidate in the next section. An installation key cannot activate this path. No browser→Worker Reporter session is added.
4. **Operator/privacy cleanup:** separately authenticated existing operations tooling with narrowly scoped cleanup/export authority, audited by opaque job/Slot IDs. A WordPress settings user cannot invoke it. Workers performing validation/cleanup act as service identities against D1 state, not user-supplied object paths.

Unknown IDs and out-of-scope IDs yield the same 404 without object metadata. Fail closed on auth, quota, storage or suppression lookup failure. Revoke access immediately for erasure/offboarding; a connection failure alone does not erase content. A compromised WordPress server can still impersonate users within its approved Slot; service-side quotas and validation limit this residual risk.

**Proposed storage:** one shared private R2 bucket per stage in the project's **Tipme** account (`8f38791a8c37b182239af2a385ab3c31`), only if later approved. No per-Client bucket by default; prefixes are organizational, not security boundaries. Extend the scoped storage interface with evidence operations; do not permit handlers to call arbitrary bucket keys. The current SQL checker must explicitly cover new tables, with narrow named cross-Slot sweeper operations and atomic quota methods. A future dedicated-Client route must select both metadata and binary storage consistently; never allow runtime bucket selection from client input.

Server generates independent cryptographically random identifiers (at least 128 bits of entropy). Example internal keys: `quarantine/<opaque-slot-ref>/<attempt-random>` and `clean/<opaque-slot-ref>/<object-random>`. Separate random public evidence ID resolves through D1; no R2 key appears in links. Never put an email, username, original filename, origin URL, report text or GitHub title in a key. Do not deduplicate across Clients or accept browser-selected keys. Stage is selected by deployment binding, never by a request field.

Proposed authoritative rows: `attachment` (opaque ID, Slot, request ID or uncommitted draft reservation, subject, installation audit ID, state, current generation, byte reservation, timestamps, expiry/deletion state); `attachment_attempt` (Slot/attachment composite FK, generation, internal quarantine/clean keys, verified byte sizes/type/dimensions, SHA-256, source ETag, decoder policy version, lease and errors as classes); quota reservations and cleanup jobs. Enforce composite request/Slot FKs and uniqueness on `(slot, subject, draft-or-request, client_attachment_id)` plus generation. Index due expiry/cleanup and `(slot, request_id, state)`. Use primary reads for authorization/finalization. These are operational evidence associations, not another ticket database. No original filename, raw DOM or annotation history is needed server-side.

R2 location must be approved separately: D1's `eu` setting does not constrain R2. R2 documents jurisdiction restrictions and jurisdiction-specific bindings/endpoints; location hints are not an equivalent guarantee. Propose EU jurisdiction for review, without claiming that Worker execution, WordPress processing, GitHub or downloads remain in the EU. [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)

## Stable GitHub evidence links and real engineer authentication

**Proposed policy:** issue text may contain only a stable plain Markdown link such as `https://<approved-evidence-host>/e/<opaque-evidence-id>` with a generic label. It identifies a resource and grants no authority. No inline image, R2 URL, presigned query, original filename or auth token is posted to GitHub. Link previews, crawlers and unauthenticated HEAD/GET receive a generic login page with no filename, thumbnail, Client name or request detail. The service resolves the pinned request/repository association, not a repository chosen in the URL. Copying a link into another repository cannot expand access.

**Concrete future candidate using the existing GitHub App:** add a reviewed web authorization flow for engineers. On a person clicking the link, start GitHub App user authorization with random single-use `state`, S256 PKCE, exact registered callback and an allowlisted relative return target; exchange the returned code server-side. GitHub documents this flow, including state verification and PKCE. It requires an App client secret/callback configuration that the present installation-only MVP does not establish. [GitHub user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)

Use the user token with `GET /user` to establish the numeric human GitHub ID; this endpoint supports GitHub App user tokens without extra permissions. Retain only ID/current login needed for checks, never returned profile/email data. [Authenticated user API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)

Policy requires **both** an Operator-reviewed engineer grant `(numeric GitHub user ID, approved repository/Slot scope)` and a fresh positive repository permission check against the pinned private repository. Resolve its current name from numeric ID and verify that ID; use `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, require `read`, `write` or `admin` base permission, and confirm the response's numeric user ID. GitHub supports App installation/user tokens for this endpoint with Metadata read; its base permission includes inherited grants. Use the existing repo-scoped installation token only for this verification; the human identity came from the user flow. [Repository permissions API](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user)

On every binary request recheck local engineer grant, resource/suppression state, repository private/access status and live collaborator permission; no cached positive authorization. GitHub outage, permission removal, App removal, public/archived/transferred repository or suspended mapping denies engineering downloads pending review. This intentionally adds a stricter boundary than merely having a GitHub login. Engineer read access never grants Reporter impersonation, attachment deletion or cross-Slot management. Verify the exact App permissions and organization/SSO restrictions in a future integration rehearsal; no broader Contents/admin grant is assumed.

Propose a random server-side session referenced by an HttpOnly, Secure, SameSite=Lax host-only cookie, 15-minute idle/one-hour absolute lifetime, logout/revocation and CSRF protection for mutations. Store only a hashed session ID and minimal scope/identity; encrypt transient user tokens server-side and discard at logout/expiry; no refresh-token persistence in the first candidate. Authentication flow state lasts five minutes. A restore epoch invalidates all pre-restore engineer sessions and authorization-flow state; restored session rows never revive a logged-out person. Never place sessions in localStorage or evidence URLs. A generic "authenticated" page without this real identity/grant/check protocol is insufficient.

**No bearer logs:** disable or redact default invocation URL/query/header/body capture, OAuth callback codes, cookies, Authorization, nonces, signatures, upload URLs and provider bodies across Worker, WordPress, reverse proxy, tracing and error reporting before enabling these routes. Log route templates, safe correlation/job ID, Slot, status and error class only; omit evidence IDs/keys/subjects and hashes. OAuth callbacks must not load third-party assets and must redirect to a clean URL after exchange. Use `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, no third-party analytics, and no CDN/Cache API storage. Test automatic platform logs as well as application logger redaction.

Download streams only a committed clean object, with canonical `Content-Type`, trusted length, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment; filename="evidence.png"` (or `.jpg`) and no user-derived header text. A dedicated authenticated preview may display that same clean raster with a restrictive CSP; originals/quarantine are never served. Disable range requests initially to simplify authorization/size accounting. Recheck before opening the R2 stream. Revocation cannot recall already downloaded bytes or stop an already delivered response; disclose that residual limitation.

## Limits, raster validation and active content

Everything numerical here is a **proposed starting policy**, requiring load/security validation and Client approval:

- PNG and JPEG only; single static image, no APNG, GIF, WebP, AVIF, SVG, HTML, PDF, archive, video, remote-URL import or arbitrary binary. Extension/declared MIME disagreement is rejected. Browser `accept` is only a convenience filter.
- At most 3 committed/reserved attachments per report, 5 MiB actual input per file, 10 MiB aggregate input per report and 5 MiB canonical output per file/10 MiB per report. Count rejected attempts toward abuse budgets, not permanently toward committed count. No multipart/resumable uploads initially.
- Maximum 4,096 pixels on either axis, 4 million total pixels, one frame, 8-bit canonical output, 32 MiB decoder working memory and a 2-second CPU validation budget per attempt. Reject oversize before full decode where possible, then enforce during decode; never trust header dimensions alone. Enforce output limits too.
- At most 2 unexpired attempts per Reporter and 4 per Slot, 1 decode at a time per Slot, and an initial stage-wide decode permit of 1. Reserve storage for input **and** possible canonical output. Proposed 100 MiB rolling 24-hour input per Reporter, 500 MiB per Slot, 1 GiB retained+reserved per Slot, 5 GiB per Client across Slots, and 20 GiB per stage. Add bounded read/download bandwidth limits (100 MiB per person per hour, 1 GiB per Slot per hour) to prevent repeated authorized downloads becoming unbounded work.
- Atomically reserve count/bytes/concurrency before reading; quota failures reject without acknowledging acceptance. Release/convert each reservation exactly once under a generation guard after deletion/commit; uncertain R2 writes retain conservative quota until reconciled. Concurrent tabs, re-enrollment and rejected-file loops cannot reset rolling limits. Shared-Client/fleet quota checks require fixed named scoped operations, not an application-side read-then-increment. Quota-store outages fail closed.

The service must count bytes actually received with a bounded reader, reject compressed HTTP request bodies, reject missing/false framing as appropriate to the reviewed transport, and abort on the first byte beyond the cap. Content-Length can reject early but cannot prove compliance. The WordPress proxy must cap bytes before temporary disk exhaustion, verify its local temp copy/digest, and enforce hosting limits too; effective limits may be lower than policy. Never buffer an unbounded body in Worker memory.

**Verified runtime constraints and inference:** Workers documents a 128 MB per-isolate memory limit shared across concurrent requests, including Wasm allocations. Its documented web APIs do not provide the browser DOM/canvas image decode pipeline; a Worker cannot be assumed to have `Image`, `createImageBitmap` or a native raster decoder because a browser does. Wasm execution is supported, but decoder safety and resource fit are separate questions. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [runtime APIs](https://developers.cloudflare.com/workers/runtime-apis/web-standards/), [Wasm runtime](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)

**Proposed mandatory server pipeline:** privately quarantine exact bounded bytes; check signature, structure, dimensions, frame count and allowed encoding; fully decode with a maintained, reviewed decoder; reject truncation, malformed streams, animation, unsupported color/bit-depth modes and trailing/polyglot payloads; apply orientation, normalize color, then encode a fresh canonical PNG/JPEG from pixels. Do not copy EXIF/GPS, XMP, comments, IPTC, ICC profiles, thumbnails, text chunks, ancillary metadata or trailing source bytes into output. Use a strict encoder metadata allowlist, ideally only mandatory format data. Metadata stripping must be proved by reading the result with an independent inspector, not inferred from a new extension or MIME header.

A bundled audited Wasm decoder/encoder on the existing Worker is a **feasibility candidate, not a selected dependency or verified capability**. It needs bounded allocations, malicious-corpus tests, cancellation/CPU behavior, patch ownership and stage-wide load tests. The proposed decode permit does not remove unrelated requests' isolate memory use. A JavaScript timeout or `Promise.race` cannot by itself interrupt synchronous Wasm decode; prove decoder-enforced work/allocation bounds and safe interruption rather than assuming a timer is a CPU sandbox. If that cannot be made safe within limits, keep the feature deferred and return for a separate execution-design decision; this note does not select a new processing vendor. WordPress/browser preprocessing improves privacy and bandwidth but is never central validation because both are untrusted input sources.

WordPress's `wp_check_filetype_and_ext()` attempts real-type detection but can fall back to the filename extension; it cannot replace full decode. Imagick's `strip_meta()` strips metadata but preserves color profiles, illustrating why blanket "WordPress strips everything" claims are unsafe. [File type API](https://developer.wordpress.org/reference/functions/wp_check_filetype_and_ext/), [Imagick metadata implementation](https://developer.wordpress.org/reference/classes/wp_image_editor_imagick/strip_meta/)

No original file is promoted or made downloadable. MIME sniffing, magic-byte inspection and a successful decoder call alone are insufficient. This is active-content risk reduction, **not a claim of malware freedom**: decoder vulnerabilities and malicious pixels/social engineering remain. Reject all executable/active types and unsupported data rather than rendering them in a preview. No antivirus provider is selected and no native R2/Worker malware scanner is assumed. If Client policy requires scanning, it becomes another approval gate; results must be bound to the exact immutable source hash/generation and cannot substitute for re-encoding. Security incidents revoke access and delete/quarantine copies under an approved runbook; no indefinite malware sample retention.

## Future protocol and sequence diagrams

All routes below are illustrative future extensions, absent from the current API. Every WordPress→Worker call has a fresh signed replay ID; attachment/draft idempotency IDs are separate from authentication nonces. The diagrams describe authorization and durable state, not an atomic D1+R2 transaction.

### Upload and draft reservation

Do not create fake support requests to upload files. A short-lived draft reservation belongs to `(slot, subject, Submission ID)` but is separate from a durable report receipt. Browser review stays local until an explicit Upload action. The same text report can always be submitted without evidence.

```mermaid
sequenceDiagram
  actor R as Reporter
  participant B as Browser
  participant WP as WordPress REST
  participant W as Worker
  participant D as Scoped D1
  participant O as Private R2
  R->>B: Choose file, preview, crop/redact, approve upload
  B->>WP: Reserve evidence for own draft (cookie, nonce)
  WP->>WP: Check capability and derive subject
  WP->>W: Signed reservation with fresh replay ID
  W->>D: Verify key/Slot, suppression; atomically reserve quota
  D-->>W: Opaque attachment ID, generation, 30-minute expiry
  W-->>B: IDs and limits via WordPress (no R2 key)
  B->>WP: Upload bounded bytes for this generation
  WP->>W: Signed exact bytes and digest; private temp relay
  W->>D: Recheck owner, expiry; claim receiving generation
  W->>O: Write unique quarantine object with counted byte cap
  W->>D: Conditionally record stored size/hash and uploaded state
  W-->>B: Uploaded, not yet validated or attached
  Note over W,O: Lost D1 acknowledgement leaves private orphan for sweep
```

### Finalize, validate and associate

```mermaid
sequenceDiagram
  participant B as Browser via WordPress
  participant W as Worker
  participant D as Scoped D1
  participant V as Reviewed bounded raster processor
  participant O as Private R2
  B->>W: Signed finalize (attachment ID, generation)
  W->>D: Reauthorize subject/Slot; CAS validation lease; check suppression
  W->>O: Read exact quarantine generation
  W->>V: Decode, validate, strip metadata, canonical encode
  alt Invalid, over budget or canceled
    W->>D: Mark rejected or canceling; deny reads
    W->>O: Delete quarantine and any clean orphan
  else Valid
    W->>O: Create fresh immutable clean key, never overwrite
    W->>D: CAS ready with hash/key, generation and quota conversion
    W->>O: Delete original quarantine
    B->>W: Submit text and optional ready IDs (new future contract)
    W->>D: Atomic intake plus own ready associations and quota checks
    W-->>B: Durable text receipt; evidence state separately
  end
  Note over W,D: Recheck expiry, owner, cancellation and erasure before every commit
```

An alternative later attach operation can bind an owned ready object to an already accepted own request without reposting its text. Commit requires exactly one generation/current owner and all composite scopes; an affected-row count of zero must prevent dependent association/quota writes. A same-key retry returns the existing state; conflicting bytes or target gets 409. Clean objects become readable only after association, not on upload/finalize success alone. Draft reservations cannot target somebody else's receipt or a different Slot.

Issue delivery must not wait for a file: if processing fails or expires, accept text, show "report accepted; evidence not attached" and offer explicit retry/removal. For delivery already completed or outcome unknown, show a stable **request evidence collection** link authorized through the same rules, so later attachment association does not require another GitHub create or a fragile issue-body edit. The collection can be empty; the URL is not a bearer capability. Future text/evidence contract approval must preserve same Submission ID/different text conflict behavior without accidentally treating a file retry as a new report. Never replay uncertain GitHub creates to repair missing evidence.

### Authenticated download

```mermaid
sequenceDiagram
  actor A as Reporter or engineer
  participant G as WordPress or engineer login gateway
  participant W as Worker
  participant D as Scoped D1 and suppression ledger
  participant GH as GitHub identity and permissions
  participant O as Private R2
  A->>G: Follow stable evidence link or request own download
  alt Reporter
    G->>G: Cookie, nonce, current capability and resource check
    G->>W: Signed Slot-bound subject/scope request
  else Engineer
    G->>GH: User authorization code flow if no valid session
    GH-->>G: Verified user identity via user token
    G->>W: Server session plus evidence ID
    W->>GH: Fresh pinned private-repository permission check
  end
  W->>D: Resolve authorized Slot and committed attachment; deny tombstones/expiry
  alt Authorized and retained
    W->>O: Read stored clean key only
    O-->>A: Stream via authenticated gateway, no-store, nosniff, attachment
  else Missing or unauthorized
    W-->>A: Generic denial; no object metadata
  end
```

The Reporter path uses the WordPress UI, not an engineer login requirement. Engineer scope lookup is a narrow named operation that discovers only grant-approved Slots before ordinary `storageFor(slot)` reads. Export uses the same binary authorization/validation rules, with bounded pages/links and no public export archive.

### Removal, erasure and retention deletion

```mermaid
sequenceDiagram
  actor A as Owner or authorized privacy operator
  participant G as WordPress or operations tooling
  participant W as Worker
  participant L as Independent suppression ledger
  participant D as Scoped D1
  participant O as Private R2
  A->>G: Remove evidence or erase own subject in current Slot
  G->>W: Authenticated, scoped deletion request
  W->>L: Durably record deletion/suppression (never restored with main D1)
  W->>D: Tombstone association, fence generations, enqueue cleanup
  W-->>A: Accepted deletion, binary access denied; physical cleanup pending
  W->>O: Delete quarantine, clean outputs and canceled generations
  W->>O: Verify keys absent after active writers drain
  W->>D: Mark physical cleanup complete; release quota once
  Note over W,L: Failures retry; never report complete while any write/delete is uncertain
```

Deleting evidence is not deleting a GitHub issue. Links become unavailable; known engineer downloads, quotes, screenshots of evidence and GitHub notifications/history remain residual-copy review items. Removing a file after association must append suppression just like privacy erasure so restore cannot revive it. For age-based purges, existing privacy policy does not require ledger tombstones, but expiry checks must deny access before serving restored rows and purge them before any processing resumes.

## State, deadlines, retries and direct-upload alternative

**Proposed state machine:** `reserved → receiving → uploaded → validating → ready → committed`; any nonterminal state may become `canceling`, `rejected` or `expired`; committed removal becomes `deleting`; all converge to `deleted` after verified physical cleanup. D1 state controls visibility. Lease expiry is not proof a worker stopped; generation fencing prevents stale commits, while cleanup must drain or reconcile active writers before declaring deletion complete.

Concrete proposed lifecycle:

- Reservation and all unassociated bytes expire **30 minutes after reservation**, including validated `ready` output. Do not extend indefinitely by retries. A transfer gets at most 60 seconds; a validation lease is 60 seconds with a 2-second CPU budget. Expired lease owners cannot publish; uncertain writes are reconciled before replacing generations.
- Reject/cancel immediately denies access and requests deletion. Remove from browser memory immediately; stop tracks, abort fetches and revoke object URLs. An abort cannot prove the server received nothing. A late successful upload remains inaccessible and must be swept. Navigation/closing cannot be relied on to send a cleanup request.
- A minute bounded D1 sweep schedules due expiry/deletion fairly per Slot. Retry deletion at approximately 1, 5, 15 and 60 minutes with jitter, then hourly. Alert after one hour or repeated failures; keep opaque cleanup metadata and conservative quota until success. Operational target: remove originals on successful validation and rejected/canceled/expired data within one hour in a healthy system; this is not a promise during provider outage.
- A daily paginated R2 inventory pass reconciles quarantine/clean keys with D1. Delete unmatched objects only after a 24-hour age/grace check, including interrupted writes and clean objects whose D1 commit failed. Record the creation/generation cleanup intent before writing so late writers are discoverable. Pagination/progress and per-run work limits must survive restart.
- Add a **one-day quarantine lifecycle rule** as a backstop, not the access-control deadline or proof of erasure. R2 documents lifecycle deletion as asynchronous, typically within 24 hours of expiration. Prefer no blanket clean-prefix lifecycle because open requests/reopens need D1-controlled retention. [R2 lifecycle behavior](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- Status reconciliation is a user action while the panel is open. Retry the same attachment idempotency key/generation for ambiguous acknowledgements; never overwrite stored bytes. A confirmed failed transfer can explicitly request a new generation/key after old-write reconciliation, within the original reservation expiry. Reauthentication requires renewed user intent. Capture or upload failure leaves the text draft/accepted report intact.

R2 documents strong object consistency and conditional Worker operations, including ETag conditions. There is still no atomic transaction joining D1 association and R2 writes. **Policy:** use immutable keys, guarded state transitions, durable cleanup intents and orphan reconciliation; do not infer a filesystem rename or multi-store atomic commit. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/), [Worker object API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

**If direct presigned PUT is ever adopted:**

1. Authenticate and reserve the same quotas/counts before issuing a **60-second** PUT URL for one unique quarantine attempt key; return only via no-store response. Sign the exact allowed Content-Type and, only if proven supported by the actual R2 S3 operation, length/checksum/conditional headers. Do not claim an S3 POST `content-length-range` policy exists for R2 PUT. A reservation cannot itself stop an over-limit direct transfer; if a strict provider-side byte bound cannot be demonstrated, direct PUT fails this design's quota gate and remains disabled.
2. Browser cannot PUT into `clean/`, select a key, delete objects, or receive listing credentials. Quarantine has no read path. Finalize reauthorizes and validates actual size/hash/type; a URL is not an attachment receipt. CORS does not make it single use. Rate-limit reservation/issuance, count all attempts and budget excess-object cleanup costs.
3. An unexpired URL may overwrite quarantine **during or after** validation. Never validate a key and then later copy whatever currently occupies it. Read one bounded source snapshot using ETag-conditional access, hash the exact bytes consumed, validate/re-encode those same bytes, and write a fresh service-only immutable clean key. Conditional source failure or hash mismatch restarts/rejects. Commit only the clean hash/key under a generation CAS. Replay writes can only change disposable quarantine; they cannot alter promoted evidence.
4. Finalize is idempotent for that exact generation/hash, rejects a conflicting finalize/target, and never promotes an overwritten original. If conditional create-only PUT is proven in a future compatibility test, use it as defense in depth; the protocol must remain safe without assuming single-use URLs.
5. Cancel/erasure immediately suppresses finalize/download, but a presigned capability cannot be recalled individually through D1. Keep the attempt cleanup record, wait past URL expiry plus clock/in-flight drain allowance, then delete/reconcile quarantine again. Replayed writes after initial cleanup can recreate an orphan; cleanup is incomplete until writers are drained and absence is verified. Broad token revocation is incident response, not routine cancellation. Never sign the permanent key or return presigned GET links for engineers.

## Retention, export and privacy reconciliation

These are **proposed additions**, not amendments already approved under the privacy decision. The governing document remains [Support privacy design](../support-privacy-design.md), including the [delivery privacy amendment](../support-delivery-design.md#erasure-retention-and-restoration) and its implementation gate, [Make delivery erasure and retention safe under unknown outcomes](https://github.com/Quick-Release/gq-support/issues/46).

| Proposed inventory row | Purpose and minimum data | Access/destination | Retention and deletion owner |
|---|---|---|---|
| Local selection/capture, crop and redaction state | Reporter review; pixels only, no DOM dump | Browser memory; private WP relay temp file only after upload | Browser: cancel/remove/navigation/logout/user change; WP temp: request cleanup plus hourly stale-temp sweep, 24-hour maximum during failure |
| Quarantine source | Strict validation of exact bytes | Private stage R2, processor only | Delete after validation; 30-minute unassociated expiry; cleanup retry + one-day lifecycle backstop |
| Canonical clean raster | Optional support evidence | Private R2; own Reporter, explicit same-Slot reader, grant-approved engineer, privacy operations | With associated request schedule below; unassociated ready output 30 minutes |
| Evidence associations/attempts/quotas | Ownership, idempotency, bounded work and cleanup | Scoped D1/service; no original filename | Live content metadata with request; attempts purged after cleanup; rolling quota debit retained only its 24-hour window, concurrency until reconciled |
| Deletion suppression/cleanup | Prevent resurrection and verify physical deletion | Existing independent suppression ledger, operations | Resolved tombstone 45 days after resolution; unresolved cleanup minimal IDs/keys until resolved/reviewed exception, no pixels/subject |
| Engineer auth/session/grants | Authenticate people separately from WordPress | Service-only D1/encrypted transient token storage, Operator-reviewed grants | State 5 minutes; session/token at most 1 hour; delete expired sessions; grants until revoked, retention review required |
| GitHub evidence link | Find authenticated evidence collection | Pinned private Project repository | Client repository policy; after purge link denies access; no binary/bearer copied there |

Canonical evidence and live association retention follows the existing request rules: confirmed delivered/open is retained; confirmed delivered/closed expires **12 months after last observed close**, reopening resets that clock; never-confirmed-delivered expires no later than **12 months from acceptance**. Manual removal/Reporter erasure is earlier. Slot offboarding denies access and suppresses processing immediately, then purges all its evidence after **30 days**, leaving Client GitHub issues untouched. Disconnect/deactivation/uninstall alone must not delete shared resources or another Slot's evidence. The short staging deadlines apply even when no report was ever created; they are not extended by the 12-month schedule.

Erasure must include the subject's orphan/reserved uploads, every generation and generated output. Before purging the subject association, enumerate and record minimal key/attempt cleanup intents in the suppression ledger. An uncertain GitHub create requires restricted reconciliation metadata under the delivery amendment, **never retention of pixels to resolve it**. A late-discovered issue may retain a now-dead evidence link; report residual copies without re-uploading the erased binary. The 45-day tombstone window starts only after resolution and never terminates unresolved physical cleanup. Restore replays suppression before serving, resumes pending deletes, expires age-purged rows and prevents any ready/validating object from being blindly republished. No new R2 backup/mirror is authorized; assess provider residual copies and any future backup policy before release rather than claiming immediate global erasure.

Extend the existing WordPress exporter/eraser by mapping email → current site's subject locally; email never goes to the Worker and a same email in another Slot matches nothing there. Export should enumerate canonical evidence and offer scoped authenticated retrieval in bounded pages; no public archive. Export destinations and temporary-file lifetimes must be reviewed. An eraser reports `items_retained: true` while remote deletion, active-writer reconciliation or residual-copy review remains; logical denial is not physical completion. Native WordPress privacy guidance provides policy-guide/export/erasure integration, not approval for optional capture. [WordPress privacy APIs](https://developer.wordpress.org/plugins/privacy/)

Proposed collection copy, subject to Client/legal review: “Optional: attach a PNG or JPEG, or capture a screen after you choose to. Review it and cover private information before uploading. Only the final reviewed image is sent to GETQUICK's private Cloudflare evidence storage for this request; authorized support staff can view and download it. You can send the report without an image.” Show destinations, limits and the approved retention/removal policy before upload. This is a collection control, not a claim that one checkbox establishes every deployment's legal basis.

## Screenshot inputs and irreversible local review

| Input | Verified boundary / consequence | Future position |
|---|---|---|
| Existing raster file | No live display permission; the file may contain hidden metadata, private pixels or a false MIME type | First candidate; same preview/edit/explicit-upload and strict server pipeline |
| DOM reconstruction | Reading arbitrary cross-origin documents is restricted; canvas can lose its origin-clean state and refuse pixel export. A reconstruction also needs a rendering implementation whose CSS/font/iframe fidelity must be tested | Defer; do not promise a perfect screenshot, proxy foreign assets to defeat CORS, serialize hidden inputs, or upload DOM |
| Native `getDisplayMedia()` | Browser asks the user to choose a display surface; activation/permission and implementation availability constrain capture. Can expose other-origin or other-app pixels that a DOM reader cannot access | Separately approved, feature-detected option; fallback to file upload/text |

The browser security facts for DOM/canvas come from the [HTML cross-origin model](https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-objects) and [canvas origin-clean/export rules](https://html.spec.whatwg.org/multipage/canvas.html#security-with-canvas-elements). **Inference:** DOM reconstruction cannot guarantee native pixels for cross-origin iframes, tainted canvas, browser chrome, unsupported CSS, WebGL/video, fonts or virtualized/offscreen content. No DOM-capture library is selected or benchmarked here.

The [W3C Screen Capture draft](https://www.w3.org/TR/screen-capture/) specifies transient user activation, a chooser each time and nonpersistent capture permission. Constraints cannot guarantee the application chooses the current tab. It also calls out risks from capturing information from other origins. The draft is work in progress, so test actual supported browsers before release.

**Proposed native flow:** after explicit “Capture screenshot” gesture, invoke the chooser for video only (`audio: false`), take one bounded frame, immediately stop every track in success/error/cancel/unmount paths, and discard the video stream. No MediaRecorder, audio, continuous sampling, remote screenshot browser or background observer. Do not promise whole-page capture, a particular selected surface, hidden cross-origin content, mobile availability, or suppression of notifications/private tabs; the chooser/OS decides available surfaces. Permission denial or unsupported API returns to file/text flow. If loading editor code would consume transient activation, load it after the first explicit gesture and present a second explicit “Choose screen” button rather than calling the API after an arbitrary async delay.

Local review for **both** file and captured image:

1. Render a bounded local raster preview with dimensions/size, destination and a reminder to remove secrets. No upload occurs on selection/capture. Do not invoke an image renderer for SVG/HTML or fetch remote source URLs.
2. Offer keyboard-accessible crop, zoom and **fully opaque** rectangle redaction; blur/pixelation is not accepted as redaction. Give remove, recapture and cancel controls plus a file/text fallback. Crop/redaction controls require accessibility/usability validation.
3. On approval, draw only the cropped visible pixels into a fresh output bitmap, burn solid redactions into it, and encode a new static image. The upload is that flattened file, never original bytes plus an overlay/annotation list. Remove excluded pixels, original thumbnails, metadata and editing layers; examine output alpha channels to ensure hidden RGB cannot retain covered secrets. Server canonical re-encoding remains required even for this output.
4. Preview the **final encoded upload bytes** again. Explicit Upload commits them. Cancel/remove clears source and derived blobs, canvases, stream/video references, object URLs and edit history; uploaded-but-unassociated files get authenticated cancellation and expiry cleanup. Do not retain an original to support undo after sending. No OCR/automatic secret detector or automatic redaction is promised.

**Zero capture dependency before gesture:** no capture/editor code, preloads, prefetch, module import, Wasm decoder, DOM scan, canvas allocation, permission query/prompt, MutationObserver, media track, file read, thumbnail fetch or evidence network request on normal rendering, launcher load or ordinary panel open. Dynamic loading begins only after explicit Attach/Capture. A browser native decoder used for local editing is not a server trust boundary. Release must preserve existing public/closed-widget/first-open byte/request/SQL/timer budgets and WordPress's native React runtime. Close/cancel stops optional work; cleanup runs service-side, never by adding a persistent browser poller or WP-Cron job.

## Future acceptance and adversarial test plan

These are **meaningful future tests**, not tests implemented or executed by this research. Every criterion from the target issue has a corresponding observable outcome:

| Issue acceptance / scope | Future test and required outcome |
|---|---|
| Upload/finalize/download/delete sequences | Rehearse each diagram with lost acknowledgement, D1 failure before/after R2 write, stale lease, cancel during encode and erasure between authorization and commit. No object becomes readable before a single guarded association; deletion remains pending until absent after writer drain. Trace only safe IDs. |
| Per-Client isolation and server keys | Clients X/Y; X production/staging Slots share a repository; two Reporters in one Slot. Reuse submission/attachment IDs and forge Client/Slot/key/bucket/subject/repository fields. All foreign reads/mutations return indistinguishable 404; view-site is read-only within one Slot; temporary dedicated-Client routing moves both metadata/binary access consistently. |
| Reporter/install authorization | Expired nonce/session, revoked capability/key, deleted/replaced account, copied installation and forged signed subject/scope. No binary or metadata leak; an expired login never auto-replays upload as another user. Assert WordPress nonce is absent from service calls. |
| Engineer authentication | Wrong OAuth state/PKCE, replayed code, callback/return-target injection, fixed session cookie, engineer without grant, grant without repository permission, renamed user, collaborator removal, suspended/public/transferred repo, GitHub outage. All deny bytes; login is independent of a site key; copied GitHub evidence links grant nothing. |
| Guessed IDs, expired/replayed links | Guess public ID and raw R2 keys; try unauthenticated GET/HEAD, `r2.dev`, public domain, expired session, replayed finalize and wrong generation. No public object/thumbnail/size disclosure; same successful finalize is idempotent and conflicting target is 409. |
| Malicious MIME/active content | JPEG-named SVG/HTML, MIME mismatch, truncated raster, polyglot/trailing script, APNG, multi-frame input, malformed chunk, oversized dimensions, decompression bomb, malicious EXIF and hidden thumbnail. Reject before publication; independent output parser finds only approved single-frame pixels/metadata. Fuzz and patch-test the actual decoder; no claim of comprehensive malware detection. |
| Bytes/count/decode/quota concurrency | Boundary at/over every size/count/pixel/output limit; dishonest/missing Content-Length; slow chunked body; concurrent tabs/Slots of same Client; quota-store failure; crashed permit holder. Hard caps hold without unbounded allocation/disk growth, over-limit request fails, no quota double release or leaked permanent permits; ordinary report APIs stay responsive. |
| Direct upload alternative, if enabled | Reuse URL during/after finalize; overwrite source between HEAD and GET; different hash; expired URL; cancel then recreate quarantine before expiry; oversized direct PUT. Clean hash stays the exact validated one, never overwritten. No finalize after cancellation; cleanup catches recreated objects. If hard ingest bound cannot be shown, direct transport fails release. |
| Canceled reports and report-created/upload-failed | Cancel with no support receipt, close tab during PUT, text accepts while decode fails, issue delivered/unknown before evidence is ready. No synthetic issue or duplicate create; text remains valid, evidence error explicit; unassociated objects expire at 30 minutes. |
| Orphans, expiry and partial deletion | Advance clock; crash at each state transition; R2 delete unavailable; orphan clean object after failed D1 commit; many inventory pages. Access denied immediately at expiry; bounded fair sweep eventually removes all bytes, alert and honest incomplete erasure on failure, quota reconciled once. Lifecycle expiry is not treated as a successful delete acknowledgement. |
| No public/bearer links or logs | Inspect built assets, all issue payloads, log fixtures, actual invocation/reverse-proxy/OAuth error logs and referrers using canary tokens, filenames and pixels. Only stable authenticated links in GitHub; no content, cookies, signed URLs, codes, signatures, subjects or object keys in logs. No cache hit can bypass auth after revocation. |
| Preview, crop, flatten, remove/cancel | Golden image with secrets outside crop, under redaction and in transparent RGB/EXIF/thumbnail. Inspect final exported pixels/metadata, not just overlay DOM. Network remains empty before Upload; remove/cancel clears blobs/streams and invalidates staging; permission denial and keyboard-only use preserve text flow. |
| Zero capture cost and browser limitations | Instrument resources/imports/timers/media/DOM observers on anonymous page, closed launcher, normal panel open and a 60-second idle window before/after use. Zero capture/editor bytes and activity until gesture; existing deterministic budgets still pass. Test actual supported desktop/mobile browsers, cross-origin iframe/tainted canvas, chooser cancel and permission denial; no silent workaround or perfect-capture promise. |
| Retention/export/erasure/restore | Same email in two Slots exports/erases only one subject; include abandoned attempts. Exercise open/reopen, 12-month last-close and never-delivered acceptance limits, 30-day offboarding, disconnect/uninstall, 45-day resolved tombstones and unresolved cleanup beyond 45 days. Restore old D1 before erasure with an R2 orphan: no access or repromotion; suppression drains cleanup and reports residual copies. |
| Explicit deferral/release boundary | Packaged MVP has no attachment routes/accepted fields, bucket bindings or capture chunks. Plain-text success and provider outage/performance tests remain valid. Enabling requires the approvals below, not merely merging this note. |

## Future approval gates and unresolved work

1. **Product/map approval:** explicitly accept optional files; approve changed ADR/API surface, capability semantics, evidence collection link and integration with text idempotency/delivery. Native capture is separately enabled; DOM capture and presigned transport remain deferred unless specifically reopened.
2. **Privacy/Client approval:** extend the privacy inventory, deployment-specific collection copy/guide, export/erasure and residual-copy policy; approve retention/deletion SLOs, R2 jurisdiction/terms and engineer downloads. Implement the plain-text privacy and uncertain-delivery gates first. No assumption that the closed privacy ticket authorized screenshots.
3. **Security approval:** threat-review the actual decoder/encoder, validation corpus and resource budgets; confirm metadata/hidden-pixel removal. Resolve whether malware scanning is contractually required. Demonstrate safe processing on the existing runtime or keep disabled; no decoder or scanner has been selected here.
4. **Engineer authentication approval:** review GitHub App user authorization/client-secret custody/callbacks, organization restrictions, numeric engineer grants, live permission enforcement, session lifecycle and automatic-log suppression. Current App installation credentials alone do not satisfy this gate.
5. **Resource/operations approval:** only then extend Alchemy for a private shared bucket per stage in Tipme, with no public access, lifecycle cleanup, reviewed jurisdiction, non-destructive updates and guarded teardown. Validate D1/R2 reconciliation, quotas, concurrency, fair sweeps, incident response and restore/offboarding drills. No bucket, extra service or new provider is provisioned by this research.
6. **Compatibility/performance/accessibility approval:** binary WordPress HTTP transport and hosting tests, bounded raster feasibility, actual browser matrix and preview/crop keyboard tests; preserve packaged-plugin performance gates. Set measured post-gesture budgets before shipping; zero pre-gesture cost is already a requirement.

**Unresolved by design:** actual decoder dependency/resource feasibility, any contractual scan requirement, Client privacy/location sign-off, GitHub user-login integration/SSO rehearsal and measured hosting/capture behavior. These block future enablement, not the explicit MVP deferral. The recommended path is coherent only with these gates; do not present it as ready to deploy.

## Source validation record

Official Cloudflare, WordPress, GitHub, WHATWG and W3C pages linked beside their claims were opened through the web tool on 2026-10-18; no secondary articles or new service-provider catalog informed the recommendation. Repository issues were read via `gh` per the issue-tracker instructions. Current local sources were inspected at `c274535`; issue decisions can move independently of that commit. APIs were documentation-validated only: no authenticated GitHub evidence login, R2 provisioning/upload/deletion, decoder benchmark, browser capture or privacy approval was performed. The Screen Capture source is explicitly a draft; compatibility, quotas and candidate policies require the future tests above.
