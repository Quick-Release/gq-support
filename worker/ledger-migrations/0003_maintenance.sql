-- The maintenance boundary (#146; ADR 0016). Held here, outside the main D1
-- a restore rewinds, so a restored database cannot reopen service. Every
-- Worker request and scheduled tick reads it; nothing serves or dispatches
-- while it says maintenance. The generation changes on every transition, so
-- an execution that began under another one cannot authorize a create.
CREATE TABLE maintenance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'serving' CHECK (state IN ('serving', 'maintenance')),
  reason TEXT CHECK (reason IN ('restore', 'incident')),
  began_at INTEGER,
  -- The restore epoch when it began: a restore maintenance ends only after a later restore is recorded.
  began_epoch INTEGER,
  ended_at INTEGER
);
INSERT INTO maintenance (id) VALUES (1);
-- Write-ahead audit of every attempted transition, by opaque actor and evidence reference.
CREATE TABLE maintenance_audit (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('begin', 'end')),
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
-- Independent checker outage episodes the service acknowledged (#139), so a
-- restore of the main D1 cannot drop evidence the checker no longer holds.
-- Metadata only: component, bounded code and times. Kept 45 days after the
-- last report, beyond the 30-day Time Travel window.
CREATE TABLE retained_episode (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  code TEXT NOT NULL,
  first_failed_at INTEGER NOT NULL,
  last_failed_at INTEGER NOT NULL,
  recovered_at INTEGER,
  received_at INTEGER NOT NULL
);
-- Withdrawn release versions (#144), recorded before the main D1 withdrawal,
-- so a restore cannot make a withdrawn package current again unnoticed.
CREATE TABLE release_withdrawal (
  package_version TEXT PRIMARY KEY,
  release_sequence INTEGER NOT NULL,
  withdrawn_by TEXT NOT NULL,
  withdrawn_at INTEGER NOT NULL
);
