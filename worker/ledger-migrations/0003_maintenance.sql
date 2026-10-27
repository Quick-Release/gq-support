-- Independent of SupportDB and never restored with it. No expiring leases:
-- a lost owner is an obstruction requiring investigation, not proof of drain.
CREATE TABLE maintenance_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('open', 'held', 'recorded', 'verified')),
  generation INTEGER NOT NULL DEFAULT 0
);
INSERT INTO maintenance_control (id, mode) VALUES (1, 'open');
CREATE TABLE maintenance_operation (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('runtime', 'provider', 'recovery')),
  generation INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  target TEXT
);
CREATE TABLE maintenance_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  generation INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL
);
