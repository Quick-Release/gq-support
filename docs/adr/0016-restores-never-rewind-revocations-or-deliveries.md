---
status: accepted
---

# Restores never rewind revocations, erasures or deliveries

A D1 Time Travel restore overwrites the whole shared database, so on its own it would revive revoked keys and erased data, and move delivered requests back to pending, where the sweep would post them again as duplicates. After any restore, therefore, every Support request that is not `delivered` becomes `outcome-unknown` and is reconciled by its marker before any retry. Revocations are also written to an append-only log outside D1, which is git-tracked, appended by the operator CLI and replayed on deploy. Erasures happen at runtime, triggered by WordPress sites, so they go to a separate append-only suppression ledger D1 that is never restored together with the main database. Both are re-applied before the Worker serves traffic again. A restore epoch held outside D1 tells the Worker that a restore happened. We chose this over forbidding restores or rebuilding only from GitHub. A rebuild from GitHub would lose accepted requests that were never delivered, and forbidding restores removes the only recovery path for a corrupting migration or bug.
