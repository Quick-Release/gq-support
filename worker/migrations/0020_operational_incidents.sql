-- Operational incidents (#135; docs/support-operations-design.md). One open
-- incident per category and cause subject groups every observation of a shared
-- failure; its affected Slots are listed separately. Categories and resolution
-- codes are validated in src/incidents.ts, so a new category needs no rebuild.
-- No report content, Reporter identity, credential or URL is stored here.
CREATE TABLE incident (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  -- The opaque cause reference within the category, such as a repository ID. Never projected.
  subject TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  claimant TEXT,
  claimed_at INTEGER,
  claim_audit_id TEXT,
  resolution TEXT,
  resolved_at INTEGER,
  resolve_audit_id TEXT,
  CHECK ((claimant IS NULL) = (claimed_at IS NULL)),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL AND resolution IS NOT NULL AND claimant IS NOT NULL))
);
CREATE UNIQUE INDEX incident_open ON incident (category, subject) WHERE state = 'open';
CREATE INDEX incident_expiry ON incident (resolved_at) WHERE state = 'resolved';
CREATE TABLE incident_slot (
  incident_id TEXT NOT NULL REFERENCES incident (id),
  slot TEXT NOT NULL,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  PRIMARY KEY (incident_id, slot)
);
-- Who changed an incident, how and when. A claim or resolution names its audit row.
CREATE TABLE incident_audit (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incident (id),
  actor TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('service', 'api', 'operator')),
  action TEXT NOT NULL CHECK (action IN ('open', 'claim', 'resolve')),
  previous_state TEXT CHECK (previous_state IN ('open', 'claimed')),
  new_state TEXT NOT NULL CHECK (new_state IN ('open', 'claimed', 'resolved')),
  occurred_at INTEGER NOT NULL
);
CREATE INDEX incident_audit_incident ON incident_audit (incident_id);
