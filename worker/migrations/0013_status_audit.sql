-- Operator status recovery after missed webhooks (#57). Counts and times only:
-- no payload, delivery ID, issue text or Reporter content.
CREATE TABLE status_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  -- `reconcile` starts a full reconciliation sweep; `repair` confirms recovery.
  action TEXT NOT NULL CHECK (action IN ('reconcile', 'repair')),
  window_start INTEGER NOT NULL,
  window_end INTEGER,
  repositories INTEGER NOT NULL,
  due_refreshes INTEGER NOT NULL,
  -- JSON array of numeric repository IDs suspended when a repair was recorded.
  -- Recording them is the Operator's acknowledgement of those suspensions.
  suspended_repositories TEXT NOT NULL DEFAULT '[]',
  occurred_at INTEGER NOT NULL
);
