-- The suppression ledger (ADR 0016): a separate D1 that is never restored
-- with the main one. It holds the current image of every suppression,
-- erasure, cleanup record, offboarding and repository suspension. A null
-- payload records a removal, kept 45 days. No report text is ever written.
CREATE TABLE ledger_entry (
  kind TEXT NOT NULL CHECK (kind IN ('suppression', 'erasure', 'cleanup', 'offboarding', 'suspension')),
  reference TEXT NOT NULL,
  payload TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (kind, reference)
);
CREATE INDEX ledger_entry_removed ON ledger_entry (recorded_at) WHERE payload IS NULL;
-- Bumped by the Operator after restoring the main D1. Outside the main D1,
-- so a restore cannot rewind it.
CREATE TABLE ledger_epoch (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, recorded_at INTEGER);
INSERT INTO ledger_epoch (id, epoch) VALUES (1, 0);
CREATE TABLE ledger_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('restore')),
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
