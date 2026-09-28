# Support storage design

Decision record for [issue #10](https://github.com/Quick-Release/gq-support/issues/10). It defines which operational state the service keeps in D1, what is authoritative and what is rebuildable, and the invariants the delivery (#11) and webhook (#12) work build on. [ADR 0013](adr/0013-shared-cloudflare-resources-per-stage.md) chose one shared D1 per stage, [ADR 0014](adr/0014-support-records-belong-to-the-slot.md) keys records by Slot, [ADR 0015](adr/0015-reporters-see-submitted-text-and-projected-status.md) decides what the Reporter list reads, and [ADR 0016](adr/0016-restores-never-rewind-revocations-or-deliveries.md) covers restores. Terms are defined in [CONTEXT.md](../CONTEXT.md). This is a design, not a claim that it is implemented.

## Decision

Use D1 for this state. There is no alternative store: KV and Durable Objects stay rejected (ADR 0013), and WordPress keeps no cache or copy of Support requests (API contract). Every query goes through `storageFor(slot)`. Mappings (Slot → Client, WordPress project, environment, repository ID, default Developer) are code, not rows.

## Out of scope

ADR 0009 removed client-visible comments and conversations, so the service stores no messages, comment IDs or message idempotency keys, and has no invalidation for message edits. Attachments belong to #15. There is no webhook inbox: deliveries are not stored.

## Facts this relies on

Checked against the Cloudflare D1 docs on 2026-09-28.

- **Transactions:** `batch()` is the only transaction. It is atomic and rolls back if any statement fails. There are no interactive transactions.
- **Read replication** is opt-in. Without the Sessions API, all queries run on the primary.
- **Time Travel** restores overwrite the whole database in place, with 30 days of retention on the Paid plan and no fork-to-copy.
- **TTL:** there is none. Purge jobs delete in batches of about 1,000 rows.
- **Billing** counts rows scanned, not rows returned.
- **Constraints:** foreign keys are enforced by default. Partial and unique indexes are documented.
- **Untested:** `ON CONFLICT` and `RETURNING` are not documented. A test must confirm them before code relies on them.

## Schema

All times are UTC epoch milliseconds. IDs are service-issued ULIDs with a type prefix.

### `support_request`: authoritative, except the status projection

| Column | Notes |
|---|---|
| `id` | `req_…`, the resource `id`. Never a GitHub number or URL |
| `slot` | Owner (ADR 0014) |
| `reporter_subject` | Attested Reporter subject |
| `submission_id` | Browser UUID |
| `body_digest` | SHA-256 of the canonical Summary and Description. A repeat with a different digest returns 409 |
| `summary`, `description`, `title` | Submitted text (ADR 0015). `title` is derived once, at acceptance |
| `created_at` | Acceptance time |
| `installation_id` | Audit only: which enrolled installation submitted the request |
| `supersedes_id`, `superseded_at` | Retry chain for a failed request |
| `repository_id` | Pinned at creation from the Slot's mapping. Never re-read from the current mapping |
| `issue_id`, `issue_number` | Set once delivered |
| `status`, `status_etag`, `status_observed_at` | **Projection.** `open`/`closed`, `NULL` until delivered |
| `tracking` | `active` or `lost`. `lost` means the issue was deleted or transferred out of the Client's repositories |

Constraints and indexes:

- `UNIQUE (slot, reporter_subject, submission_id)`: the idempotency key.
- `UNIQUE (repository_id, issue_id) WHERE issue_id IS NOT NULL`: one request per issue. This is how webhooks and sweeps find the row.
- `list_mine (slot, reporter_subject, created_at DESC, id DESC) WHERE superseded_at IS NULL`.
- `list_site (slot, created_at DESC, id DESC) WHERE superseded_at IS NULL`.
- `retention (created_at)`.

### `delivery_intent`: authoritative outbox

| Column | Notes |
|---|---|
| `id` | `int_…`, the opaque marker written on the issue's first line. It is not the resource `id` |
| `request_id` | FK to `support_request` |
| `kind`, `seq` | `create` only in the MVP. `seq` orders later intents (#28, ADR 0006). `UNIQUE (request_id, seq)` |
| `state` | `pending`, `in_flight`, `delivered`, `failed`, `outcome_unknown` |
| `attempts`, `first_attempt_at`, `lease_expires_at`, `next_attempt_at`, `last_error_class` | Delivery bookkeeping. The error is a class only, never a provider body |
| `context_json` | Server-side context from #14 that goes into the issue body. Set to `NULL` when the intent reaches a terminal state |

Index `due (next_attempt_at) WHERE state IN ('pending', 'outcome_unknown')` and `leases (lease_expires_at) WHERE state = 'in_flight'`.

The API `delivery` field comes from the create intent: `pending` and `in_flight` → `accepted-pending`, and every other state maps to the value of the same name.

### `repository_state`: rebuildable

`repository_id` PK, `suspended_reason` (`NULL`, `public`, `archived`, `no_access`), `observed_at`, `last_swept_at`. A Slot is suspended when its mapped repository is suspended. Production and staging Slots share a repository, so the row is keyed by repository.

### Credentials: authoritative (from #7 and #32)

- `enrollment_code`: `code_hash` PK, `slot`, `expires_at`, `consumed_at`, `consumed_public_key`.
- `installation_key`: `key_id` PK, `slot`, `installation_id`, `origin`, `public_key`, `enrolled_at`, `revoked_at`. `UNIQUE (slot) WHERE revoked_at IS NULL`, so a Slot has at most one active key.
- `replay`: `(key_id, request_id)` PK, `expires_at`. An insert that conflicts rejects the request. #32 sets the window.

## Data ownership

| Data | Source of truth | Sensitivity | Retention | Rebuildable |
|---|---|---|---|---|
| Submitted text, subject, Submission ID, digest | D1 (the Reporter's submission) | Client content, pseudonymous subject | 12 months after last close ([privacy design](support-privacy-design.md)); erasure goes through the suppression ledger (ADR 0016) | No |
| Repository and issue IDs | D1, set from the GitHub create response | Internal | With the request | Partly: marker reconciliation can find them again |
| Status, ETag, observed time, tracking | GitHub | Low | With the request | Yes: sweep |
| Delivery intent and bookkeeping | D1 | Internal | With the request | No |
| `context_json` | D1 until delivered, then GitHub | Diagnostics (#14) | Dropped at a terminal state | No |
| Repository suspension | GitHub | Internal | While mapped | Yes: write-time check |
| Enrollment codes | D1 | Hash of a secret | Purged 24 h after expiry | No |
| Keys and revocations | D1, with revocations also in the ADR 0016 log | Public keys | Kept | Revocations only |
| Replay rows | D1 | Low | Purged after the clock window | Not needed |

## Operations

**Accept** (one `batch()`): insert `support_request` and its create `delivery_intent` (`pending`). If `supersedes_id` is given, also set `superseded_at` on that request, but only where it has the same `slot` and `reporter_subject` and its create intent is `failed`. If the unique key conflicts, read the existing row: the same digest returns it with its current code, and a different digest returns 409. If the batch fails, the response is `503 gq_support_not_accepted`.

**List** (`scope=mine`):

```sql
SELECT … FROM support_request r JOIN delivery_intent i ON i.request_id = r.id AND i.seq = 0
WHERE r.slot = ?1 AND r.reporter_subject = ?2 AND r.superseded_at IS NULL
  AND (r.created_at, r.id) < (?3, ?4)
ORDER BY r.created_at DESC, r.id DESC LIMIT ?5
```

The query uses `list_mine` (an index search, not a scan), and rows read are about `per_page + 1`. `scope=site` drops the subject filter and uses `list_site`. The cursor is `(created_at, id)`, encoded as opaque text. It needs no signature, because the query applies the scope filters again every time, so a tampered cursor cannot leave the caller's scope.

**Read one:** look up by `id` and `slot`, then check the subject or a view-site grant. A miss and an out-of-scope row both return 404.

**Webhook or sweep:** find the row by `(repository_id, issue_id)`, GET the issue with `If-None-Match`, and overwrite `status`, `status_etag` and `status_observed_at`. The sweep lists `creator=<app>[bot]&state=all&since=<last_swept_at − skew>` for each repository.

- **301:** the row moves to the new repository and issue only if the new repository is mapped to the same Client.
- **410, or a transfer elsewhere:** set `status = closed` and `tracking = lost`, and alert the operator.

## Invariants for #11 and #12

1. Acceptance is the single `batch()` above. A Queue message, if #11 adds Queues, is only a wake-up and never the only record.
2. Before any POST, an attempt moves the intent from `pending` to `in_flight` with a conditional update (`WHERE state = 'pending'`), which acts as the lease. Only the process that wins the update may POST.
3. A lease that expires while `in_flight` becomes `outcome_unknown`. `outcome_unknown` is reconciled by its marker, never re-POSTed blindly.
4. Only one create per Slot is `in_flight` at a time (GitHub research).
5. Webhook handling is fetch-and-overwrite, so duplicate and out-of-order deliveries do no harm. Correctness never depends on a webhook arriving.
6. Sweeps and fetches use the repository pinned on the row, never the current mapping.
7. After a restore (ADR 0016), every intent that is not `delivered` becomes `outcome_unknown`, and the revocation and erasure log is replayed before the Worker serves traffic.

## Isolation

The Slot → Client relation lives in code, so D1 cannot enforce it with a foreign key. `storageFor(slot)` is the only query path. Acceptance checks that `repository_id` equals the Slot's mapping at that moment. A transfer that updates a row is accepted only within the same Client. Cross-Slot tests are mandatory (ADR 0013), and they include:

- the same Submission ID used from two Reporters and from two Slots;
- a production and a staging Slot that share one repository;
- a view-site grant that never crosses Slots.

## Consistency, migrations and restore

- **Reads are primary-only.** Read replication stays off; revisit only if the latency budget is missed, and then use `first-primary` sessions for every authorization and idempotency path. A new request is visible to the Reporter immediately, from the create response.
- **Migrations** are forward-only expand/contract steps in `worker/migrations/`, applied by Alchemy on deploy. A rollback means deploying the previous Worker against the expanded schema, never a down-migration.
- **Restores** follow ADR 0016.
