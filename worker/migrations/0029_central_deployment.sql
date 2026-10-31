-- Central deployment of approved releases (src/central-deployment.ts, #143). One
-- row per Operator-run application of an approved release to one centrally
-- managed Slot, written ahead of any change to the installation in a single
-- statement that also checks the release is still the approved, dispatched one
-- and the Slot is not offboarded or suppressed. Its outcome is written once.
-- No report content, Reporter IDs, hosts, commands or secrets: only versions,
-- digests and bounded outcome codes.
CREATE TABLE central_deployment (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  release_sequence INTEGER NOT NULL,
  package_version TEXT NOT NULL,
  package_sha256 TEXT NOT NULL,
  actor TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  -- NULL while the application runs, or if the Operator process ended before
  -- recording it: possibly applied, so it counts as attempted.
  outcome TEXT CHECK (outcome IN ('verified', 'failed', 'unknown', 'unreachable', 'refused')),
  -- The bounded reason for anything but `verified`.
  reason TEXT,
  -- The version read back from the installation, only when a read-back succeeded.
  observed_version TEXT,
  -- Whether WordPress was asked to install the package.
  installed INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER
);

CREATE INDEX central_deployment_slot ON central_deployment (slot, started_at);
