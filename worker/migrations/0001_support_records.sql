-- Support records, as designed in docs/support-storage-design.md.
-- Migrations are forward-only (expand/contract): never edit an applied file.
-- Times are UTC epoch milliseconds. No triggers: the test runner splits on ";".

CREATE TABLE support_request (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  reporter_subject TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  installation_id TEXT NOT NULL,
  supersedes_id TEXT REFERENCES support_request (id),
  superseded_at INTEGER,
  repository_id INTEGER NOT NULL,
  issue_id INTEGER,
  issue_number INTEGER,
  status TEXT CHECK (status IN ('open', 'closed')),
  status_etag TEXT,
  status_observed_at INTEGER,
  tracking TEXT NOT NULL DEFAULT 'active' CHECK (tracking IN ('active', 'lost')),
  UNIQUE (slot, reporter_subject, submission_id),
  UNIQUE (id, slot)
);

CREATE UNIQUE INDEX support_request_issue ON support_request (repository_id, issue_id)
  WHERE issue_id IS NOT NULL;

CREATE INDEX support_request_list_mine ON support_request (slot, reporter_subject, created_at DESC, id DESC)
  WHERE superseded_at IS NULL;

CREATE INDEX support_request_list_site ON support_request (slot, created_at DESC, id DESC)
  WHERE superseded_at IS NULL;

CREATE INDEX support_request_retention ON support_request (created_at);

-- `slot` repeats the request's Slot so storageFor can scope every statement;
-- the composite key keeps the two equal.
CREATE TABLE delivery_intent (
  id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create')),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'in_flight', 'delivered', 'failed', 'outcome_unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_class TEXT,
  context_json TEXT,
  UNIQUE (request_id, seq),
  FOREIGN KEY (request_id, slot) REFERENCES support_request (id, slot)
);

CREATE INDEX delivery_intent_due ON delivery_intent (next_attempt_at)
  WHERE state IN ('pending', 'outcome_unknown');

CREATE INDEX delivery_intent_leases ON delivery_intent (lease_expires_at)
  WHERE state = 'in_flight';

-- The tables below are not reached through storageFor: repository state is
-- per repository, and credentials are looked up before a Slot is known.
CREATE TABLE repository_state (
  repository_id INTEGER PRIMARY KEY,
  suspended_reason TEXT CHECK (suspended_reason IN ('public', 'archived', 'no_access')),
  observed_at INTEGER NOT NULL,
  last_swept_at INTEGER
);

CREATE TABLE enrollment_code (
  code_hash TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_public_key TEXT
);

CREATE TABLE installation_key (
  key_id TEXT PRIMARY KEY,
  slot TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  public_key TEXT NOT NULL,
  enrolled_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX installation_key_active ON installation_key (slot)
  WHERE revoked_at IS NULL;

CREATE TABLE replay (
  key_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, request_id)
);
