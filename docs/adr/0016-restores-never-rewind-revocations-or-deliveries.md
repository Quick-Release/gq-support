---
status: accepted
---

# Restores never rewind revocations, erasures, suspensions or deliveries

A D1 Time Travel restore overwrites the whole shared database, so on its own it would revive revoked keys and erased data, and move delivered requests back to pending, where the sweep would post them again as duplicates. After any restore, therefore, every Support request that is not `delivered` becomes `outcome-unknown` and is reconciled by its marker before any retry. Revocations are also written to an append-only log outside D1, which is git-tracked, appended by the operator CLI and replayed on deploy. Erasures happen at runtime, triggered by WordPress sites, so they go to a separate append-only suppression ledger D1 that is never restored together with the main database. Repository suspensions (a Suspended mapping, #39) are also written at runtime, by the Worker, so they go to the erasure ledger too, and so does each Operator lift. A restore can therefore bring back a suspension an Operator had already lifted, which is the safe direction, but it can never drop one: only an Operator lifts a suspension. The re-check before every create is not enough on its own, because a repository made private again would pass it. All of these are re-applied before the Worker serves traffic again. A restore epoch held outside D1 tells the Worker that a restore happened. We chose this over forbidding restores or rebuilding only from GitHub. A rebuild from GitHub would lose accepted requests that were never delivered, and forbidding restores removes the only recovery path for a corrupting migration or bug.

## Amendment: runtime key revocations (#46)

Not every revocation goes through the Operator CLI. Re-enrollment replaces a Slot's key, and a site can revoke its own key (`DELETE /v1/installation`), both at runtime, where the git-tracked log cannot be appended. These runtime revocations are mirrored into the suppression ledger as well, and replay re-applies them: it only ever sets `revoked_at`, never clears it, and a key enrolled after the restore point stays absent until it enrolls again. The write order differs by path, and each fails in the safe direction:

- A self-revocation writes the ledger first. If the main write then fails, the request fails and the site can retry; until it does, the key still works, and a later restore revokes it, which is what the site asked for.
- Re-enrollment and an Operator `revoke` write the main database first (the CLI after its git-tracked log), then the ledger. A lost ledger write leaves the key revoked in the main database, and the next cleanup pass's mirror records it. Only a restore within that minute could revive the key; the CLI's log still covers Operator revocations.
