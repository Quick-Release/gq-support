-- Suspended mappings (#39). A suspension is per repository, so it covers every
-- Slot mapped to it. The first cause is kept; only an Operator lifts it.
ALTER TABLE repository_state ADD COLUMN suspended_at INTEGER;
CREATE TABLE repository_audit (
  id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('unsuspend')),
  evidence TEXT NOT NULL,
  suspended_reason TEXT NOT NULL,
  suspended_at INTEGER,
  occurred_at INTEGER NOT NULL
);
