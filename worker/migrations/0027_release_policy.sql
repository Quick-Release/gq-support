-- Plugin release policy (src/release-policy.ts, ADR 0021). Every table is
-- append-only: each row is its own audit record, written in one statement by
-- the Operator CLI and never updated. No report content, Reporter IDs or secrets.

-- A published package recorded from its verified release artifacts. A candidate
-- is not approved merely by being recorded here.
CREATE TABLE release_candidate (
  package_version TEXT PRIMARY KEY,
  package_sha256 TEXT NOT NULL,
  -- The release workflow run and source commit that built and verified the bytes.
  provenance TEXT NOT NULL,
  worker_commit TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  schema_from INTEGER NOT NULL,
  schema_to INTEGER NOT NULL,
  -- 1 when the package signs its version (gq-support-v2); 0 for a legacy package that cannot.
  signs_version INTEGER NOT NULL CHECK (signs_version IN (0, 1)),
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

-- Explicit approvals, in order: the highest sequence is the approved production
-- release, and its previous_sequence the previous approved one.
CREATE TABLE release_approval (
  sequence INTEGER PRIMARY KEY,
  package_version TEXT NOT NULL REFERENCES release_candidate (package_version),
  kind TEXT NOT NULL CHECK (kind IN ('production', 'recovery')),
  previous_sequence INTEGER,
  evidence TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at INTEGER NOT NULL
);

-- The recorded fleet dispatch of an approval: once, from dispatch evidence, never
-- inferred. The previous approved release stays compatible until expires_at.
CREATE TABLE release_dispatch (
  sequence INTEGER PRIMARY KEY REFERENCES release_approval (sequence),
  dispatched_at INTEGER NOT NULL,
  compatibility_expires_at INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

-- The plugin version each Slot's installation last signed (gq-support-v2): an
-- inventory observation, never authority. One row per Slot.
CREATE TABLE slot_signed_version (
  slot TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);
