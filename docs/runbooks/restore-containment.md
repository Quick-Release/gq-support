# Exclusive restore containment

This procedure accompanies issue #20. It is **code and local synthetic proof**,
not authorization or live recovery evidence. No deployment or Time Travel drill
was run. Use the Tipme account `8f38791a8c37b182239af2a385ab3c31` and verified,
distinct stage IDs for SupportDB and SupportLedger. Never restore SupportLedger.
Preserve `worker/revocations.json` and its deployed enforcement too.

## Boundary and limits

`delivery_control.enabled=0` only stops dispatch. The independent ledger now
owns `maintenance_control` and durable `maintenance_operation` registrations.
An atomic conditional INSERT admits work only in `open` mode. Entering
containment changes that same database to `held`. An admitted request may still
finish; recovery cannot claim exclusivity until every registration is gone.
No registration expires. Warm isolates use fresh ledger access, never a cached
or stale-success verdict. Missing/unreachable ledger or unequal restore epochs
blocks normal work. This uses the existing two databases, with no new service.

The production adapter applies admission before installation/webhook processing,
Cron and its separately timed phases, immediate delivery and webhook refresh.
The CLI uses the same boundary, including ordinary resume, erase and enrollment.
No auth, capability or repository-mapping checks are bypassed. Work admitted
before containment may write until it finishes; **enter is not a drain receipt**.
A background wake-up denied during containment leaves the durable accepted work
for a later tick. No new acceptance receipt is returned for blocked ingress.

The gateway registers again just before each repository POST/PATCH (create,
status, redaction and additive repair), after the existing authorization check.
A racing containment denies dispatch conservatively. A registration authorized
before containment remains an obstruction until a complete synchronous response;
5xx, 408, 202, transport failure, local timeout or interruption leave it recorded.
Token minting is not an issue mutation. Registrations contain only random ID,
kind, generation, timestamp and numeric installation/repository/issue target plus
method, never credentials, submitted text, Reporter subject or request bodies.
Completed registrations are deleted; unresolved ones remain for investigation.

**Zero registrations is a local precondition, not a provider cancellation or
safe-to-restore certificate.** GitHub may finish a side effect beyond the local
timeout or permit window. Neither 60 seconds nor a negative marker scan proves
non-creation. Inspect original intent/cleanup records and provider evidence;
keep uncertain creates unknown and never re-create them based on an empty scan.
Existing ordinary reconciliation remains available when open. A late successful
response after local timeout does not automatically remove its obstruction.

There is deliberately no force-drain/lease-expiry/forget command. A lost runtime,
recovery owner or unresolved provider registration stops this procedure. Do not
delete its row merely because it is old. A follow-up, separately reviewed,
case-specific remediation must establish stopped local execution (including
outstanding D1 commands), remote settlement and recorded reconciliation before
removing an obstruction. If that cannot be established, **abort the restore**.
This costs availability; it does not invent a remote execution bound. In
particular, this PR does not establish automatic recovery from crashed owners.

## Preconditions and stop conditions

Use this only after a separately approved rollout of this exact recovery Worker
and ledger migration `0003`. All serving versions, old in-flight requests, Cron
and independent scripts must participate. Mixed old/new versions, an older CLI,
direct SQL writers and old version URLs can bypass the new protocol. Verify
retirement of old execution before a drill; deployment success alone is not
proof. Never roll back to code without this protocol during containment. Verify
restore-point schema compatibility with the recovery Worker before proceeding.

Every mutation below requires the actual scoped recovery approval, independent
Operator credentials, the named responder and a private evidence record. vvaz or
gmarques may handle incidents; no ordering, notification channel, contact or
approval result is implied. Every production rollout requires explicit human
approval. This document supplies none of those approvals.

Append all flags to each command, from `worker/`:

```text
--stage <staging|prod> --account-id 8f38791a8c37b182239af2a385ab3c31
--database-id <SupportDB ID> --ledger-database-id <SupportLedger ID>
```

1. Record immutable Worker revision, both migration checksum sets, previous
   compatible revision, restore point, IDs, revocation-log revision and approval
   reference. Verify the real independent ledger, current schema and primary-only
   bindings. Do not copy report text, tokens or raw provider payloads into evidence.
2. `pnpm operator maintenance-enter <opaque-actor>`. The response explicitly says
   **NOT safe to restore**. This closes ingress and future executions across warm
   isolates; admitted work may finish. No destructive restore yet.
3. `pnpm operator maintenance-status`. It reads only SupportLedger and reports
   mode, generation, epoch and outstanding registrations. Preserve sanitized
   evidence and inspect ongoing work through independent operational access.
   Recovery commands refuse any outstanding registration, regardless of age.
   Lost/uncertain execution is a stop condition, not permission to wait a fixed
   time and ignore it. Recheck only as part of the authorized human procedure.
