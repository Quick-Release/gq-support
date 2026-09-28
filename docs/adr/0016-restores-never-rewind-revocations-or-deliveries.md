---
status: accepted
---

# Restores never rewind revocations, erasures or deliveries

A D1 Time Travel restore overwrites the whole shared database, so on its own it would revive revoked keys and erased data, and move delivered requests back to pending, where the sweep would post them again as duplicates. After any restore, therefore, every Support request that is not `delivered` becomes `outcome-unknown` and is reconciled by its marker before any retry. Revocations and erasures are also written to an append-only log outside D1 (git-tracked, appended by the operator CLI and replayed on deploy), and that log is re-applied before the Worker serves traffic again. A restore epoch held outside D1 tells the Worker that a restore happened. We chose this over forbidding restores or rebuilding only from GitHub. A rebuild from GitHub would lose accepted requests that were never delivered, and forbidding restores removes the only recovery path for a corrupting migration or bug.
