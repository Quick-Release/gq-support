-- Erasure, offboarding and retention cleanup under unknown outcomes (#46).
-- Purged rows keep only restricted metadata: opaque IDs, the pinned provider
-- mapping on the intent, the attempt window and discovered issue identity.
-- Set when Submitted text, subject, Submission ID and digest were purged.
-- Reporter projections never return such a row.
ALTER TABLE support_request ADD COLUMN erased_at INTEGER;
-- Delivered retention runs from the last observed close.
CREATE INDEX support_request_closed ON support_request (status_observed_at) WHERE status = 'closed';
CREATE TABLE erasure (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
-- One per purged request. Resolved erasure rows are the 45-day tombstone;
-- unresolved ones are kept, without text, until resolved or an audited
-- Operator exception. `title_digest` exists only for automatic retitling
-- and is dropped when automatic cleanup ends.
CREATE TABLE support_cleanup (
  request_id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('erasure', 'offboarding', 'retention')),
  erasure_id TEXT REFERENCES erasure (id),
  recorded_at INTEGER NOT NULL,
  title_digest TEXT,
  state TEXT NOT NULL CHECK (state IN ('draining', 'reconciling', 'redacting', 'unresolved', 'resolved', 'excepted')),
  outcome TEXT CHECK (outcome IN ('purged', 'redacted', 'lost', 'found')),
  residual TEXT NOT NULL DEFAULT '',
  owner TEXT,
  next_attempt_at INTEGER,
  window_started_at INTEGER,
  window_until INTEGER,
  reconciliation_count INTEGER NOT NULL DEFAULT 0,
  reconciliation_json TEXT,
  last_error_class TEXT,
  resolved_at INTEGER
);
CREATE INDEX support_cleanup_due ON support_cleanup (next_attempt_at)
  WHERE state IN ('draining', 'reconciling', 'redacting');
CREATE INDEX support_cleanup_erasure ON support_cleanup (erasure_id);
CREATE INDEX support_cleanup_resolved ON support_cleanup (resolved_at)
  WHERE state IN ('resolved', 'excepted');
-- Content purge begins `purge_after` the Slot was offboarded.
CREATE TABLE offboarding (
  slot TEXT PRIMARY KEY,
  recorded_at INTEGER NOT NULL,
  purge_after INTEGER NOT NULL
);
CREATE TABLE cleanup_audit (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('erase', 'exception', 'reconcile', 'offboard')),
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