4. After all ordinary work has positively completed and remote outcomes have
   been reconciled, `pnpm operator maintenance-mirror <opaque-actor>`. This claims
   exclusive recovery ownership and forces a full mirror **before the restore**.
   Verify suppressions, erasure/cleanup images, suspensions and runtime revocations
   against their current records, and preserve the Operator revocation file.
   If the current main database cannot be read safely or the mirror fails, stop.
   Never mirror the restored image over the newer ledger before replay.
5. Only after those preconditions, use the separately approved Cloudflare procedure
   to restore **SupportDB only**. Do not infer a safe restore from its old enabled
   bit or restore-state row. Ledger containment survives. No Time Travel command
   is provided here as authorization to execute it.
6. Immediately `pnpm operator restore-recorded <opaque-actor> time-travel-restore`.
   This requires exclusive containment and increments the independent epoch;
   normal Workers never replay automatically. An ambiguous CLI failure stops
   recovery; inspect epoch/audit and outstanding owner before deciding next steps.
7. `pnpm operator maintenance-replay <opaque-actor>`. It claims exclusive recovery,
   replays suppression/removal images, erasure purges, runtime revocations and
   suspensions; every undelivered intent becomes unknown. It then forces
   `delivery_control.enabled=0`, verifies equal epochs and marks `verified`.
   Success remains contained. Failure leaves the recovery owner recorded, with
   no automatic release or competing replay. Never age out that owner.
8. Under independent read-only operational access verify epoch, zero outstanding
   operations, restored text purges, key denial, suppressions, suspended mappings,
   pinned unknown intents/attempt windows and ledger integrity. Compare the
   Operator revocation file. Verify provider outcomes without resending creates.
   Record exact queries/counts and reviewer privately; do not expose erased text.
9. After explicit recovery approval, `pnpm operator maintenance-release
   <opaque-actor> <generation-from-maintenance-status>`. Release checks the current
   verified mode, generation, equal epochs and zero registrations. Requests may
   return again; **delivery remains disabled**. Do not treat this command as
   production rollout approval. A fresh containment changes the generation, so
   an old release command cannot reopen it.
10. With delivery disabled, allow the existing status/cleanup paths to recover;
    verify redaction/residual reporting and request visibility. Review unknown
    creates using the existing positive-evidence reconciliation contract. Only
    after separate approval enable delivery using the documented independent SQL
    procedure. Unknown creates still cannot resume as pending. Respect mapping
    suspensions and suppressed requests; no force-create/force-unsuspend shortcut.

During containment, HTTP privacy export/erasure and CLI erase cannot safely read
restored credentials or records, so they fail without a receipt. Keep Client
requests in the existing approved private process and retry after verified
release; do not claim an erasure completed. Already recorded ledger suppressions
survive. Existing cleanup/redaction resumes after release even while new dispatch
is disabled. Do not use privacy exceptions to clear maintenance obstructions.

If no restore occurred, do not simply release `held`: inspect and authorize the
abort recovery, then use exclusive replay/verification and explicit release.
Replay conservatively makes undelivered intents unknown even on this abort path.
If a restore occurred, never skip `restore-recorded`. If a restore's result is
uncertain, retain containment and investigate. Any unavailable ledger, unknown
schema, failed mirror/replay, unsettled remote write, old execution or unverifiable
revocation/suppression blocks release. No command advertises safe-to-restore.

## Local proof and the still-required live drill

The local workerd/D1 tests reproduce the former warm-cache and stale-fallback
failures; test concurrent admission versus containment, interrupted owners,
provider dispatch races, late responses/uncertain writes, denied ingress/Cron,
restored enabled state, exclusive failed replay and explicit generation-bound
release. Ledger restore tests cover erased text, revocations, suspension and
unknown intents with real local SQL. This is not live Time Travel evidence.

A future scoped **synthetic staging** drill must identify exact revision, both
IDs, synthetic Slot, restore point, responder, time window, independent access,
approval and abort procedure. Establish all old versions retired; prove an active
registered request blocks recovery, a later request returns 503 and no Cron or
background phase writes after exclusive drain. Full-mirror, restore main only,
record, replay, inspect revocation/erasure/suspension denial and unknown delivery,
release by exact generation, reconcile read-only, then explicitly approve enabling
delivery. Verify one provider issue and no revived private text. Test uncertainty
separately: timeout must block restore, never be bypassed to finish a drill.
No credential change, notification or destructive restore drill is authorized by
these local tests. #20 and #29 remain open.

Platform facts checked against current official documentation on 2026-10-27:
[D1 primary routing without Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/),
[D1 auto-commit and batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[SQLite-compatible SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/),
and [waitUntil lifetime](https://developers.cloudflare.com/workers/runtime-apis/context/).
The code uses primary bindings and single conditional statements, not a
transaction spanning databases or replicas. The installed Workers types
`5.20261015.1`, Miniflare `5.20260916.0-alpha`, Wrangler `4.133.0` and existing
Worker compatibility date `2026-10-17` were used; no platform timeout is treated
as proof that a remote operation stopped.
