-- Forward-only delivery ownership and pinned provider inputs.
ALTER TABLE delivery_intent ADD COLUMN github_installation_id INTEGER;
ALTER TABLE delivery_intent ADD COLUMN environment TEXT;
ALTER TABLE delivery_intent ADD COLUMN client_origin_label TEXT;
ALTER TABLE delivery_intent ADD COLUMN default_developer TEXT;
ALTER TABLE delivery_intent ADD COLUMN owner TEXT;
ALTER TABLE delivery_intent ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delivery_intent ADD COLUMN attempt_started_at INTEGER;
ALTER TABLE delivery_intent ADD COLUMN drain_until INTEGER;
ALTER TABLE delivery_intent ADD COLUMN retry_deadline INTEGER;
ALTER TABLE delivery_intent ADD COLUMN unknown_since INTEGER;
ALTER TABLE delivery_intent ADD COLUMN reconciliation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delivery_intent ADD COLUMN reconciliation_json TEXT;
ALTER TABLE delivery_intent ADD COLUMN review_json TEXT;
ALTER TABLE delivery_intent ADD COLUMN repair_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_request ADD COLUMN issue_node_id TEXT;

-- Fail closed until independently enabled after the rollout/restore gate.
CREATE TABLE delivery_control (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0);
INSERT INTO delivery_control (id) VALUES (1);
CREATE TABLE delivery_suppression (
  scope TEXT NOT NULL CHECK (scope IN ('slot', 'request')),
  reference TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('erasure', 'offboarding', 'cancelled', 'restore')),
  PRIMARY KEY (scope, reference)
);
CREATE TABLE delivery_permit (
  installation_id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  drain_until INTEGER NOT NULL,
  next_mutation_at INTEGER NOT NULL
);
CREATE TABLE delivery_slot_schedule (slot TEXT PRIMARY KEY, last_served_at INTEGER NOT NULL);
CREATE TABLE delivery_attempt (
  intent_id TEXT NOT NULL REFERENCES delivery_intent (id),
  generation INTEGER NOT NULL,
  owner TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'reconcile', 'repair')),
  started_at INTEGER NOT NULL,
  drain_until INTEGER NOT NULL,
  outcome TEXT,
  PRIMARY KEY (intent_id, generation)
);
CREATE TABLE delivery_audit (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('resume')),
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
-- Pre-migration accepted work has no pinned App installation. Never infer it
-- from a changed mapping or automatically recreate restored work.
UPDATE delivery_intent SET state = 'outcome_unknown', unknown_since = 0,
  next_attempt_at = NULL, last_error_class = 'UnpinnedLegacyIntent'
  WHERE state IN ('pending', 'in_flight');
