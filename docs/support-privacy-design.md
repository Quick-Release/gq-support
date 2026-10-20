# Support privacy design

Decision record for [issue #16](https://github.com/Quick-Release/gq-support/issues/16). It covers what personal data the plain-text MVP holds, where it goes, how long each store keeps it, and how export and Reporter erasure work across WordPress, the Worker and GitHub. [ADR 0016](adr/0016-restores-never-rewind-revocations-or-deliveries.md) covers restores and the suppression ledger. [ADR 0017](adr/0017-d1-in-the-eu-jurisdiction.md) sets the D1 jurisdiction. [ADR 0018](adr/0018-erasure-redacts-github-and-reports-residual-copies.md) decides erasure in GitHub. Terms are defined in [CONTEXT.md](../CONTEXT.md). [The delivery decision](support-delivery-design.md) amends never-delivered retention and uncertain-create erasure handling. These are engineering requirements, not a compliance certification. This is a design, not a claim that it is implemented.

## Roles

The Client is the controller for its Reporters' data, and GETQUICK acts as its processor. A Reporter exercises their rights through the Client: the Client's site admin runs WordPress **Tools → Export/Erase Personal Data**, or tells GETQUICK, and an Operator runs the erasure. GETQUICK has no Reporter-facing intake for these requests.

## Scope and release gating

This covers the **plain-text MVP** only: Submitted text, Support status and Delivery outcome. Diagnostics (#14) and attachments or screenshots (#15) are **release-gated**. Before either ships, it must:

1. add its rows to the inventory below, with a purpose, minimum fields, destination, access, retention and deletion owner;
2. add its opt-in collection copy and its privacy-guide paragraph;
3. extend export and erasure to cover its data, including abandoned uploads for #15;
4. add its tests to the list at the end of this document.

The [Report context decision](support-context-design.md) narrows this gate: minimal, disclosed, removable WordPress/support-plugin versions and a coarse originating screen are approved for future MVP implementation; rich Technical details remain deferred and explicitly opt-in. Default context uses disclosure and removal controls, not the technical-details opt-in. Neither category is enabled merely by this decision: its inventory, review flow, export/erasure handling and adversarial/performance checks must ship together. Optional context is excluded from Reporter list/read projections and all logs.

| Approved future context | Collection and access | Retention and deletion owner |
|---|---|---|
| WordPress/support-plugin versions; coarse originating screen | Reviewed/removable by Reporter; service and private Project repository collaborators only | Browser draft/review memory follows draft lifecycle; D1 delivery-intent context cleared at terminal delivery outcome; GitHub context follows repository policy and Reporter erasure |
| PHP version, database engine/version, active theme slug/version (deferred) | Explicit technical-details action plus per-field preview/removal; same destination/access | Same limits/lifecycle as minimal context; no enablement before the optional-feature privacy gate |

The field-by-field source, trust, purpose, sensitivity and exclusion inventory is in the context decision. Export includes still-retained context even though the Reporter projection omits it. Erasure removes context from D1 and the App-authored GitHub body; history/notifications/Developer quotations remain residual-copy exceptions. No extra retention store is authorized for preview or retries. The existing Environment and opaque attribution remain separate and subject to ADR 0018.

## Data inventory and retention

| Data | Where | Purpose | Access | Retention | Deletion owner |
|---|---|---|---|---|---|
| Draft Summary and Description | Browser memory | Composing a request | The Reporter | Until reload, navigation or user switch. Never persisted | Browser |
| Reporter subject | WordPress user meta for that site | Pseudonymous ownership key | WordPress server | Until the user is deleted | WordPress (user deletion triggers erasure, see below) |
| Submitted text, Reporter subject, Submission ID, digest | D1 `support_request` | Reporter list, idempotency | Worker, scoped by Slot | Delivered: **12 months after the last observed close**; open delivered requests are kept and reopen resets the clock. Never confirmed delivered: text at most **12 months from acceptance**, unless erased sooner | Service purge job; erasure |
| Repository and issue IDs, status projection | D1 `support_request` | Delivery, status sync | Worker | With the request | As above |
| Delivery intent and bookkeeping | D1 `delivery_intent` | Delivery outbox | Worker | With the request | As above |
| `context_json` | D1 `delivery_intent` | Server context for the issue body (#14) | Worker | Set to `NULL` at a terminal state | Delivery |
| Issue title and body | GitHub, Project repository | The Client's engineering record | Project collaborators | The Client's repository policy | Redacted on erasure; otherwise the Client |
| Pseudonymous attribution (environment, installation reference, short subject hash) | GitHub issue body | Letting Developers ask an Operator about a request | Project collaborators | With the issue | Not personal data by itself; kept by redaction |
| GitHub notification emails | Mailboxes of watchers and assignees | GitHub behaviour | Recipients | Outside our control | **Residual copy** |
| Enrollment codes, keys, revocations, replay rows | D1 | Installation authentication | Worker, Operators | As in [storage design](support-storage-design.md). Keys and revocations are kept | Service |
| Suppression ledger | Separate D1 per stage, never restored with the main one | Stopping restores from bringing erased data back | Worker, Operators | **45 days** for resolved tombstones; unresolved remote cleanup retains only minimal reconciliation/suppression state until resolved or an explicit Operator exception, with erasure still incomplete | Service |
| Worker logs | Workers Logs | Operations | Operators | Workers Logs default; no Logpush in the MVP | Cloudflare. Out of erasure scope because logs hold no subject or text |
| D1 Time Travel history | Cloudflare | Recovery | Operators | 30 days (Paid plan) | Cloudflare; guarded by the ledger |

**Location.** D1 is created with `jurisdiction: "eu"` (ADR 0017). Workers execute wherever the request lands, and the GitHub repository is hosted by GitHub. Any data-location statement to a Client must name all three.

**Logs.** A log line may contain the request `id`, the Slot, the intent `id`, a numeric GitHub repository ID, an error class and an HTTP status. It must never contain Submitted text, the Reporter subject or its hash, the Submission ID, email, names, cookies, nonces, signatures or tokens.

## GitHub attribution

The issue body holds the environment, a short installation reference and a short hash of the Reporter subject. It never holds a display name, username, email or WordPress user ID. A Developer who needs to know who reported a request asks an Operator. The Operator asks the Client, who can map the hash back to a user on their own site.

## Identity matching

WordPress privacy tools identify a person by email address, while the service identifies a Reporter by a subject that belongs to one site. The email address never leaves WordPress:

1. The exporter or eraser receives an email address and finds the user with `get_user_by( 'email', … )` on the **current** site.
2. It reads that user's Reporter subject for the current site. If there is none, it reports "no data" without calling the service.
3. It sends a signed request with the current installation's key. The Worker resolves the Slot from the key and never from the request body, and it acts on `(slot, reporter_subject)` only.

This means a request made on one site can never export or erase another site's or Client's records, even when the same email address is registered on both. Staging and production sites are separate Slots, so each site admin runs its own request.

## Worker contract

These routes are signed like every other call from WordPress to the Worker ([API contract](support-api-contract.md)). The attested subject and the Slot of the verified key are their only scope.

| Route | Behaviour |
|---|---|
| `GET /v1/export?reporter_subject=&cursor=` | Pages through the subject's own requests in the Slot, including superseded ones. Each item has the request `id`, Summary, Description, `created_at`, Support status and Delivery outcome. It never includes repository or issue IDs, the digest, the Submission ID or installation IDs. Requests visible only through a Support manager scope are excluded. |
| `POST /v1/erasures` | Idempotent per `(slot, reporter_subject)` while an erasure is open. Returns `202` with an erasure `id` once the erasure is **recorded**: written to the suppression ledger first, then to the main D1. A failed write returns `503` and the erasure is not recorded in the main D1. The ledger may already hold it: the Reporter's requests are then not delivered, and a later restore would carry the erasure out. A retry records it. |
| `GET /v1/erasures/{id}` | State, counts (`purged`, `redacted`, `pending`), and a list of residual-copy kinds. It never includes text. |

An erasure also searches the Slot's mapped repository for App issues whose attribution carries the Reporter's `rs_…` reference, so issues whose rows retention or offboarding already purged are still found. In an offboarded Slot they are reported (`client_issue`) but not edited. A search that keeps failing or returns more than one page is reported as `reference_search`; search results lag, so finding nothing proves nothing.

The Operator CLI has `erase <slot> <actor> <reporter-reference>` for erasures the Client asks for outside WordPress, where the reference is the `rs_…` hash on the issue, and `erasure-close <id> <actor>` once an Operator has reviewed the residual copies. Both are audited. A closed erasure forgets its reference. All of this is implemented ([#46](https://github.com/Quick-Release/gq-support/issues/46)), together with the WordPress exporter, eraser, deleted-user hook and privacy-guide text. The Support setup page lists each erasure with its last known state; its **Refresh erasure status** button asks the service, and a closed erasure leaves the list unless a remote outcome is still unresolved (`remote_outcome`), which keeps it listed as incomplete until the service forgets the erasure (45 days after the close, once only excepted records remain). Rendering the page makes no service call.

### Erasure states

`recorded` → `in_progress` → `completed` or `needs_review` → `closed`

- **completed**: every request was purged or redacted, and no residual copy is known beyond the standard notice about notification emails.
- **needs_review**: something needs a person. For example, the issue was retitled by a Developer, the issue has comments, redaction failed repeatedly, or the repository is suspended.
- **closed**: set only by an Operator, after reviewing the residual copies. Closing never completes an erasure: while a remote outcome is unresolved, or was released by an exception, the status keeps `remote_outcome` and WordPress reports the erasure as incomplete.

### What happens to each request

| Create intent state | Action |
|---|---|
| `pending`, `failed` | Cancel the intent so it never POSTs, then purge the row |
| `in_flight`, `outcome_unknown` | Suppress new creates, drain active execution, then purge service-held text. Keep only restricted reconciliation/redaction metadata. A discovered issue is redacted; an empty scan never completes erasure. Unresolved remote outcome remains `needs_review` |
| `delivered` | Redact the issue, then purge the row |
| Tracking `lost` (issue deleted or transferred away) | Purge, and record a residual-copy note if the issue was transferred |

**Redaction** is a `PATCH` to the issue by the App:

- **Body:** keep the first-line marker and the attribution. Replace the fenced Reporter text with `Support request text erased at the Reporter's request.`
- **Title:** if it still equals the title the App derived at acceptance, replace it with `Support request (erased)`. If a Developer changed it, leave it and mark `needs_review` (`retitled`).
- **Comments:** never edited. If the issue has any comments, mark `needs_review` (`comments`), because a Developer may have quoted the text.

GitHub keeps the previous body in the issue's **edit history**. Anyone with write access can delete a revision, but the App cannot, so every redacted issue adds a `edit_history` residual copy for an Operator to delete by hand.

## Sequence: WordPress eraser

```mermaid
sequenceDiagram
  participant A as Site admin
  participant WP as WordPress eraser
  participant W as Worker
  participant L as Suppression ledger
  participant GH as GitHub
  A->>WP: Erase personal data (email confirmed)
  WP->>WP: email → user → subject for this site
  WP->>W: POST /v1/erasures (signed, subject)
  W->>L: append tombstone intent
  W-->>WP: 202 erasure id
  WP->>WP: store erasure id on the setup page
  W->>GH: PATCH issue (redact) per delivered request
  W->>W: purge rows, append tombstones
  WP->>W: GET /v1/erasures/{id} (brief poll)
  W-->>WP: in_progress / completed / needs_review
  WP-->>A: items_removed, items_retained, messages
```

The eraser callback **never** returns `items_retained: false` while a remote step is outstanding or a residual copy is known. If the erasure has not finished within the brief poll, the callback returns `done: true`, `items_retained: true` and a message saying erasure is continuing. A closed erasure reports nothing retained only when no residual copy is known. The Support setup page lists each erasure and its state until an Operator closes it, and keeps a closed one with an unresolved remote outcome. If the Worker is unreachable, the callback returns an error and the admin retries. A failed `POST` has not recorded the erasure in the main D1, though the ledger may hold it, so a retry is safe.

## Sequence: export

```mermaid
sequenceDiagram
  participant A as Site admin
  participant WP as WordPress exporter
  participant W as Worker
  A->>WP: Export personal data (page n)
  WP->>WP: email → user → subject for this site
  WP->>W: GET /v1/export?cursor=… (signed)
  W-->>WP: items, next cursor
  WP-->>A: data, done = (no next cursor)
```

The WordPress page number maps to the Worker cursor, which is stored in a short-lived transient keyed by the request. A Worker failure returns an error for that page, and WordPress lets the admin retry it.

## Deleted WordPress users

The Reporter subject is stored in user meta, so it disappears when the user is deleted. On `delete_user` (and `wpmu_delete_user` on multisite), the plugin reads the subject **before** deletion and sends a best-effort signed `POST /v1/erasures`. If that fails, it is queued for one retry in the plugin lifecycle. After that, the records still fall under the 12-month retention. No email-derived lookup is kept. Removing a user from one site of a multisite network does **not** trigger erasure, because the user may be re-added. Never-confirmed-delivered reports have the separate 12-month-from-acceptance text limit defined above.

## Offboarding, disconnect and uninstall

| Event | Local effect | Service effect |
|---|---|---|
| Reporter erasure | None beyond the eraser's record | That subject's rows in that Slot are purged, and their issues redacted |
| Disconnect (site admin) | Keys deleted | Best-effort key revocation. Records stay under retention |
| Deactivate | None | None |
| Uninstall | Local state, key and capability grants deleted. No remote call | None. Records stay under retention |
| **Offboarding** (`offboard <slot>`, then `revoke <slot>`, by an Operator) | n/a | Key revoked. After a **30-day grace period**, all of the Slot's `support_request` and `delivery_intent` rows are hard-purged, with a Slot tombstone in the ledger. Keys and revocation rows are kept. GitHub issues are never touched: they belong to the Client's repository |

None of these touches another Slot's records, the Project repository itself, or the shared Cloudflare resources.

## Preventing resurrection

- **Restore:** before serving traffic after a restore, the Worker replays the suppression ledger (ADR 0016). Each tombstone purges the matching rows again, and redaction runs again for any issue listed.
- **Webhooks and sweeps** fetch GitHub and overwrite status only. When a lookup by `(repository_id, issue_id)` finds no row, the event is dropped. They never create a row.
- **Delivery:** an intent whose request `id` is in the ledger never POSTs.
- **Tombstones** hold the request `id`, `(repository_id, issue_id)`, the intent `id` and the erasure time. They hold no text and no subject. Resolved tombstones are compacted after **45 days**, beyond the 30-day Time Travel window. An unresolved remote erasure additionally keeps the pinned repository/installation and attempt time needed for reconciliation; its minimal record cannot be compacted merely because 45 days elapsed. Start the tombstone window after resolution. An Operator exception is recorded explicitly and does not make incomplete erasure complete.
- **Retention purges** add no suppression. A restore that brings back a request purged for age only brings back data the Client would have kept anyway, and the next purge run removes it again. Their cleanup records are mirrored like any other while they exist, so an uncertain create's `retention` review record survives a restore; a resolved one is compacted at once, leaving only its removal in the ledger.

### Uncertain-create cleanup amendment

The [delivery decision](support-delivery-design.md) rejects a negative marker scan as proof of non-creation. Erasure immediately prevents new creates. Once active attempts no longer need it, purge Summary, Description, derived title, context and unnecessary subject/Submission-ID/digest data. Keep a restricted record containing only opaque request/intent IDs, pinned provider mapping, attempt window, discovered issue IDs and suppression/erasure progress needed to find and redact a possible issue. Erasure stays incomplete while that outcome is unresolved, including after the 24-hour automatic reconciliation window. If a late-discovered issue cannot have its title safely compared because the original title/digest was already purged, redact the report body and require Operator review of the title; do not retain erased text to preserve that comparison.

Never-confirmed-delivered reports reaching 12 months from acceptance also lose their Submitted text. Uncertain cases retain only restricted remote-outcome review metadata, not report content. Offboarding still purges Slot content after its 30-day grace period and leaves Client GitHub issues untouched; it must suppress future creates and track already uncertain delivery. Do not use an empty scan, retention purge or tombstone expiry to claim successful remote erasure.

**Implemented** ([#46](https://github.com/Quick-Release/gq-support/issues/46), migrations `0012` and `0014`–`0018`, `worker/src/cleanup.ts`, `worker/src/ledger.ts`):

- Recording an erasure suppresses each request and blanks its Summary, Description, title, subject, Submission ID and digest in one batch; the running attempt keeps its own copy. `erased_at` hides the row from every Reporter projection. The only title-derived value kept is an HMAC keyed by the intent and by a key derived from the GitHub App key, which never enters D1, so automatic redaction can still replace a derived title; it is dropped when automatic cleanup ends. Each digest names its key, so after an App key rotation an older digest leaves the title for review rather than reporting it as retitled. An Operator `erase` holds no key, so the Worker's next pass purges that text and keeps the digest.
- The minute cleanup pass waits for each request's last authorized execution to drain, then moves the restricted fields onto a self-contained cleanup record and deletes the request rows. It purges known non-creations, redacts known issues and reconciles uncertain creates read-only on the delivery schedule, for 24 hours from capture. Every plausible marker match of an erased create (up to ten) is redacted, with a `multiple_matches` residual. After the window the record is `unresolved` (`needs_review`, residual `remote_outcome`) until `cleanup-reconcile` finds the issue or `cleanup-exception` releases its metadata; the exception never completes the erasure.
- The suppressions, erasures, cleanup records, offboardings, suspensions and runtime key revocations are mirrored into the separate suppression ledger D1; erasure, offboarding and a site's self-revocation write it first, and every create checks it before dispatch. Each pass mirrors only rows changed since the last one, and every row once a day. After `restore-recorded`, each Worker answers `503` and skips sweeps until it has replayed the ledger: restored rows under cleanup lose their text before any traffic, suspensions and key revocations return (never lifted) and every undelivered request becomes `outcome-unknown`.
- Resolved erasure tombstones and their request suppressions are compacted 45 days after resolution. A record with residual copies, or an excepted one, is resolved by `erasure-close`, so it goes 45 days after the close; an erasure goes 45 days after its close or, if never closed, after its reference search ended. Unresolved records are never compacted.
- Retention purges never-delivered rows 12 months from acceptance and closed delivered rows 12 months after the last observed close; uncertain ones keep a minimal `retention` review record. Offboarding suppresses the Slot at once and purges its content after 30 days without touching GitHub; uncertain ones keep a minimal `offboarding` review record.

By design, more than ten marker matches, or any suspicious one, still need an Operator: redaction never acts on an issue it cannot attribute.

## GitHub and provider limitations

| Limitation | Consequence |
|---|---|
| The App cannot delete issues | Redaction, never deletion (ADR 0018) |
| Edit history keeps earlier bodies; only a person with write access can delete a revision | A residual copy after every redaction; Operator review |
| Notification emails cannot be recalled | Listed as a standard residual copy in the privacy-guide text |
| Developers can quote Reporter text in comments or other issues | `needs_review` when the issue has comments; the Operator handles it with the Client |
| A Developer can retitle an issue | `needs_review` (`retitled`) |
| GitHub backups and logs | Outside our control. Disclosed |
| D1 Time Travel keeps 30 days of history | Guarded by the ledger |
| Workers execute outside the EU | Disclosed; ADR 0017 is not a location claim |

## Privacy-guide text (draft)

Registered with `wp_add_privacy_policy_content()` under the plugin's name. This is a suggestion for the site owner to adapt, not legal advice.

> **Support requests.** When you send a support request from this site's admin area, the summary and description you write are sent to our support provider, GETQUICK, which stores them on Cloudflare (database in the EU) and creates an issue in this project's private GitHub repository so that the development team can work on it. Your name, email address and username are not sent. The request is linked to you through a random identifier that is kept on this site. GitHub may email notifications of new issues to members of the development team.
>
> Support requests are kept by GETQUICK for 12 months after they are closed. The issue in GitHub stays part of this project's engineering history. If you ask this site to erase your personal data, your requests are deleted from GETQUICK's service and the text of your requests is removed from the GitHub issues. Copies that we cannot remove automatically, such as notification emails and earlier versions kept in GitHub's edit history, are reviewed and deleted by hand where possible.

## Human review points

These need legal or contractual review and are not engineering decisions:

- the Client agreement and data processing terms, with GETQUICK as processor;
- the sub-processor list (Cloudflare and GitHub) and how transfers to GitHub are described;
- the final privacy-guide wording for each Client deployment;
- how an Operator handles `needs_review` erasures together with the Client.

## Required tests

1. **Cross-tenant email confusion:** the same email on two sites, including two Slots of one Client and two Clients. Exporting or erasing on one site returns and removes only that Slot's subject records.
2. **Missing subject:** a user who never submitted gets "no data" without a service call.
3. **Erasure across delivery states:** `pending`, `failed`, `in_flight`, `outcome_unknown`, `delivered` and `lost` each end in the action shown in the table. A cancelled intent never POSTs.
4. **Redaction:** the marker and attribution are kept, the text is replaced, a derived title is replaced, a retitled issue is left and flagged, and an issue with comments is flagged.
5. **Honest completion:** the WordPress eraser never returns `items_retained: false` while the erasure is `in_progress` or `needs_review`, or when the Worker is unreachable.
6. **Replay and restore after erasure:** restoring D1 to before an erasure, then replaying the ledger, removes the rows again and keeps the intent from POSTing. Webhook and sweep events for an erased issue create nothing.
7. **Deleted user:** `delete_user` sends the erasure with the subject read before deletion. Removing a user from a site sends nothing.
8. **Offboarding:** the grace period is honoured, only that Slot is purged, and a staging Slot sharing the repository is untouched.
9. **Logs contain no secrets or content:** log fixtures from accept, deliver, erasure and export paths contain no text, subject, subject hash, Submission ID, nonce, signature or token.
10. **Retention purge:** closed requests over 12 months are purged; an open or reopened request is not.
