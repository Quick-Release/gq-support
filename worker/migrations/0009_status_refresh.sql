-- A generation survives clearing due_at, so even same-millisecond wake-ups
-- cannot be cleared by an older fetch. Owner fences retried/cancelled reads.
ALTER TABLE support_request ADD COLUMN status_refresh_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_request ADD COLUMN status_refresh_owner TEXT;
ALTER TABLE support_request ADD COLUMN status_refresh_next_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_request ADD COLUMN status_refresh_attempted_at INTEGER;
CREATE INDEX support_request_refresh_due ON support_request (status_refresh_next_at, status_refresh_attempted_at)
  WHERE status_refresh_due_at IS NOT NULL AND tracking = 'active';
CREATE INDEX support_request_daily ON support_request (id)
  WHERE status = 'open' AND tracking = 'active' AND issue_id IS NOT NULL;
CREATE TABLE status_refresh_pass (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at INTEGER,
  cursor TEXT NOT NULL DEFAULT '',
  completed_at INTEGER
);
INSERT INTO status_refresh_pass (id) VALUES (1);
