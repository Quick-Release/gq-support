-- Fleet rollout and compatible recovery (src/fleet-rollout.ts, #144). Every table
-- but slot_installed_files is append-only: each row is its own audit record,
-- written in one statement by the Operator CLI, and never updated. No
-- report content, Reporter IDs, hosts or secrets: only versions, digests, run
-- IDs and bounded codes.

-- A candidate's release gates, verified from GitHub's own workflow run records at
-- the release commit (src/release-gates.ts): one row only once every gate passed.
CREATE TABLE release_verification (
  package_version TEXT PRIMARY KEY REFERENCES release_candidate (package_version),
  package_sha256 TEXT NOT NULL,
  -- The SHA-256 of the package's sorted file list and file digests, from its verified bytes.
  files_sha256 TEXT NOT NULL,
  -- Structured JSON: each gate's run ID, workflow, commit and passing jobs.
  evidence TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);

-- The launch of an approved release to the whole eligible fleet, written before
-- its release_dispatch row: the live schema and deployment evidence it was
-- launched against, and the Slots it targeted.
CREATE TABLE fleet_launch (
  sequence INTEGER PRIMARY KEY REFERENCES release_approval (sequence),
  live_schema INTEGER NOT NULL,
  -- Structured JSON: the deployed Worker's plan and apply records and the target Slots.
  evidence TEXT NOT NULL,
  launched_by TEXT NOT NULL,
  launched_at INTEGER NOT NULL
);

-- What each native installation last signed about its installed files
-- (gq-support-update-v2): an observation, never authority. One row per Slot,
-- like slot_signed_version. Verification compares it with the release's files.
CREATE TABLE slot_installed_files (
  slot TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  files_sha256 TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

-- Live migration state as an Operator command read it: `ok` only when every
-- applied migration is a reviewed one with its reviewed checksum.
CREATE TABLE schema_observation (
  observed_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ok', 'unreviewed', 'mismatch', 'unreadable')),
  live_schema INTEGER,
  reason TEXT,
  observed_by TEXT NOT NULL
);

-- A recorded rollback boundary: once the fleet verified this release, packages
-- whose schema range ends below schema_floor are no longer recovery candidates,
-- and destructive migrations at or above it may be applied.
CREATE TABLE rollback_boundary (
  sequence INTEGER PRIMARY KEY REFERENCES release_approval (sequence),
  schema_floor INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
