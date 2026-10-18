-- Signed erasure requests and the reporter-reference search (#46).
-- The issue's `rs_` reference, kept only while the erasure is open: it makes
-- a repeated request idempotent and finds issues whose rows are gone.
ALTER TABLE erasure ADD COLUMN reporter_reference TEXT;
ALTER TABLE erasure ADD COLUMN closed_at INTEGER;
ALTER TABLE erasure ADD COLUMN search_state TEXT NOT NULL DEFAULT 'done'
  CHECK (search_state IN ('pending', 'done', 'incomplete', 'failed'));
ALTER TABLE erasure ADD COLUMN search_next_at INTEGER;
CREATE UNIQUE INDEX erasure_open ON erasure (slot, reporter_reference)
  WHERE closed_at IS NULL AND reporter_reference IS NOT NULL;
CREATE INDEX erasure_search ON erasure (search_next_at) WHERE search_state = 'pending';
-- Expand the audit action constraint without rewriting its history.
CREATE TABLE cleanup_audit_v2 (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('erase', 'exception', 'reconcile', 'offboard', 'close')),
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
INSERT INTO cleanup_audit_v2 SELECT * FROM cleanup_audit;
DROP TABLE cleanup_audit;
ALTER TABLE cleanup_audit_v2 RENAME TO cleanup_audit;
