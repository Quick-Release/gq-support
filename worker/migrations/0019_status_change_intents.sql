-- Reporter close and reopen (#28, ADR 0020). A status change is a delivery
-- intent after the create (`seq` > 0), idempotent per request and the
-- browser's `change_id`. SQLite cannot widen a CHECK in place, so the intent
-- and attempt tables are rebuilt. The attempts are set aside first, so no
-- foreign key ever points at a dropped table.
CREATE TABLE delivery_attempt_copy AS SELECT * FROM delivery_attempt;
DROP TABLE delivery_attempt;
CREATE TABLE delivery_intent_v2 (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'close', 'reopen')),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'in_flight', 'delivered', 'failed', 'outcome_unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_class TEXT,
  context_json TEXT,
  github_installation_id INTEGER,
  environment TEXT,
  client_origin_label TEXT,
  default_developer TEXT,
  owner TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  attempt_started_at INTEGER,
  drain_until INTEGER,
  retry_deadline INTEGER,
  unknown_since INTEGER,
  reconciliation_count INTEGER NOT NULL DEFAULT 0,
  reconciliation_json TEXT,
  review_json TEXT,
  repair_pending INTEGER NOT NULL DEFAULT 0,
  operator_reconcile_until INTEGER,
  -- The browser's key for one close or reopen; NULL for a create.
  change_id TEXT,
  CHECK ((kind = 'create') = (seq = 0 AND change_id IS NULL)),
  UNIQUE (request_id, seq),
  FOREIGN KEY (request_id, slot) REFERENCES support_request (id, slot)
);
INSERT INTO delivery_intent_v2 (id, slot, request_id, kind, seq, state, attempts, first_attempt_at, lease_expires_at,
  next_attempt_at, last_error_class, context_json, github_installation_id, environment, client_origin_label,
  default_developer, owner, generation, attempt_started_at, drain_until, retry_deadline, unknown_since,
  reconciliation_count, reconciliation_json, review_json, repair_pending, operator_reconcile_until)
  SELECT id, slot, request_id, kind, seq, state, attempts, first_attempt_at, lease_expires_at,
  next_attempt_at, last_error_class, context_json, github_installation_id, environment, client_origin_label,
  default_developer, owner, generation, attempt_started_at, drain_until, retry_deadline, unknown_since,
  reconciliation_count, reconciliation_json, review_json, repair_pending, operator_reconcile_until FROM delivery_intent;
DROP TABLE delivery_intent;
ALTER TABLE delivery_intent_v2 RENAME TO delivery_intent;
CREATE INDEX delivery_intent_due ON delivery_intent (next_attempt_at)
  WHERE state IN ('pending', 'outcome_unknown');
CREATE INDEX delivery_intent_leases ON delivery_intent (lease_expires_at)
  WHERE state = 'in_flight';
CREATE UNIQUE INDEX delivery_intent_change ON delivery_intent (request_id, change_id)
  WHERE change_id IS NOT NULL;
CREATE TABLE delivery_attempt (
  intent_id TEXT NOT NULL REFERENCES delivery_intent (id),
  generation INTEGER NOT NULL,
  owner TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'reconcile', 'repair', 'status')),
  started_at INTEGER NOT NULL,
  drain_until INTEGER NOT NULL,
  outcome TEXT,
  PRIMARY KEY (intent_id, generation)
);
INSERT INTO delivery_attempt (intent_id, generation, owner, operation, started_at, drain_until, outcome)
  SELECT intent_id, generation, owner, operation, started_at, drain_until, outcome FROM delivery_attempt_copy;
DROP TABLE delivery_attempt_copy;
-- The latest status change's `seq`, or 0 for none: the projection joins it
-- without a subquery, and acceptance moves it only from the value it read.
ALTER TABLE support_request ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
