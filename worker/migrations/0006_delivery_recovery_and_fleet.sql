-- Shared conservative admission, separate from per-installation drain ownership.
CREATE TABLE delivery_fleet_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  next_mutation_at INTEGER NOT NULL
);
INSERT INTO delivery_fleet_budget VALUES (1, '', 0);
ALTER TABLE delivery_intent ADD COLUMN operator_reconcile_until INTEGER;
-- Expand the existing audit action constraint without rewriting its history.
CREATE TABLE delivery_audit_v2 (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('resume', 'reconcile')),
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
INSERT INTO delivery_audit_v2 SELECT * FROM delivery_audit;
DROP TABLE delivery_audit;
ALTER TABLE delivery_audit_v2 RENAME TO delivery_audit;
